// gta6-trophy-rarity-forecast-01 — trophy earn-rate forecaster.
//
// Reads every case file in $MAKEFUN_INPUT_DIR (else /input) and writes one
// forecast per case to $MAKEFUN_OUTPUT_DIR (else /output).
//
// Approach (my own, written from scratch for this entry):
//  * The house reads Exophase's trophy page on a fixed clock, but Exophase
//    only refreshes its counts every few hours, so consecutive reads are
//    usually identical. Collapse the history to distinct reads first, so a
//    page that sat unchanged for hours counts as one observation, not many.
//  * Fit, per trophy, a recency-weighted least-squares line of logit(rate)
//    against ln(1 + hours since release), with the slope shrunk toward the
//    tier median (trophies of one tier progress alike; single-trophy slopes
//    from a handful of distinct reads are noisy). This is the direct model.
//  * Fit a second, structural model on counts: log(players tracked) and
//    log(earners) = log(rate * players / 100), each against ln(1 + hours),
//    and take the rate as earners / players at the target. Earners only
//    grow; players only grow; their ratio is the rate, so dilution (a flood
//    of new tracked players who have earned little) is modelled, not assumed
//    away. Average the two models' median logits.
//  * Spread: a random-walk term growing with the horizon, the fit's residual
//    spread amplified by extrapolation leverage, and a refresh term — the
//    answer is the page as of its last refresh before the target, and a
//    refresh can move every rate at once, so the spread must cover that.
//  * Pending-first-refresh prior: if the history has never changed at all
//    (one distinct read) and the game is under three days old, the first
//    refresh is still ahead of us. Launch night's first refresh diluted
//    every rate as thousands of newly tracked players arrived (players
//    638 -> 3,868, trophies earned 943 -> 4,276, so the average rate fell
//    roughly four- to six-fold), so shift the median down ~1.5 logit and
//    widen the spread. Once refreshes have been seen, the fits above carry
//    the dilution and this prior switches off.
//  * Deterministic: pure arithmetic, no randomness, no network, stdlib only.

import * as fs from "node:fs";
import * as path from "node:path";

// Standard-normal quantiles at the case's levels [0.05, 0.25, 0.5, 0.75, 0.95].
const Z: number[] = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];

// --- small numeric helpers -------------------------------------------------

function clampRate(x: number): number {
  if (!Number.isFinite(x)) return 0.01;
  if (x < 0.01) return 0.01;
  if (x > 99.99) return 99.99;
  return x;
}

function logitPct(x: number): number {
  const p = clampRate(x) / 100;
  return Math.log(p / (1 - p));
}

function invLogitPct(l: number): number {
  // Guard against overflow for extreme logits.
  const c = Math.max(-30, Math.min(30, l));
  const p = 1 / (1 + Math.exp(-c));
  return clampRate(p * 100);
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

interface Fit {
  a: number; // intercept
  b: number; // slope
  xbar: number; // weighted mean of x
  sxx: number; // weighted sum of (x - xbar)^2
  resid: number; // weighted RMS residual
  n: number; // number of points
}

// Recency-weighted least squares of y on x. Weights decay with a 24h half-life
// from the latest point, so launch-night behaviour does not dominate day two.
function wls(xs: number[], ys: number[], ts: number[]): Fit {
  const n = xs.length;
  const tLast = Math.max(...ts);
  const w = ts.map((t) => Math.pow(0.5, (tLast - t) / (24 * 3600 * 1000)));
  let sw = 0;
  let xbar = 0;
  let ybar = 0;
  for (let i = 0; i < n; i++) {
    sw += w[i];
    xbar += w[i] * xs[i];
    ybar += w[i] * ys[i];
  }
  xbar /= sw;
  ybar /= sw;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - xbar;
    sxx += w[i] * dx * dx;
    sxy += w[i] * dx * (ys[i] - ybar);
  }
  const b = sxx > 1e-12 ? sxy / sxx : 0;
  const a = ybar - b * xbar;
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (a + b * xs[i]);
    rss += w[i] * r * r;
  }
  const resid = n >= 3 ? Math.sqrt(rss / sw) : 0;
  return { a, b, xbar, sxx, resid, n };
}

// --- case handling ---------------------------------------------------------

interface Trophy {
  id: number;
  name: string;
  tier: string;
}

interface DistinctRead {
  t: number; // ms since epoch of the read
  x: number; // ln(1 + hours since release)
  players: number;
  rates: (number | null)[];
}

function parseRelease(game: any): number {
  const d: string = String(game && game.release_date ? game.release_date : "2026-11-19");
  const iso = d.includes("T") ? d : d + "T00:00:00Z";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Date.parse("2026-11-19T00:00:00Z");
}

function forecastCase(c: any): any {
  const trophies: Trophy[] = c.trophies || [];
  const targetMs = Date.parse(c.target);
  const atMs = Date.parse(c.at);
  const horizonDays = Math.max(0, (targetMs - atMs) / (24 * 3600 * 1000));
  const releaseMs = parseRelease(c.game);
  const horizonHours = Math.max(0, (targetMs - releaseMs) / 3600000);
  const xTarget = Math.log(1 + horizonHours);

  const history: any[] = c.history || [];
  const lastRead: any = history.length > 0 ? history[history.length - 1] : null;
  const lastRates: (number | null)[] = lastRead ? lastRead.rates || [] : [];

  // Collapse to distinct reads: a read counts when players or any rate moved.
  const distinct: DistinctRead[] = [];
  let prevKey = "";
  for (const h of history) {
    const rates: (number | null)[] = h.rates || [];
    const key = String(h.players_tracked) + "|" + rates.map((r) => (r === null ? "n" : String(r))).join(",");
    if (key === prevKey) continue;
    prevKey = key;
    const t = Date.parse(h.at);
    const hours = Math.max(0, (t - releaseMs) / 3600000);
    distinct.push({ t, x: Math.log(1 + hours), players: h.players_tracked || 0, rates });
  }
  const nDistinct = distinct.length;
  const sawRefresh = nDistinct >= 2;

  const ts = distinct.map((d) => d.t);
  const xs = distinct.map((d) => d.x);

  // Players-tracked model: log players vs ln(1 + hours).
  let playersFit: Fit | null = null;
  if (nDistinct >= 2) {
    const ys = distinct.map((d) => Math.log(Math.max(1, d.players)));
    playersFit = wls(xs, ys, ts);
  }

  // Per-trophy direct fits (logit rate) and counts fits (log earners).
  interface TrophyFit {
    direct: Fit | null;
    earners: Fit | null;
    lastRate: number;
  }
  const fits: TrophyFit[] = trophies.map((tr, i) => {
    const px: number[] = [];
    const pyDirect: number[] = [];
    const pyEarn: number[] = [];
    const pt: number[] = [];
    for (const d of distinct) {
      const r = d.rates[i];
      if (r === null || r === undefined) continue;
      if (r <= 0 || r >= 100) continue;
      px.push(d.x);
      pyDirect.push(logitPct(r));
      pyEarn.push(Math.log(Math.max(1e-9, (r * d.players) / 100)));
      pt.push(d.t);
    }
    const lastRate = lastRates[i] === null || lastRates[i] === undefined ? NaN : lastRates[i];
    return {
      direct: px.length >= 2 ? wls(px, pyDirect, pt) : null,
      earners: px.length >= 2 ? wls(px, pyEarn, pt) : null,
      lastRate,
    };
  });

  // Tier-median slopes for shrinkage (direct and earners separately).
  const tierOf = (i: number): string => trophies[i].tier || "bronze";
  const tiers = [...new Set(trophies.map((t) => t.tier || "bronze"))];
  const tierDirectSlope = new Map<string, number>();
  const tierEarnSlope = new Map<string, number>();
  let globalDirectSlope = 0;
  let globalEarnSlope = 0;
  {
    const allD: number[] = [];
    const allE: number[] = [];
    for (const tier of tiers) {
      const ds: number[] = [];
      const es: number[] = [];
      trophies.forEach((_, i) => {
        if (tierOf(i) !== tier) return;
        if (fits[i].direct) ds.push(fits[i].direct!.b);
        if (fits[i].earners) es.push(fits[i].earners!.b);
      });
      if (ds.length > 0) tierDirectSlope.set(tier, median(ds));
      if (es.length > 0) tierEarnSlope.set(tier, median(es));
      allD.push(...ds);
      allE.push(...es);
    }
    globalDirectSlope = allD.length > 0 ? median(allD) : 0;
    globalEarnSlope = allE.length > 0 ? median(allE) : 0;
  }

  // Residual spreads, shrunk toward the global median residual.
  const globalResid = median(
    fits.map((f) => (f.direct ? f.direct.resid : 0)).filter((r) => r > 0),
  );
  const residFloor = 0.1;

  // Spread components.
  const sRw = 0.5 * Math.sqrt(horizonDays); // random-walk term, as the house baseline's
  const sRefresh = sawRefresh ? 0.3 * Math.sqrt(horizonDays) : 0.8; // refresh timing risk

  // Pending-first-refresh prior: history has never moved and the game is young.
  const hoursSinceReleaseAt = Math.max(0, (atMs - releaseMs) / 3600000);
  const pendingFirstRefresh = !sawRefresh && hoursSinceReleaseAt < 72;
  const pendingShift = pendingFirstRefresh ? -1.5 : 0; // logit shift (dilution)

  const SHRINK_K = 4; // pseudo-count for slope shrinkage toward the tier median

  const out: any[] = [];
  trophies.forEach((tr, i) => {
    const f = fits[i];
    const last = Number.isFinite(f.lastRate) ? (f.lastRate as number) : 50;

    // The 100% trophy: everybody holds it; a refresh cannot move it down.
    if (last >= 99.995) {
      out.push({ id: tr.id, q: [99.97, 99.985, 99.99, 99.99, 99.99] });
      return;
    }

    // Direct model median logit at the target.
    let logitDirect: number | null = null;
    let leverage = 0;
    let resid = globalResid || 0.15;
    if (f.direct) {
      const tierSlope = tierDirectSlope.has(tierOf(i))
        ? tierDirectSlope.get(tierOf(i))!
        : globalDirectSlope;
      const nEff = f.direct.n;
      const b = (nEff * f.direct.b + SHRINK_K * tierSlope) / (nEff + SHRINK_K);
      logitDirect = f.direct.a + b * xTarget;
      if (f.direct.sxx > 1e-12) {
        leverage = ((xTarget - f.direct.xbar) * (xTarget - f.direct.xbar)) / f.direct.sxx;
      }
      const r = f.direct.resid;
      resid = (nEff * r + SHRINK_K * (globalResid || 0.15)) / (nEff + SHRINK_K);
    }

    // Counts model median logit at the target.
    let logitCounts: number | null = null;
    if (f.earners && playersFit) {
      const tierSlope = tierEarnSlope.has(tierOf(i))
        ? tierEarnSlope.get(tierOf(i))!
        : globalEarnSlope;
      const nEff = f.earners.n;
      const bE = (nEff * f.earners.b + SHRINK_K * tierSlope) / (nEff + SHRINK_K);
      const logE = f.earners.a + bE * xTarget;
      const logP = playersFit.a + playersFit.b * xTarget;
      const rateHat = 100 * Math.exp(logE - logP);
      logitCounts = logitPct(rateHat);
    }

    let med: number;
    if (logitDirect !== null && logitCounts !== null) med = (logitDirect + logitCounts) / 2;
    else if (logitDirect !== null) med = logitDirect;
    else if (logitCounts !== null) med = logitCounts;
    else med = logitPct(last);

    // Pending first refresh: rates dilute as newly tracked players arrive.
    med += pendingShift;

    // Spread: random walk + fit residual (with extrapolation leverage) + refresh.
    const sFit = Math.max(residFloor, resid) * Math.sqrt(1 + leverage);
    let s = Math.sqrt(sRw * sRw + sFit * sFit + sRefresh * sRefresh);
    if (s < 0.35) s = 0.35;
    if (s > 2.2) s = 2.2;

    const q = Z.map((z) => {
      const v = invLogitPct(med + z * s);
      return Math.round(v * 10000) / 10000;
    });
    // Guarantee non-decreasing (rounding can tie, never invert, but be safe).
    for (let k = 1; k < q.length; k++) if (q[k] < q[k - 1]) q[k] = q[k - 1];
    out.push({ id: tr.id, q });
  });

  return { trophies: out };
}

function main(): void {
  const inDir = process.env.MAKEFUN_INPUT_DIR || "/input";
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  fs.mkdirSync(outDir, { recursive: true });
  const files = fs
    .readdirSync(inDir)
    .filter((f) => f.endsWith(".in"))
    .sort();
  for (const file of files) {
    const id = file.slice(0, -3);
    const c = JSON.parse(fs.readFileSync(path.join(inDir, file), "utf-8"));
    const forecast = forecastCase(c);
    const text = JSON.stringify(forecast);
    fs.writeFileSync(path.join(outDir, id + ".out"), text, "utf-8");
  }
}

main();
