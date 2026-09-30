# SOL/BTC Size Confirmation — Strategy Spec (handoff for independent testing)

**Status:** Currently running live as **PAPER** (no real money) on our Worker 1 dashboard. This is our most rigorously verified strategy to date — independently re-derived from scratch and matched to real recorded state at every upgrade stage described below. Source: `lib/solbtc-sizeconf-engine.ts`.

## Core idea

Trade SOL/BTC on Bitfinex, holding either SOL or BTC (never cash). Entries and exits are driven by a **trade-count pressure signal** derived from the real trade tape (not price candles) — the ratio of buy-initiated to sell-initiated executions, decayed over recent activity.

## 1. Base pressure signal

Every completed trade batch (all executions sharing the exact same millisecond timestamp, processed as one event):

```
fade = 2^(-count / 4)                 // decay factor, count = executions in this batch
U = fade * U_prev + signedCount       // signedCount = sum(sign(amount)) over the batch
W = fade * W_prev + count
q = U / W                              // pressure, range roughly -1 to +1
```

A second, faster signal (`tinyQ`) tracks only tiny trades (< 0.1 SOL per execution) the same way, and confirms/lowers the entry threshold: if `tinyQ` agrees strongly with the direction (`|tinyQ| > 0.30`), the base threshold relaxes from 0.60 to 0.50.

A lagged-response confirmation (`response`) checks whether price has actually been moving in the direction pressure predicts, over a trailing 300-second window:

```
response = sum(q_lag_prev * log_return) / sum(|log_return|)   // over last 300s
```

Entry (BTC → SOL) fires when: `q > threshold AND response > 0 AND [30-min activity gate is on]`.

## 2. Activity gate

A 30-minute rolling window of price movement (basis points) per trade tracks whether the market is "active enough" to trust the signal. Turns off below 0.50 bps/trade, back on at ≥0.75 bps/trade (hysteresis).

## 3. Drawdown-gated threshold tightening

An internal (gating-only, not real P&L) log-equity curve tracks drawdown from peak. When drawdown reaches **6%**, both thresholds tighten asymmetrically — entry (buy) threshold +0.175, exit (sell) threshold +0.05 (capped at 0.90) — relaxes once drawdown recovers below 1.5%. Asymmetric because over-tightening exits caused whipsaw churn in testing.

## 4. Exit conditions while holding SOL (checked in priority order)

1. **Pressure reversal**: `q < -threshold` (same threshold logic as entry, mirrored).
2. **ER30 trail**: if 30-minute price-path-efficiency (ratio of net move to total up+down movement) drops below 0.50, AND price reached ≥+0.5% above entry at some point, AND has now pulled back ≥0.75% from that peak — exit regardless of pressure.
3. **Failed-entry exit**: if 60 minutes have passed since entry, price is down ≥0.5% from entry, price never reached +0.1% above entry, AND pressure has weakened (`q ≤ 0.30` and below whatever q triggered the original entry) — force exit.
4. **Early response** (lowest priority, only checked if none of the above fired): while holding age is 180–900 seconds, price has dropped ≥0.5% from entry, current `q ≤ 0.40`, AND `q` is below whatever `q` was at the *original entry request* (not the fill) — exit early. Validated as a real, non-overfit improvement on a genuinely out-of-sample window (2021–2023), not just the visible test window.

## 5. Execution details

- 20-second expiry on a queued BTC→SOL request (cancelled if unfilled).
- 1-second minimum fill delay.
- Batches formed from real-time trade WebSocket (not REST polling).
- Cost: paper uses real measured Bitfinex bid/ask half-spread at fill time when available, falling back to a flat 0.02%/side otherwise.

## Verification history (why we trust this one)

- Base pressure signal reproduced against the reference formula to ~0.24% on a 2-year backtest window.
- "Protection" upgrade (drawdown-tightening + ER30 trail + failed-entry) reproduced to exact drawdown (21.4776%) and failed-entry-fill count (116) on the corrected 3-year dataset, and confirmed as the only candidate that *also* improves on a genuine out-of-sample window (2021–2023) that no tuning touched.
- "Early response" upgrade independently reproduced on our own corrected 5-year dataset (not the original challenger doc's 3-year window), confirmed the improvement holds out-of-sample (+369.24%/28.37%DD vs. the frozen benchmark's +238.85%/32.49%DD over 2021–2023). Honest caveat: not uniformly better every year — one year was worse (60.76% vs 75.37%).

## What we want the other agent to check

Independent replay against the same or a fresh dataset, particularly:
- Does the pressure formula (fade/U/W/q) reproduce the same signal timing on their own trade-tape source?
- Does the early-response upgrade's out-of-sample robustness hold on data we haven't touched?
- Real-execution slippage sensitivity — we haven't stress-tested this strategy's real fill quality the way we did for the BTC hypertrading experiments this session; that's the main open question.
