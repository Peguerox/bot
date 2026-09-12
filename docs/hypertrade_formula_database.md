# SOL hypertrading formula database

Catalog of every DCA-martingale formula variant researched for the continuous-grid hypertrading
strategy (Worker 2), what's actually deployed, and why. Sources: independent formula research
(`hypertrade_variable_rate_formula_ORIGINAL.md`), our own re-verification against 1-min
Bitfinex/Binance Global/US data, and three follow-up rounds of uploaded research (zero-commission
reconciliation, a two-stage sizing candidate, and exact coefficients for the three previously-
missing formulas). Not all of this has been reproduced from scratch in this repo — see caveats.

All returns below are **zero-commission** (matches this account's real Bitfinex fee tier),
retaining an assumed 0.02%/side spread/slippage proxy, fully compounded, on SOL/USDT minute data
(Binance, 2021-08-08 → 2026-09-11 for the external studies).

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
| Zero-commission ROI, 30x reserve (1 level of cushion) | 245.95% |
| Zero-commission ROI, 31x reserve (~1.65 levels cushion) | 232.38% |
| Zero-commission ROI, 35x reserve (2 levels cushion) | 189.76% |
| Max drawdown | 22.18% (at 31x) |
| Sensitivity: failures under 48 joint ±1% coefficient perturbations | **0/48** |
| Sensitivity: failures under 57 different-start-date tests (19 dates × 3 execution conventions), reported for H35 | **0/57** |
| Sensitivity: our own independent check — 20 evenly-spaced start dates across the 5yr Binance Global set, single execution convention, reserves 25.35x/30x/31x/35x | **0/20 at every reserve level tested** |

**Why this is deployed over higher-return alternatives**: it's the only formula with a top-tier
return that has also demonstrated near-perfect robustness across two independent stress-test
axes (coefficient perturbation and start-date sensitivity) plus our own from-scratch check. Every
alternative with a meaningfully better headline ROI has a meaningfully worse failure rate.

## Reserve dial (original formula, tested)

More reserve = smaller first order per basket = lower ROI, but survives deeper before running out
of cash. Real, quantified tradeoff:

| Reserve | Survives through | Zero-commission ROI |
|---|---|---|
| 25.3517x base | level 9 exactly (bare historical max, no cushion) | 334.31% |
| 30x base | level 10 | 245.95% |
| 31x base | level 10 | 232.38% |
| **35x base** | **level 11** | **189.76%** |

**Currently deployed: 35x.** Originally set to 30x, then raised to 35x once research showed 30x
had not actually been confirmed against the 57-run start-date sensitivity test (only 31x and 35x
had) — 35x is the smallest reserve level with an explicit pass on both stress-test axes. See
`lib/sol-hypertrade-config.ts` for the live setting.

## Alternatives considered and rejected

| Variant | Zero-commission ROI | Max DD | Sensitivity | Verdict |
|---|---:|---:|---:|---|
| **Original (deployed)** | 232.38% (31x) / 189.76% (35x) | 22.18% | 0/48 coeff, 0/57 start-date | Kept |
| Aging-target (original sizing) | 206.97% (min-across-modes) | 22.65% | 0/48 coeff | Robust but lower ROI, no reason to switch |
| Earlier "254%" variant | 254.01% (H31, mode0) | — | 18/48 coeff | Better ROI, real fragility |
| Faster sizing + constant 1.5% target | 343.33% | 26.79% | 34/48 coeff | Highest ROI, too fragile |
| Faster sizing + level-dependent target | 299.50% | 25.63% | 42/48 coeff | High ROI, most fragile of the "faster" family |
| Two-stage sizing (round 4) | 269.90% (H28) / 239.03% (H30) | 21.29% / 19.87% | 29/57 start-date | Good ROI, fails ~half the time depending on start date |
| Adaptive 321% variant | Fails outright at zero-commission (2022-01-21 funding failure) | — | 21/48 coeff, and fails the nominal zero-commission run | Disqualified |

### Exact formulas for previously-missing variants

**Earlier "254%" variant** — same shape as original, larger multiplier, faster-shrinking TP:
```
x_i = x_{i-1} * (1 + 0.761001 / (1 + 1.19508*(i-2)))     # first mult 1.761001
d_i = same spacing as original
tau_L = max(0.0005, 0.019022125 / L^0.539209)             # gross target
```
H31, no indicators, no age dependence, no hard stop. 254.01% is the H31/mode0 zero-commission
figure specifically, not a min-across-modes number — not directly comparable to original's
232.38% (which is also H31 but reported as a minimum across three execution conventions).

**Adaptive 321% variant** ("sobol_208") — market-condition-responsive sizing/spacing/target,
using causal daily EWM(14)/EMA(20)/EMA(100) volatility and trend-deviation features (`V`, `D`)
computed from *prior completed UTC days only*, shifted by one day before use:
```
B = E_k / (31 * (1 + base_bear * D_entry))                       # base_bear = 0.746089
x_i = x_{i-1} * (1 + (m0-1) / (1 + size_damping*(i-2)))           # m0 = 1.724698, size_damping = 1.144202
g_{L+1} = clip(gap_cap, max(0.003, g0*(1+gap_slope*(L-1)) * V^gap_vol_exponent * (1+gap_bear*D)))
tau_L = max(0.0005, t0 * V^tp_vol_exponent / L^tp_level_exponent)
```
Full named coefficients: `g0=0.055188, t0=0.021478, gap_slope=0.034257, tp_level_exponent=0.396388,
gap_vol_exponent=-0.100928 (negative is intentional), tp_vol_exponent=0.816999, gap_bear=0.794231,
gap_cap=0.363278`. Only ever profitable at 0.1% commission (321.16%); **fails outright** (runs out
of cash, 2022-01-21 22:49 UTC) once commission is set to zero, which is this account's real fee
tier — disqualifies it regardless of any return figure. Not independently reproduced in this repo
(would require building the causal daily-feature pipeline from scratch).

**Aging-target formula** — original formula's sizing/spacing, but the TP target shrinks with
*time in the trade*, not just level count:
```
A = (current_ts - basket_entry_ts) / 1440 minutes->days      # resets only on full basket close
n(L, A) = 0.0005 + max(0, 0.025/L - 0.0005) * 2^(-A/90)       # NET target, 90-day half-life
P_exit = C * (1 + n(L,A)) / (Q * sigma)
```
A gentler sizing sub-variant exists (multiplier increment 0.66 / damping 1.2 instead of
0.66174/1.19508, first mult 1.66) at 183.03%/H31 and 158.22%/H34 — distinct catalog entries, not
rounding of the same run. Headline 188.85%/206.97% figures use the *original* sizing sub-variant.
0/48 coefficient-perturbation failures (same robustness class as the deployed original), but lower
ROI with no compensating advantage found so far.

**Two-stage sizing formula** (most recent round) — faster growth for the first 2 adds, then much
slower growth from level 4 onward:
```
x_2 = 1.5 * B
x_3 = 2.076923 * B
x_i = x_{i-1} * (1 + 0.1 / (1 + 0.5*(i-4)))   for i >= 4
d_i = same spacing as original
tau_L = max(0.0005, 0.02 / sqrt(L))
```
269.90% (H28, funds 11 levels) / 239.03% (H30, funds 12 levels) zero-commission — beats the
original on both ROI *and* nominal drawdown at a comparable reserve. Rejected anyway: restarting
the *exact same, unperturbed* formula from 19 different historical dates under 3 execution
conventions (57 total tests) produced 29/57 cash failures at H26/H28/H30, and 3/57 even at H35.
This is a different fragility axis than coefficient perturbation — the formula's coefficients
aren't wrong, but its behavior is highly sensitive to *when* you start running it.

## Open caveats (carried over from the source research, not resolved here)

- All of the above uses Binance SOL/USDT price history as a proxy — **not a measured historical
  Bitfinex spread**. The 0.02%/side assumption is a stand-in on both sides of this research, not
  a measurement. No source has actual historical Bitfinex bid/ask data yet.
- Binance US was deliberately excluded from every sizing/robustness decision (known liquidity
  problems, confirmed by our own independent test: 26 levels / $12,981 per $100 base needed vs 9
  levels / $2,535 on Bitfinex and Binance Global).
- All sensitivity counts (0/48, 18/48, 29/57, our own 0/20, etc.) are finite stress tests on
  2021-2026 SOL data, not a guarantee about future failure probability.
- The external research's "three execution conventions" (mode0 / chronological open-low-high-
  close / chronological open-high-low-close) are not reproduced in this repo's own engine, which
  uses a single conservative DCA-before-TP tie-break. Our own 0/20 start-date check is an
  independent sanity check, not a reproduction of their exact 57-run methodology.
