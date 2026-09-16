# Surfer USDT — strategy spec

SOL/USDT trend-following rotation strategy. Holds either USDT or SOL, never both. This is our
best-performing bot — looking for ways to improve it.

## Indicators

- **RSI(14)** computed on **15-minute** candles (standard Wilder smoothing).
- **EMA(7)** and **EMA(25)**, both computed on **12-hour** candles, "live-adjusted": rather than
  waiting for the 12h candle to close, the EMA is nudged using the current live price each check:

  ```
  liveEma7  = closedEma7  + (livePrice - lastClosedCandle12hClose) / 7
  liveEma25 = closedEma25 + (livePrice - lastClosedCandle12hClose) / 25
  ```

## Entry

Two-stage: arm, then confirm.

1. **Arm:** on a newly-closed 15m candle, if RSI(14) crosses UP through 30 (previous value < 30,
   current value ≥ 30) and the bot is currently flat (holding USDT), set `armed = true`.
2. **Buy:** once armed, buy as soon as BOTH are true:
   - `liveEma7 > liveEma25` (bullish)
   - `liveEma7 > previousLiveEma7` (EMA7 sloping up, not just above EMA25)

   These two conditions don't have to happen on the same tick as the arm event — the bot stays
   "armed" and buys on the first tick afterward where both hold. Arming resets to false once a
   buy fires (or is superseded by re-arming logic — armed only sets once per un-armed period).

Buy size: 100% of current tracked balance (full compounding — no fixed position size).

## Exit

While holding SOL, exit on whichever fires first:

- **Hard stop:** unrealized P&L ≤ **-6%** from entry price.
- **Trailing stop:** track `bestPct` = the highest unrealized % gain seen since entry. Once
  `bestPct` reaches **≥ 8%**, arm the trail. Exit if `bestPct - currentPct ≥ 10` percentage
  points. The trail distance **tightens to 6pp** once `bestPct` has reached **≥ 30%**.
- **Trend exit:** `liveEma7 < liveEma25` AND `RSI(14) 15m < 50`.

Exit sells the entire position (no partial exits).

## Constants (all currently in play)

```
RSI_LOW        = 30      # arm threshold
MA_FAST        = 7       # EMA period (12h candles)
MA_SLOW        = 25      # EMA period (12h candles)
HARD_STOP_PCT  = -6      # %
TRAIL_ARM_PCT  = 8       # % gain that arms the trailing stop
TRAIL_PP       = 10      # trail distance in percentage points (below TRAIL_ARM_PCT<->STEP_THRESH)
STEP_THRESH    = 30      # % gain threshold that tightens the trail
STEP_TRAIL_PP  = 6       # tighter trail distance once STEP_THRESH is reached
```

## Known shape of returns (backtested on real 1-minute exchange data, full compounding)

- **Win rate ~30-40%.** Most trades are small losses; a small number of large trend-catching
  winners (20-45%+ single-trade gains) carry the entire positive return.
- Because of that shape, the strategy is **very sensitive to entry-timing precision** on the rare
  big trades — a delayed or missed entry on one of those can swing the total result by tens of
  percentage points. This is the main thing worth improving: anything that catches the big trend
  moves earlier/more reliably without adding false-positive noise on the frequent small chop.
- 5-year backtest (Bitfinex): 199 trades, 36.2% win rate, worst single trade -6.89%
  (hard-stop-capped), best trades +34.8% / +31.4% / +30.2%.
- Currently checked every 5 minutes with real order execution taking further time to fill — a
  faster/tighter execution loop is a known lever already being worked on separately; open to
  improvements to the **signal logic itself** (arm/confirm rules, exit rules, or the indicators
  used) independent of that.

## What "improve" means here

Baseline to beat — same formula as above, backtested on real Bitfinex 1-minute data (0% fee,
this account's real maker tier there), full compounding, $50 seed:
- 1 year: +8.24%
- 2 years: +144.44%
- 5 years: +1,305.60%

Benchmark (SOL buy & hold, same Bitfinex data) for context: 1yr -55.90%, 2yr -27.39%,
5yr -44.33% — this strategy already beats buy-and-hold by a wide margin in every window; the bar
is to beat *this strategy's* own numbers, not just the market.

Note: this bot currently trades live on Binance.US, not Bitfinex (a venue migration is planned
but not yet live) — Bitfinex numbers are used here as the baseline because that's the real
execution environment being targeted, and because Binance.US's thin liquidity (SOLUSDT: 54.5% of
1-minute candles have zero trades) makes its own backtest numbers less trustworthy as a target.
