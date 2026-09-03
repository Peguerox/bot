# Binance jump → other-venue follow research (2026-09-02)

## Hypothesis
When Binance's price makes a real move, does another exchange's price follow shortly after,
with enough delay (a few seconds) to be tradeable?

## Method
Collect simultaneous public trade-tick streams (local arrival timestamp) from Binance Global
(SOLUSDT) and one other venue, for 5-10 minutes at a time. For each Binance "jump" (cumulative
move over a trailing 2s window, above some % threshold), check whether the other venue's price
moved the same direction within 10 seconds after.

## Venue results (jump threshold 0.02%, ~2 independent windows combined per venue)
| Venue | Match rate | Notes |
|---|---|---|
| Bitfinex (tSOLUSD) | 20/27 (74.1%) | Real signal, live/liquid market |
| Bitstamp (solusd) | 11/15 (73.3%) | Real signal, live/liquid market |
| KuCoin (SOL-USDT) | 2/15 (13%) | Dead — price frozen for 4+ min straight, no real trading |
| Binance US (SOLUSDT) | 5/15 (33.3%) | Thin, long stale gaps, not usable |
| MEXC, Bitget | — | WS protocol didn't parse (MEXC likely protobuf-only) — untested |

Crypto.com, OKX, Bybit, Gate.io, Kraken all showed **zero lag** (move simultaneously with
Binance) in a broader 14-venue correlation sweep — not useful for this specific "delayed
follow" strategy, though could matter for other purposes.

## Threshold sweep (Bitfinex only, combined 10min + 5min datasets)
| Jump threshold | Match rate |
|---|---|
| 0.02% | 29/40 (72.5%) |
| 0.03% | 18/21 (85.7%) |
| 0.04% | 10/11 (90.9%) |
| 0.05% | 5/5 (100%) |
| 0.06% | 2/2 (100%) |

Bigger jumps are more reliable — match rate rises monotonically with threshold size. The
0.05%/0.06% rows are too small a sample to trust the exact number, but the trend across all
five thresholds is consistent and directionally real.

## What's built from this
`server/jump-trail-bitfinex.ts` — long-only (spot can't short without margin) paper bot,
threshold currently 0.02% (the original, most-tested setting — worth revisiting given the
threshold sweep above suggests a higher threshold may have a better hit rate at the cost of
fewer signals). Deployed on Render (Frankfurt region — Ohio/US-region Render deploys get
HTTP 451 blocked by Binance's global WS feed).

## Raw data
`research/lead-lag-data/*.json` — the exact tick collections behind these numbers, in case
you want to re-run the analysis with a different threshold, window, or venue combination later.
