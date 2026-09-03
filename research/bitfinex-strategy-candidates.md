# Possible Bitfinex strategies worth pursuing further

Running list of backtested ideas that came out genuinely positive on Bitfinex, worth revisiting
before building live infrastructure around them. Each entry: what was tested, real numbers, real
spread used, and what's still unverified.

## BTC/UST OCO (TP=1%, SL=0.1%) — 2026-09-03

- **Pair**: tBTCUST (not tBTCUSD — UST/Tether-denominated, not USD-denominated)
- **Window**: 3 months (2026-06 to 2026-09), 124,153 1-min candles
- **Spread used**: 0.0038% half-spread (real measured live ticker at test time — bid $78,072 /
  ask $78,078)
- **Result**: 2,810 trades, 293 TP / 2,517 SL, **10.4% win rate**, **simple sum +19.94%**
- **Mechanics**: sequential (not overlapping) OCO — enter at candle close, wait for TP or SL,
  worst-case-consistent (exit checks priced at bid), conservative tie-break (SL wins if both
  hit same candle), re-enter next candle after each exit, no entry filter.
- **Why this is different from the earlier BTC/USD OCO result** (which went negative, -0.300%,
  after correcting for worst-case spread — see main session history): BTCUST's spread here
  (0.0038%) is roughly half of BTCUSD's (~0.0065-0.0117% measured at various points this
  session). Low win rate (10.4%) is compensated by the 10:1 TP:SL payoff ratio — this is NOT a
  high-win-rate strategy, it's a "many small losses, occasional big win" shape. Worth confirming
  the win/loss shape holds up before trusting it, since asymmetric-payoff strategies can be
  sensitive to a small number of large outlier trades.

**Not yet done**: tick-level replay validation (like the SL sweep work on the SOL Jump Trail
bot), live paper test, checking whether the spread assumption holds across the full 3 months
(spot-checked once, at test time — spread can widen during volatile periods, which is exactly
when this strategy's SL side fires most).
