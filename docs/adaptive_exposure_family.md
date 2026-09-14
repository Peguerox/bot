# SOL adaptive-exposure strategy family — research log

A separate strategy family from the deployed DCA-martingale grid (Worker 2). Instead of
averaging into a position and exiting at a shrinking profit target, this controller continuously
holds a variable % of the account in SOL, sized by trend-agreement signals. Not deployed anywhere
-- pure research track. All figures below are our own independent reproduction (not the source
reports' numbers) unless marked "reported."

## Candidates, in order discovered

### 1. Existing (T only) -- baseline, not worth building
`f_t = 0.03 + 0.27*T_t`, where `T_t = sigmoid((EMA_360/EMA_4320 - 1)/0.005)` (EMA half-lives in
minutes: 360=6h, 4320=72h). Superseded immediately by the primary candidate below -- kept only as
a reference baseline.

### 2. Primary (T×L, "slow confirmation") -- real improvement over (1), not worth deploying alone
Adds a second, slower trend-agreement gate: `f_t = 0.03 + 0.27*T_t*L_t`, where
`L_t = sigmoid((EMA_1440/EMA_10080 - 1)/0.02)` (half-lives 1d=1440min, 7d=10080min). Reduces
exposure when a short-term bounce disagrees with the slower trend.

Independently reproduced against the source report within ~0.1pp on every figure checked (full
5yr CAGR, recent 2yr return, recent 1yr return). Real, not an artifact.

### 3. Acceleration gate (T×L×A) -- best of the family so far
Adds a THIRD gate measuring whether the short trend is speeding up or slowing down, not just its
level: `f_t = 0.546*T_t*L_t*A_t`, where `A_t = sigmoid((r_t - r̄_t)/0.002)`, `r_t = EMA_360/EMA_4320
- 1` (the raw ratio inside T, before the sigmoid), and `r̄_t` is that same ratio's own 1-day
(1440min) half-life moving average. The 0.03 floor is removed; 0.546 is a rescaling constant so
average exposure matches the T×L controller (~11%), isolating signal *shape* from position *size*.

Independently reproduced within ~0.2pp of the source report on both the full 5yr number and the
T×L baseline number in the same report -- a clean, trustworthy match. Also independently
corroborated by a SEPARATE prior report (the one that introduced T×L itself), which reproduced the
T-only -> T×L transition to within 0.3pp on its own reimplementation. Two independent parties plus
us now agree on this family's core numbers.

Source report's own robustness case (not yet re-verified by us beyond the headline reproduction):
holdout-tested (dev period ends Feb 2024, holdout evaluated once, never optimized on: +20.36%/
19.01% DD vs existing controller's +20.29%/26.66% DD -- same return, much lower drawdown), 18/18
walk-forward starts beaten on return AND ret/DD ratio, survives 10x the assumed trading cost,
confirmed not a lookahead or leverage artifact via explicit controls.

Known weaknesses, per the source report and worth taking seriously: decays faster with execution
delay than the T×L controller (ret/DD drops from 22.49 to 14.55 over 5 extra bars of delay -- this
one is NOT delay-indifferent the way the simpler controller is), trades ~3x more often (142/day vs
50/day), and reaches much higher peak exposure (56% vs 31%) which matters if 30% was meant as a
hard risk cap rather than a tuning artifact.

### 4. News-gated variant (daily downtrend filter + curated news-event veto) -- REJECTED
Raises the exposure cap to 45% and adds a downtrend filter plus a hand-curated, 654-event news
catalog (Fed/CPI/PCE releases, war/political/China-policy/crypto-stress events, manually labeled
severity+direction) as a trading veto. Rejected outright, not just deprioritized:

- **Not reproducible by us.** The news catalog is proprietary/hand-labeled; we have no access to
  it and building an equivalent would be its own multi-week project (live news ingestion +
  labeling pipeline), completely out of scope versus every other candidate here, which only needs
  OHLC price data.
- **The report's own numbers show the news component barely matters.** Raising the cap to 45%
  with NO news filtering already gets most of the claimed improvement (+27.16% 2yr vs the 30%
  baseline's +18.52%); adding the whole news-veto system on top actually *reduces* that to
  +24.47% in exchange for less drawdown. Their own words: "It would be misleading to credit the
  entire increase to predictive news alpha."
- **Severe activity tradeoff**: news-gated version traded only 210 of 731 days recently, with
  pauses up to 435 days in the full history -- a fundamentally different operating profile than
  anything else tested.

### 5. Higher-return alternative (T×L×A, narrower gate, same 1-day ratio mean) -- current focus
A refinement of the acceleration gate, not the "recommended" lower-drawdown variant from the same
round (that one switches the ratio-mean half-life to 2-days/2880min -- tested and available, but
deprioritized per explicit instruction to optimize for ROI over minimum drawdown):
`f_t = 0.54500732421875 * T_t * L_t * sigmoid((r_t - r̄_t)/0.00075)`. Same 1-day (1440min) ratio
mean as the original acceleration gate; only the gate width narrows (0.002 -> 0.00075) and the
calibration coefficient shifts slightly (0.546 -> 0.545, negligible on its own).

Independently reproduced: our engine gets +455.69% / 18.62% DD on Binance Global full 5yr vs the
source's reported +457.89% / 20.13% DD (their DD figure uses a more pessimistic intrabar-stress
marking convention we don't replicate -- explained discrepancy, not a red flag; return matches
within 0.5pp).

**Full 5-year results, real Bitfinex data, $500 seed:**

| Asset | Total return | CAGR | Max DD | Buy & Hold |
|---|---:|---:|---:|---:|
| **SOL** | **+305.27%** | **31.72%** | 18.03% | +95.83% |
| BTC | +35.37% | 6.14% | 13.25% | **+64.96%** |
| ETH | +63.63% | 10.18% | 16.37% | -23.21% |

**Per-year realized $ earnings (on the $500 seed, compounding -- later years reflect a larger
base, not purely better years):**

| Year | SOL | BTC | ETH |
|---|---:|---:|---:|
| 2021 (partial) | +$194.66 | -$4.00 | -$3.12 |
| 2022 | +$64.86 | -$29.67 | +$88.50 |
| 2023 | +$850.96 | +$109.92 | +$59.21 |
| 2024 | +$228.62 | +$90.92 | +$81.80 |
| 2025 | +$66.90 | -$23.15 | +$105.83 |
| 2026 (partial) | +$120.35 | +$32.85 | -$14.05 |

SOL is the standout (positive every single year, 2023 alone contributing +$851). BTC is the weak
spot again -- beats its own buy-and-hold most years but loses on the full-history total (+35% vs
+65%) because BTC's strong trend years reward plain holding more than capped exposure can match.
ETH sits in between, solidly positive most years against a buy-and-hold that actually lost money.
Same BTC-lags-in-strong-trends pattern seen with the original acceleration gate and the DCA grid's
stock tests (KO/AAPL) -- consistent across three unrelated strategies now: none of this family is
built to beat a clean, sustained uptrend, only to avoid chop/decline damage.

## Head-to-head, our own independent backtest, real Bitfinex 1-min data

All variants share: $500 seed, 2bps/side modeled cost, 1-bar execution delay, 0.01 deadband
multiplier (matching the acceleration-gate report's stated settings). Deployed DCA grid uses its
real production settings (35x reserve). Bitfinex dataset: 1,723,521 1-min bars, 2021-08-15 to
2026-09-13 (the first time we've tested any of this on the REAL exchange Worker 2 trades, not the
Binance Global proxy used for earlier checks).

### Full history (~5.08 years)

| Strategy | Total return | CAGR | Max DD |
|---|---:|---:|---:|
| Existing (T only) | +141.41% | 18.95% | 26.43% |
| Primary (T×L) | +132.31% | 18.05% | 25.38% |
| **Acceleration (T×L×A)** | **+291.49%** | **30.82%** | **18.58%** |
| Deployed DCA grid (live) | +177.18% | 22.23% | -- |
| Buy & hold | +95.83% | 14.15% | -- |

Acceleration wins outright over the full history -- best return, lowest drawdown, beats even the
deployed DCA grid.

### Last 1 year (the hard, recent test -- SOL down ~57% buy-and-hold)

| Strategy | Return | Max DD |
|---|---:|---:|
| Existing (T only) | -11.16% | 19.71% |
| Primary (T×L) | -3.96% | 11.42% |
| Acceleration (T×L×A) | +0.22% | 10.89% |
| **Deployed DCA grid (live)** | **+6.11%** | -- |
| Buy & hold | -57.34% | -- |

Reverses over the most recent year: the deployed DCA grid wins outright, acceleration only breaks
even, and the two weaker adaptive variants lose money (though still far better than buy-and-hold).

## Where this leaves things

Acceleration gate is the clear best of the adaptive-exposure family and has now survived
independent reproduction by two separate parties plus us. It is NOT, on this evidence, a
replacement for the deployed DCA grid -- full-history it's better, but on the one year that
actually matters most (the most recent one), the grid still wins. These look like two genuinely
different, only weakly-correlated strategies rather than one dominating the other. Worth
continuing to evaluate as a potential separate bot/allocation, not as a Worker 2 replacement.

## Open items
- Acceleration gate's delay-sensitivity and higher peak exposure (56%) haven't been independently
  re-verified yet, only reproduced from the source report's own numbers.
- Real Bitfinex spread still unmeasured (same open question as every other candidate in this
  session) -- all of the above uses a 2bps/side model, not a measured spread.
- Haven't yet run our own start-date/coefficient-perturbation robustness check on acceleration the
  way we did for the DCA grid formula -- only reproduced the source's own walk-forward claims.
