// SOL/BTC "size confirmation" strategy — pure event-driven engine.
//
// Ported from the verified research formula (SOLBTC_Size_Confirmation.md, 2026-09-17):
// original trade-count pressure (U/W) gated by a 30-minute "movement per execution" activity
// filter (the "activity reset"), plus a separate tiny-trade (<0.1 SOL) pressure signal (UT/WT)
// that LOWERS the entry threshold from 0.60 to 0.50 when tiny-trade direction agrees with the
// requested side. Independently reproduced against the reference CSV replay to within ~0.24%
// (2 swaps out of 26,238) on the 2-year backtest window -- close but not bit-exact, see chat.
// Extended to a 3rd out-of-sample year: still improves full-period return AND drawdown, though
// year 3 alone trades lower raw return for lower drawdown. Approved to build against while
// further improvements are researched.
//
// Architectural note: the backtest replays a fixed CSV array and groups trades into batches by
// exact matching millisecond timestamp. This live engine is event-driven off a real-time trade
// WebSocket instead -- batches are formed by buffering trades that share a timestamp until a
// later-timestamped trade arrives (see lib/bitfinex-public-trades-ws.ts), and the 30-minute
// activity window is advanced by an explicit closeMinute() call on every real UTC minute
// boundary (forward-filling through minutes with zero trades), matching the "continuous grid"
// discipline the participation bot's live version required. This is a faithful structural port,
// not a byte-for-byte replay verification the way the backtest engines were.

export type Side = "BTC" | "SOL";

export type Batch = {
  tsMs: number;
  firstPrice: number;
  lastPrice: number;
  signedCount: number; // sum(sign(amount)) over all executions in the batch
  count: number; // total executions in the batch
  tinySignedCount: number; // sum(sign(amount)) over executions with abs(amount) < 0.1 SOL
  tinyCount: number; // count of executions with abs(amount) < 0.1 SOL
};

export type EngineState = {
  side: Side;
  pending: Side | null;
  queuedTs: number | null; // seconds
  lastFillTs: number; // seconds

  U: number; W: number;
  Ut: number; Wt: number; lastTinyTs: number;

  lastLogPrice: number | null;
  qLagPrev: number;
  respNum: number; respDen: number;
  respBuf: { ts: number; num: number; den: number }[];

  active: boolean;
  minuteBuf: { movementBps: number; count: number }[]; // rolling <=30 completed minutes
  windowMv: number; windowCt: number;
  prevMinuteClose: number | null;
};

export const TINY_SOL = 0.1;
export const TINY_STALE_S = 300;
export const RESPONSE_WINDOW_S = 300;
export const MIN_FILL_DELAY_S = 1.0;
export const ACTIVITY_WINDOW_MIN = 30;
export const ACTIVITY_OFF = 0.50;
export const ACTIVITY_ON = 0.75;
export const TINY_CONFIRM_THRESHOLD = 0.30;
export const COST = 0.0002; // 0.02%/side paper cost -- deliberately more conservative than the
// ~0.01555% measured real Bitfinex spread, matching this session's convention for Worker 1 paper bots.

export function initialState(): EngineState {
  return {
    side: "BTC", pending: null, queuedTs: null, lastFillTs: -1e18,
    U: 0, W: 0, Ut: 0, Wt: 0, lastTinyTs: -1e18,
    lastLogPrice: null, qLagPrev: 0, respNum: 0, respDen: 0, respBuf: [],
    // Starts false, not true: with an empty rolling window (windowCt=0), M=0 < 0.50 fires the
    // "inactive" rule immediately on the very first evaluation -- matches the reference engine,
    // which evaluates M on every batch (not just at minute boundaries) and computes M[0]=0 for
    // the very first minute before any window data exists.
    active: false, minuteBuf: [], windowMv: 0, windowCt: 0, prevMinuteClose: null,
  };
}

export type BatchResult = {
  state: EngineState;
  fill: { side: Side; fillPrice: number } | null;
  q: number;
  tinyQ: number;
  response: number;
};

// Call once per completed trade batch, in timestamp order.
export function processBatch(s: EngineState, b: Batch): BatchResult {
  const tsS = b.tsMs / 1000;

  let side = s.side;
  let pending = s.pending;
  let queuedTs = s.queuedTs;
  let lastFillTs = s.lastFillTs;
  let fill: { side: Side; fillPrice: number } | null = null;

  if (pending !== null && queuedTs !== null && tsS >= queuedTs + MIN_FILL_DELAY_S && tsS > queuedTs) {
    fill = { side: pending, fillPrice: b.firstPrice };
    side = pending; pending = null; lastFillTs = tsS;
  }

  const fade = Math.pow(2, -b.count / 4);
  const U = fade * s.U + b.signedCount;
  const W = fade * s.W + b.count;
  const q = W > 0 ? U / W : 0;

  const Ut = fade * s.Ut + b.tinySignedCount;
  const Wt = fade * s.Wt + b.tinyCount;
  const lastTinyTs = b.tinyCount > 0 ? tsS : s.lastTinyTs;
  const tinyQ = Wt >= 0.5 && tsS - lastTinyTs <= TINY_STALE_S ? Ut / Wt : 0;

  const x = Math.log(b.lastPrice);
  const r = s.lastLogPrice !== null ? x - s.lastLogPrice : 0;
  const contribNum = s.qLagPrev * r;
  const contribDen = Math.abs(r);
  let respNum = s.respNum + contribNum;
  let respDen = s.respDen + contribDen;
  const respBuf = [...s.respBuf, { ts: tsS, num: contribNum, den: contribDen }];
  while (respBuf.length && respBuf[0].ts < tsS - RESPONSE_WINDOW_S) {
    const old = respBuf.shift()!;
    respNum -= old.num; respDen -= old.den;
  }
  const response = respNum / Math.max(1e-12, respDen);

  const buyThreshold = tinyQ > TINY_CONFIRM_THRESHOLD ? 0.50 : 0.60;
  const sellThreshold = tinyQ < -TINY_CONFIRM_THRESHOLD ? 0.50 : 0.60;

  if (side === "BTC" && pending === null && q > buyThreshold && response > 0 && s.active && tsS - lastFillTs >= MIN_FILL_DELAY_S) {
    pending = "SOL"; queuedTs = tsS;
  } else if (side === "SOL" && pending === null && q < -sellThreshold && tsS - lastFillTs >= MIN_FILL_DELAY_S) {
    pending = "BTC"; queuedTs = tsS;
  }

  return {
    state: {
      ...s, side, pending, queuedTs, lastFillTs, U, W, Ut, Wt, lastTinyTs,
      lastLogPrice: x, qLagPrev: q, respNum, respDen, respBuf,
    },
    fill, q, tinyQ, response,
  };
}

// Call once per completed real UTC minute, forward-filling `close` from the last known trade
// price when the minute had zero executions. `count` is the number of executions observed
// during that minute (0 if none). Updates the 30-minute rolling activity gate for the NEXT
// minute's batches to read (current minute's own stats aren't included until it closes).
export function closeMinute(s: EngineState, close: number, count: number): EngineState {
  const movementBps = s.prevMinuteClose !== null ? 10000 * Math.abs(Math.log(close / s.prevMinuteClose)) : 0;

  const minuteBuf = [...s.minuteBuf, { movementBps, count }];
  let windowMv = s.windowMv + movementBps;
  let windowCt = s.windowCt + count;
  if (minuteBuf.length > ACTIVITY_WINDOW_MIN) {
    const old = minuteBuf.shift()!;
    windowMv -= old.movementBps; windowCt -= old.count;
  }
  const M = windowCt > 0 ? windowMv / windowCt : 0;

  let active = s.active;
  if (M < ACTIVITY_OFF) active = false;
  else if (M >= ACTIVITY_ON) active = true;

  return { ...s, minuteBuf, windowMv, windowCt, active, prevMinuteClose: close };
}
