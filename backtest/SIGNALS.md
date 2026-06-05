# Signal Research Booklet

Results from all backtested strategies and signals. Updated as we test new ideas.
Timeframe: May–Jun 2026. Exchange: Binance US (spot, 0% maker fee).

---

## Live Bots (Running)

### Z-Score Correlation Break
**Concept:** BTC leads BNB and ATOM. When an alt lags BTC by >2 standard deviations (z-score ≤ -2.0), buy the alt — it should mean-revert.

**Signal:** Rolling 20-period z-score of log-return spread (alt minus BTC) on 1m candles.

**Parameters (optimized):**
- Pairs: BNBUSDT + ATOMUSDT
- Timeframe: 1m
- Z threshold: -2.0
- TP: 0.8% | SL: 0.3% | Max hold: 6 candles (6 min)
- Entry: maker limit order at current price

**Backtest results (6 months, combined BNB+ATOM):**
- PnL: +$7,103 on $1,000 allocation
- Win rate: ~3.5% | Profit factor: 2.73
- Trades: 17,256 total (~94/day)
- All 24 hours profitable — no time filter beneficial
- 8pm–9pm EDT anomaly: 18.8% WR, PF 5.76 (needs more data to confirm)

**Hold period test:** Hold=6 beats Hold=3 across all timeframe/pair combinations.

**TP/SL grid result:** TP=0.8% SL=0.3% is practical optimum. TP=1.2% SL=0.2% wins mathematically (+$9,587) but is likely overfitting (0.4% WR = almost all expire).

---

### Accumulator (BTC ↔ SOL)
**Concept:** Hold SOL when BTC is in an uptrend (SOL gets extra leverage). Hold BTC when BTC is downtrending (safety). Accumulate BTC over time.

**Signal:** BB(10) on BTCUSDT 5m. If BTC/USD close > 10-period MA → hold SOL. If below → hold BTC.

**Key finding:** Signal must be on BTC/USD, NOT on SOL/BTC ratio.
- BB(10) on BTC/USD → +4,387% BTC gain (1 year)
- BB(10) on SOL/BTC → -21% BTC gain (loses BTC)

**Backtest results (1 year, BTCUSDT 5m):**
- Final BTC: 0.608 (started 0.01356)
- Gain: +4,387%
- Switches: 23,367 (very frequent — every small wobble around the MA)
- Best period: BB(10) wins over BB(5), BB(20), BB(30)

**Time-of-day test:** Must run 24/7. Restricting to NY session only = +405% vs +4,387% baseline. Any time filter dramatically hurts performance.

---

## Soft Signals (Real Edge, Not Standalone Bots)

### Liquidation Bounce
**Concept:** Large BTC price drop + volume spike on 5m = likely forced liquidations. Buy the bounce immediately after.

**Proxy signal (no direct liquidation data available):**
- BTC 5m candle drops > X%
- Volume > N× rolling 20-period average

**Backtest results (1 year, BTCUSDT 5m, TP=0.5% SL=0.3% Hold=6):**

| Signal | Trades/yr | Win Rate | PF | PnL |
|--------|-----------|----------|-----|-----|
| >0.3% + 1.5× vol | 1,063 | 20% | 0.95 | -$78 |
| >0.5% + 2× vol | 256 | 27% | 0.92 | -$34 |
| >0.8% + 3× vol | 49 | 43% | 1.67 | **+$46** |
| >1.0% + 3× vol | 25 | 48% | 2.35 | **+$41** |

**Forward return analysis (best params, 49 events):**
| Candles after | % Positive | Avg return |
|--------------|------------|------------|
| +1 (5 min) | 63% | +0.12% |
| +3 (15 min) | 65% | +0.22% |
| +6 (30 min) | **69%** | +0.38% |

**BTC cascade → alt bounce? No.**
- BNB at +1 candle after BTC cascade: -0.24% (alts bleed, not bounce)
- ATOM at +3 candles: -0.52%

**Why not a standalone bot:** Only 25–49 events/year (1 every 7–15 days). Too sparse.

**Best use as filter:** When cascade fires, pause Z-Score bot or widen TP — market is in recovery mode and BTC/alt correlation breaks down completely during cascades.

---

### Fear & Greed Contrarian
**Concept:** Crypto Fear & Greed Index (Alternative.me, 0–100) as a macro contrarian signal.
- Extreme Fear = everyone panicking = buy BTC
- Extreme Greed = everyone euphoric = sell to USDT

**Classification (Alternative.me standard):**
- 0–24: Extreme Fear
- 25–49: Fear
- 50: Neutral
- 51–74: Greed
- 75–100: Extreme Greed

**Data:** Daily, ~3 years of history, free API, no key needed.
URL: `https://api.alternative.me/fng/?limit=1100&format=json`

**Backtest results (3 years, May 2023 – Jun 2026):**
- Baseline buy-and-hold BTC: +163.5%
- Best combo (buy < 35, sell > 80): **+194.4%** (beats BTC by ~31%)
- Only 5 switches in 3 years — essentially buy-and-hold with better entry/exit timing

**Grid summary (threshold combinations):**
- Most combos underperform buy-and-hold BTC
- Only "buy in fear, sell in extreme greed" combos beat BTC
- Tighter thresholds (sell > 80 only) win — don't sell too early

**Forward return after extreme readings:**
| Signal | Sample | Avg +7d | Avg +30d | % Up 30d |
|--------|--------|---------|---------|----------|
| Extreme Fear (<20) | 91 days | +0.2% | +4.4% | **69%** |
| Fear (<30) | 225 days | +0.2% | -0.3% | 54% |
| Neutral (45–55) | 221 days | +0.6% | +6.0% | 61% |
| Greed (>70) | 286 days | +0.8% | +3.2% | 46% |
| Extreme Greed (>80) | 35 days | 0.0% | +0.9% | **46%** |

**Key insight:** Extreme Fear is a strong buy signal (69% up 30 days later). Extreme Greed is a warning (only 46% positive vs 61% neutral).

**Why not a standalone bot:** Only fires ~35–91 times over 3 years. Too slow for a trading bot.

**Best use as filter:**
- FNG < 30 (Fear): Z-Score bot runs at full aggression, consider wider TP
- FNG > 80 (Extreme Greed): Z-Score bot pauses or tightens SL

---

## Signals Tested & Discarded

### Heartbeat Pattern (tick-based volume spikes)
**Concept:** Intraday volume bursts > N× baseline predict short-term price momentum.
**Result:** PF 1.11, +$98 over 14 days. Marginal edge, not tradeable alone.
**Data:** aggTrades from `data.binance.vision` (note: timestamps in microseconds ÷ 1,000,000).

### Volume Clock
Skipped — same signal as Heartbeat Pattern, no additional information.

---

## Backtest Scripts

| File | What it tests |
|------|---------------|
| `backtest/zscore-final.ts` | Z-Score TP/SL grid (hold=6, 1m, 6mo) |
| `backtest/zscore-holdtest.ts` | Z-Score hold=3 vs hold=6 |
| `backtest/zscore-extended.ts` | Z-Score extended TP/SL grid |
| `backtest/zscore-timeofday.ts` | Z-Score hour-by-hour breakdown |
| `backtest/accumulator-timeofday.ts` | Accumulator time restriction test |
| `backtest/accumulator-signal-compare.ts` | BTC/USD vs SOL/BTC as signal |
| `backtest/heartbeat.ts` | Tick-level volume spike strategy |
| `backtest/liq-bounce.ts` | Liquidation cascade bounce |
| `backtest/fear-greed.ts` | Fear & Greed contrarian |
| `backtest/retail-sentiment.ts` | Binance L/S ratio (geo-blocked for US) |
