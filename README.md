[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/mouns4117-ai/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/mouns4117-ai/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

# GTA VI trophy rarity forecast

A program that forecasts, for every Grand Theft Auto VI trophy on PlayStation 5,
its earn rate on Exophase at 2026-11-26T00:00:00Z — the percent of the players
Exophase tracks who will have earned it by the end of launch week — as five
quantiles (q05, q25, q50, q75, q95) per trophy. Scored by mean pinball loss on
the logit scale. Built for make.fun's `gta6-trophy-rarity-forecast-01` bounty.

## How it works

`main.ts` (Node 22, standard library only, no network) reads every case file
in `$MAKEFUN_INPUT_DIR` (default `/input`) and writes one forecast per case to
`$MAKEFUN_OUTPUT_DIR` (default `/output`).

- **Distinct reads only.** Exophase refreshes its counts every few hours, so
  consecutive house reads are usually identical. The history is collapsed to
  distinct reads first, so a page that sat unchanged for hours counts as one
  observation, not many.
- **Two models, averaged.** Per trophy, a recency-weighted least-squares fit
  of logit(rate) against `ln(1 + hours since release)`, with the slope shrunk
  toward the tier median; and a structural counts model — `log(players
  tracked)` and `log(earners)` fitted separately, rate = earners / players at
  the target — so dilution (a flood of newly tracked players who have earned
  little) is modelled, not assumed away.
- **Honest spread.** A random-walk term growing with the horizon, the fit's
  residual spread amplified by extrapolation leverage, and a refresh term:
  the answer is the page as of its last refresh before the target, and one
  refresh can move every rate at once.
- **Pending-first-refresh prior.** If the history has never changed at all and
  the game is under three days old, the first refresh is still ahead: launch
  night's first refresh diluted every rate as thousands of newly tracked
  players arrived (638 → 3,868 players, 943 → 4,276 trophies earned), so the
  median shifts down ~1.5 logit and the spread widens. Once refreshes have
  been seen, the fits above carry the dilution and this prior switches off.
- **Deterministic.** Pure arithmetic, no randomness; two runs on the same case
  write byte-identical forecasts. Runs in ~0.3 s per case, far inside the
  8-second cap.

## Run it

```sh
# practice cases (from the kit's input/)
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

This writes `out/p00.out` and `out/p01.out`, each
`{"trophies": [{"id": n, "q": [q05, q25, q50, q75, q95]}, ...]}`.

## Practice results (local scoring)

The practice answers are not published, so the forecasts were scored against
proxy answers reconstructed from the documented launch-night refresh
(3,868 players tracked, 4,276 trophies earned at 04:30Z). Mean pinball loss:

| forecast | pure dilution | pro-rata extra | top-5 extra |
| --- | --- | --- | --- |
| this program | 0.224 | 0.167 | 0.247 |
| house persistence baseline | 1.688 | 1.401 | 1.578 |

The baseline's documented practice loss is ~1.51, between the proxies above,
so the program beats it on the practice cases by roughly a point of pinball
loss, with ~98% 90%-coverage.

## License

MIT — see [LICENSE](LICENSE).

---

Built for make.fun — play along: https://make.fun/r/yj3dej2g
