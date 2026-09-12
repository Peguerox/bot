# SOL hypertrading formula database

Catalog of every DCA-martingale formula variant researched for the continuous-grid hypertrading
strategy (Worker 2), what's actually deployed, and why. Source: independent formula research
(see `hypertrade_variable_rate_formula_ORIGINAL.md`), our own re-verification against 1-min
Bitfinex/Binance Global/US data, and a follow-up zero-commission + reserve-sensitivity study
(uploaded research, not reproduced from scratch in this repo — see caveats below).

All returns below are **zero-commission** (matches this account's real Bitfinex fee tier),
retaining an assumed 0.02%/side spread/slippage cost, fully compounded, on SOL/USDT minute data
(Binance, 2021-08-08 → 2026-09-11 for the external study; our own re-verification used a mix of
Bitfinex and Binance Global/US, see the original doc for exact windows).

## Deployed: the "Original" formula

**This is what's live in `lib/sol-hypertrade-config.ts` / `server/sol-hypertrade-paper.ts`.**

Purchase size (`x_1 = BASE`, `i >= 2`):
```
x_i = x_{i-1} * (1 + 0.66174 / (1 + 1.19508*(i-2)))
```
Multiplier: ~1.662 at level 2, decaying toward 1x as levels stack.

Drop gap (`i >= 2`):
```
d_i = min(0.50, 0.0803073 * (1 + 0.0263671*(i-2)))
```
~8.03% at level 2, widening slowly, capped at 50%.

Take-profit target (current level `i`, `i=1` = no DCA yet):
```
t_i = max(0.0005, 0.0152177 / i^0.539209)
```
~1.52% at level 1, shrinking toward a 0.05% floor as levels stack.

| Metric | Value |
|---|---|
| Max level ever reached (historical) | 9 (independently confirmed on Bitfinex 2yr + Binance Global 5yr; Binance US needed 26 — excluded from sizing decisions, known liquidity issues) |
| Zero-commission ROI, bare reserve (25.3517x, exact historical max, **zero cushion**) | 334.31% |
| Zero-commission ROI, 30x reserve (1 level of cushion beyond historical max) | 245.95% |
| Zero-commission ROI, 31x reserve (~1.65 levels cushion) | 232.38% |
| Zero-commission ROI, 35x reserve (2 levels cushion) | 189.76% |
| Max drawdown | 22.18% |
| Sensitivity: cash failures under 48 joint ±1% coefficient perturbations | **0/48** |

**Why this is deployed over higher-return alternatives**: it's the only formula tested that never
failed under small parameter perturbation. Every alternative with a better headline return was
dramatically more fragile to the formula's own coefficients being slightly off (see below) — a
real risk since these coefficients are fit to historical data, not derived from first principles.

## Reserve dial (original formula only, tested)

More reserve = smaller first order per basket = lower ROI, but survives deeper before running out
of cash. This is a real, quantified tradeoff, not free lunch either direction:

| Reserve | Survives through | ROI |
|---|---|---|
| 25.3517x base | level 9 exactly (bare historical max, no cushion) | 334.31% |
| 29.79x base | level 10 | ~246% (interpolated; 30x measured at 245.95%) |
| 30x base | level 10 | 245.95% |
| 34.48x base | level 11 | ~190% (interpolated; 35x measured at 189.76%) |
| 35x base | level 11 | 189.76% |

**Currently deployed: 30x** (one level of cushion beyond the observed historical worst case).
Picked as a middle ground — flag to revisit if you want more/less margin.

## Alternatives considered and rejected

| Variant | Zero-commission ROI | Max DD | Failures /48 | Verdict |
|---|---:|---:|---:|---|
| **Original (deployed)** | 232.38% (at 31x) / 334.31% (bare) | 22.18% | **0/48** | Kept |
| Faster sizing + constant 1.5% target | 343.33% | 26.79% | 34/48 | Rejected — fragile |
| Faster sizing + level-dependent target (`2.5%/√L`, 0.05% floor) | 299.50% | 25.63% | 42/48 | Rejected — fragile |
| Earlier variant ("254%") | 254.01% | 25.25% | 18/48 | Rejected — fragile |
| Adaptive market-condition formula | Ran out of cash entirely under zero-commission | — | 21/48 (and fails the nominal run outright) | Rejected — outright failed |
| Aging-target formula | 206.97% (was 188.85% under paid commission — now *underperforms* original) | 22.65% | 0/48 | Rejected — no longer beats original once fees are corrected |

**Faster sizing + constant target formula** (for reference, not deployed):
```
x_i = x_{i-1} * (1 + 0.8 / (1 + 1.19508*(i-2)))     # starts ~1.8x instead of ~1.66x
d_i = same as original
t = 0.015 constant (not level-dependent)
```
Even funded to the same safety depth as the original (43x base → survives level 11), it only
edges the original by +2.91 points (192.67% vs 189.76%) — a small edge that doesn't offset a
34/48 (or 42/48) sensitivity failure rate.

**Earlier variant, adaptive formula, and aging-target formula**: exact coefficient formulas not
fully specified in the source research provided to this repo — only summary stats above. If these
are needed in full, request the underlying `results.json`/`compare.py` from the same research
package referenced in the original upload.

## Open caveats (carried over from the source research, not resolved here)

- All of the above uses Binance SOL/USDT price history as a proxy — **not a measured historical
  Bitfinex spread**. The 0.02%/side assumption is a stand-in, same limitation our own backtests
  have had all along.
- Binance US was deliberately excluded from every sizing/robustness decision (known liquidity
  problems, confirmed by our own independent test: 26 levels / $12,981 per $100 base needed vs 9
  levels / $2,535 on Bitfinex and Binance Global).
- The 0/48 vs 34/48 sensitivity counts are finite stress tests on 2021-2026 SOL data, not a
  guarantee about future failure probability.
