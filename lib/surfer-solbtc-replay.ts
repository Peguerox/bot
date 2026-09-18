// Pure replay of trigger/live-bot-surfer-solbtc.ts's exact decision logic (the "buffered
// rotation" v2 strategy, live since 2026-09-14), for the dashboard's Backtest comparison column.
// Assumes an idealized fill at the signal candle's close price (the live bot chases a maker limit
// order at that same price, filling within the same 5-min cron cycle almost always) -- ignores
// order-chase slippage, matching the same simplification convention used elsewhere this session.
// 0% fee (maker), matching the strategy's own documented assumption.

export type Candle = { time: number; close: number };

const BUF_UP = 0.0025, BUF_DN = 0.0020;
const ARM = 0.18, GIVEBACK = 0.15, FAIL = 0.09;
const H_WINDOW_MIN = 6190;
const L_WINDOW_MIN = 2200;
const C_LAG_MIN = 747;

export type SurferSolbtcFill = { side: "SOL" | "BTC"; price: number; time: number };

// Sliding-window max/min via monotonic deque, O(n) total instead of O(n*window).
class MonoMax {
  private deque: { time: number; val: number }[] = [];
  push(time: number, val: number, windowMs: number) {
    while (this.deque.length && this.deque[this.deque.length - 1].val <= val) this.deque.pop();
    this.deque.push({ time, val });
    while (this.deque.length && this.deque[0].time < time - windowMs) this.deque.shift();
  }
  evictTo(cutoffTime: number) {
    while (this.deque.length && this.deque[0].time < cutoffTime) this.deque.shift();
  }
  get(): number | null { return this.deque.length ? this.deque[0].val : null; }
}
class MonoMin {
  private deque: { time: number; val: number }[] = [];
  push(time: number, val: number, windowMs: number) {
    while (this.deque.length && this.deque[this.deque.length - 1].val >= val) this.deque.pop();
    this.deque.push({ time, val });
    while (this.deque.length && this.deque[0].time < time - windowMs) this.deque.shift();
  }
  evictTo(cutoffTime: number) {
    while (this.deque.length && this.deque[0].time < cutoffTime) this.deque.shift();
  }
  get(): number | null { return this.deque.length ? this.deque[0].val : null; }
}

// `candles` must include at least H_WINDOW_MIN minutes of history before the window you actually
// care about (the live bot itself requires this much history before it will even evaluate a
// signal) -- fills before that warm-up point are impossible by construction, matching live.
//
// Critical: the live bot's cron only fires every 5 minutes (trigger/live-bot-surfer-solbtc.ts,
// `cron: "*/5 * * * *"`), so it only ever evaluates whatever 1-min candle most recently closed AT
// that 5-min tick -- NOT every 1-min candle in sequence. A naive per-candle replay fires up to ~4
// minutes (and however much price drift happens in that gap) too early. Found by testing against
// the bot's actual open position: naive replay entered at 03:16 vs the real 04:21 fill, 65 minutes
// and a real price gap off -- fixed by explicitly ticking every 5 minutes like the real cron does.
export function runSurferSolbtcReplay(candles: Candle[]): { fills: SurferSolbtcFill[]; totalReturnPct: number } {
  const fills: SurferSolbtcFill[] = [];
  if (candles.length < 2) return { fills, totalReturnPct: 0 };

  const hWindow = new MonoMax();
  const lWindow = new MonoMin();
  const hWindowMs = H_WINDOW_MIN * 60_000;
  const lWindowMs = L_WINDOW_MIN * 60_000;
  const cLagMs = C_LAG_MIN * 60_000;

  let mode: "BTC" | "SOL" = "BTC";
  let anchor: number | null = null;
  let peak: number | null = null;
  let btc = 1, sol = 0;

  let closedIdx = -1; // index of the most recent FULLY CLOSED candle as of the current tick
  let cPtr = -1;       // index of the most recent candle satisfying the C-lag cutoff

  const tickStepMs = 5 * 60_000;
  const firstTick = Math.ceil(candles[0].time / tickStepMs) * tickStepMs;
  const lastCandleTime = candles[candles.length - 1].time;

  for (let tick = firstTick; tick <= lastCandleTime; tick += tickStepMs) {
    // Advance to the newest candle whose full 1-min period has elapsed by this tick (its open
    // time + 60s <= tick), pushing each newly-closed candle into the H/L windows as "prior" data
    // exactly once, in order.
    while (closedIdx + 1 < candles.length && candles[closedIdx + 1].time + 60_000 <= tick) {
      if (closedIdx >= 0) {
        const prev = candles[closedIdx];
        hWindow.push(prev.time, prev.close, hWindowMs);
        lWindow.push(prev.time, prev.close, lWindowMs);
      }
      closedIdx++;
    }
    if (closedIdx < 0) continue;
    const cur = candles[closedIdx];

    hWindow.evictTo(cur.time - hWindowMs);
    lWindow.evictTo(cur.time - lWindowMs);
    const cutoffC = cur.time - cLagMs;
    while (cPtr + 1 < closedIdx && candles[cPtr + 1].time <= cutoffC) cPtr++;

    const H = hWindow.get();
    const L = lWindow.get();
    const C = cPtr >= 0 ? candles[cPtr].close : null;
    const R = cur.close;

    if (mode === "SOL" && anchor !== null) {
      peak = Math.max(peak ?? anchor, R);
    }

    // Only evaluate once genuinely warmed up (matches the live bot's WAIT_HISTORY guard).
    if (closedIdx < H_WINDOW_MIN || H === null || L === null || C === null) continue;

    if (mode === "BTC") {
      const breakout = R > H * (1 + BUF_UP);
      if (breakout && R > C) {
        sol = btc / R; btc = 0;
        anchor = R; peak = R;
        mode = "SOL";
        fills.push({ side: "SOL", price: R, time: cur.time });
      }
    } else if (mode === "SOL" && anchor !== null) {
      const M = R / anchor;
      const g = (peak ?? anchor) / anchor - 1;
      let triggered = false;
      if (M < 1 - FAIL) triggered = true;
      else if (g >= ARM) { if (M <= 1 + (1 - GIVEBACK) * g) triggered = true; }
      else if (R < L * (1 - BUF_DN)) triggered = true;

      if (triggered && R < C) {
        btc = sol * R; sol = 0;
        anchor = null; peak = null;
        mode = "BTC";
        fills.push({ side: "BTC", price: R, time: cur.time });
      }
    }
  }

  const lastClose = candles[candles.length - 1].close;
  const finalValue = btc + sol * lastClose;
  return { fills, totalReturnPct: (finalValue - 1) * 100 };
}
