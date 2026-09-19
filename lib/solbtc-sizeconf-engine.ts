// SOL/BTC "size confirmation" strategy — pure event-driven engine.
//
// Ported from the verified research formula (SOLBTC_Size_Confirmation.md, 2026-09-17):
// original trade-count pressure (U/W) gated by a 30-minute "movement per execution" activity
// filter (the "activity reset"), plus a separate tiny-trade (<0.1 SOL) pressure signal (UT/WT)
// that LOWERS the entry threshold from 0.60 to 0.50 when tiny-trade direction agrees with the
// requested side. Independently reproduced against the reference CSV replay to within ~0.24%
// (2 swaps out of 26,238) on the 2-year backtest window -- close but not bit-exact, see chat.
//
// 2026-09-18 upgrade to the "protection" candidate -- the best-verified strategy found this
// session (SOLBTC_Protection_Test_Results.md), reproduced from scratch against the corrected
// (data-ordering-bug-fixed) 3yr CSV to exact DD (21.4776%) and failed_entry_fills count (116),
// and confirmed as the ONLY candidate that also improves over the plain baseline on a genuine
// out-of-sample window (2021-10-04 -> 2023-09-17) that no tuning ever touched. Adds four
// mechanisms on top of the base pressure signal:
//   1. Drawdown-based ASYMMETRIC threshold tightening -- tracks an internal log-equity curve
//      (using the flat COST constant, not the live spread -- this is purely for gating, separate
//      from the real recorded PnL). When drawdown from equity peak reaches 6%, entry (BTC->SOL)
//      threshold tightens by +0.175 and exit (SOL->BTC) threshold tightens by +0.05 -- asymmetric
//      because the research found over-tightening exits caused whipsaw churn. Relaxes once
//      drawdown recovers below 1.5% (hysteresis, same shape as the activity gate).
//   2. ER30 trail exit -- if 30-minute price-path-efficiency (ER30, the ratio of net directional
//      move to total up+down movement) drops below 0.50 while holding SOL, AND price reached at
//      least +0.5% above entry at some point, AND has now pulled back >=0.75% from that peak,
//      exit early regardless of the pressure signal.
//   3. 20-second SOL-request expiry -- a queued BTC->SOL request that hasn't filled within 20s
//      is cancelled (not carried forward), avoiding stale-signal fills on a thin pair.
//   4. Failed-entry forced exit -- if 60 minutes have elapsed since a SOL entry, price is down
//      >=0.5% from entry, price never reached +0.1% above entry, AND pressure has weakened
//      (q <= 0.30, and below whatever q triggered the original entry request), force an exit even
//      without a pressure-reversal signal. Protects against holding a "failed" entry indefinitely.
//
// 2026-09-18 upgrade to the "early response" challenger (SOLBTC_Early_Response_Challenger.md).
// Independently reproduced on our own corrected 5yr CSV (not the 3yr window the challenger doc's
// own search used) -- confirmed the improvement holds on the genuinely out-of-sample 2021-2023
// years (+369.24%/28.37%DD vs the frozen protection benchmark's +238.85%/32.49%DD over that same
// untouched window), so this isn't just an overfit artifact of the visible window. One honest
// caveat found during verification: it's not uniformly better every single year (the year ending
// 2024-09-16 was worse for this rule, 60.76% vs 75.37%) -- consistent with the doc's own "thin
// margin, not a reliable guarantee" framing.
//   5. Early response -- while holding SOL, if ALL of: holding age is between 180-900s, current
//      price has dropped >=0.5% from entry, current pressure q<=0.40, AND q is below whatever q
//      was observed at the ORIGINAL SOL-entry request (not the fill) -- exit early. This is lowest
//      priority: only fires if pressure/trail/failed-entry didn't already trigger first.
//
// Architectural note: the backtest replays a fixed CSV array and groups trades into batches by
// exact matching millisecond timestamp. This live engine is event-driven off a real-time trade
// WebSocket instead -- batches are formed by buffering trades that share a timestamp until a
// later-timestamped trade arrives (see lib/bitfinex-public-trades-ws.ts), and the 30-minute
// activity/ER30 window is advanced by an explicit closeMinute() call on every real UTC minute
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

export type MinuteEntry = { movementBps: number; movementSigned: number; count: number };

export type EngineState = {
  side: Side;
  pending: Side | null;
  queuedTs: number | null; // seconds
  lastFillTs: number; // seconds
  pendingRequestQ: number | null; // q at the moment the CURRENT pending BTC->SOL request was made

  U: number; W: number;
  Ut: number; Wt: number; lastTinyTs: number;

  lastLogPrice: number | null;
  qLagPrev: number;
  respNum: number; respDen: number;
  respBuf: { ts: number; num: number; den: number }[];

  active: boolean;
  minuteBuf: MinuteEntry[]; // rolling <=30 completed minutes
  windowMv: number; windowSg: number; windowCt: number;
  prevMinuteClose: number | null;
  er30: number; // 30-min path efficiency, updated at minute close

  // Drawdown-gated threshold tightening (internal log-equity, gating only -- not real PnL)
  logEquity: number;
  peakLogEquity: number;
  tightened: boolean;

  // Entry tracking, used by the ER30 trail and failed-entry exit while side === "SOL"
  peakSinceEntry: number | null;
  entryPrice: number | null;
  entryFillTs: number | null; // seconds
  entryReached10bps: boolean;
  entryRequestQ: number | null; // q at the ORIGINAL SOL-entry request (not the fill), used by early response
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

export const TIGHTEN_ON_DD = 0.06;
export const TIGHTEN_OFF_DD = 0.015;
export const TIGHTEN_BUY_ADD = 0.175;
export const TIGHTEN_SELL_ADD = 0.05;
export const MAX_THRESHOLD = 0.90;
export const SOL_REQUEST_EXPIRY_S = 20;
export const TRAIL_ER30_MAX = 0.50;
export const TRAIL_MIN_PROFIT = 0.005;
export const TRAIL_PULLBACK = 0.0075;
export const FAILED_ENTRY_ELAPSED_S = 3600;
export const FAILED_ENTRY_DRAWDOWN = 0.005;
export const FAILED_ENTRY_MAX_Q = 0.30;
export const EARLY_RESPONSE_MIN_AGE_S = 180;
export const EARLY_RESPONSE_MAX_AGE_S = 900;
export const EARLY_RESPONSE_DRAWDOWN = 0.005;
export const EARLY_RESPONSE_MAX_Q = 0.40;

export function initialState(): EngineState {
  return {
    side: "BTC", pending: null, queuedTs: null, lastFillTs: -1e18, pendingRequestQ: null,
    U: 0, W: 0, Ut: 0, Wt: 0, lastTinyTs: -1e18,
    lastLogPrice: null, qLagPrev: 0, respNum: 0, respDen: 0, respBuf: [],
    // Starts false, not true: with an empty rolling window (windowCt=0), M=0 < 0.50 fires the
    // "inactive" rule immediately on the very first evaluation -- matches the reference engine,
    // which evaluates M on every batch (not just at minute boundaries) and computes M[0]=0 for
    // the very first minute before any window data exists.
    active: false, minuteBuf: [], windowMv: 0, windowSg: 0, windowCt: 0, prevMinuteClose: null,
    er30: 1.0,
    logEquity: 0, peakLogEquity: 0, tightened: false,
    peakSinceEntry: null, entryPrice: null, entryFillTs: null, entryReached10bps: false,
    entryRequestQ: null,
  };
}

export type BatchResult = {
  state: EngineState;
  fill: { side: Side; fillPrice: number; signalTs: number; latencyS: number } | null;
  q: number;
  tinyQ: number;
  response: number;
};

// Call once per completed trade batch, in timestamp order. `costPct` is the cost applied to a
// fill THIS batch, if one occurs -- the live worker passes the real measured bid/ask half-spread
// (falling back to the flat COST constant only when the order-book WS hasn't snapshotted yet), so
// the internal drawdown-tightening math is driven by the same real cost that gets recorded to the
// database, not a separate flat assumption. Defaults to COST for backtest/replay callers that
// don't have a live book.
export function processBatch(s: EngineState, b: Batch, costPct: number = COST): BatchResult {
  const tsS = b.tsMs / 1000;

  let side = s.side;
  let pending = s.pending;
  let queuedTs = s.queuedTs;
  let lastFillTs = s.lastFillTs;
  let pendingRequestQ = s.pendingRequestQ;
  let peakSinceEntry = s.peakSinceEntry;
  let entryPrice = s.entryPrice;
  let entryFillTs = s.entryFillTs;
  let entryReached10bps = s.entryReached10bps;
  let entryRequestQ = s.entryRequestQ;
  let logEquity = s.logEquity;
  let peakLogEquity = s.peakLogEquity;
  let tightened = s.tightened;
  let fill: { side: Side; fillPrice: number; signalTs: number; latencyS: number } | null = null;

  // 20s SOL-request expiry, checked BEFORE fill processing (matches the verified backtest order).
  if (pending === "SOL" && queuedTs !== null && tsS - queuedTs > SOL_REQUEST_EXPIRY_S) {
    pending = null; queuedTs = null; pendingRequestQ = null;
  }

  const x = Math.log(b.lastPrice);
  const r = s.lastLogPrice !== null ? x - s.lastLogPrice : 0;

  if (pending !== null && queuedTs !== null && tsS >= queuedTs + MIN_FILL_DELAY_S && tsS > queuedTs) {
    const fp = b.firstPrice;
    const fillLogPrice = Math.log(fp);
    const preFillLogPrice = s.lastLogPrice ?? fillLogPrice;
    logEquity += (side === "SOL" ? 1 : 0) * (fillLogPrice - preFillLogPrice) + Math.log1p(-costPct);
    fill = { side: pending, fillPrice: fp, signalTs: queuedTs, latencyS: tsS - queuedTs };
    side = pending; pending = null; lastFillTs = tsS;
    logEquity += (side === "SOL" ? 1 : 0) * (x - fillLogPrice);
    if (side === "SOL") {
      peakSinceEntry = fp; entryPrice = fp; entryFillTs = tsS; entryReached10bps = false;
      entryRequestQ = pendingRequestQ; // q at the request that led to THIS fill, persists through the hold
      pendingRequestQ = null;
    }
  } else {
    logEquity += (side === "SOL" ? 1 : 0) * r;
  }

  if (side === "SOL" && peakSinceEntry !== null && entryPrice !== null) {
    peakSinceEntry = Math.max(peakSinceEntry, b.lastPrice);
    if (b.lastPrice >= entryPrice * (1 + 0.001)) entryReached10bps = true;
  }

  const fade = Math.pow(2, -b.count / 4);
  const U = fade * s.U + b.signedCount;
  const W = fade * s.W + b.count;
  const q = W > 0 ? U / W : 0;

  const Ut = fade * s.Ut + b.tinySignedCount;
  const Wt = fade * s.Wt + b.tinyCount;
  const lastTinyTs = b.tinyCount > 0 ? tsS : s.lastTinyTs;
  const tinyQ = Wt >= 0.5 && tsS - lastTinyTs <= TINY_STALE_S ? Ut / Wt : 0;

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

  // Drawdown-gated asymmetric threshold tightening.
  peakLogEquity = Math.max(peakLogEquity, logEquity);
  const dd = 1 - Math.exp(logEquity - peakLogEquity);
  if (!tightened && dd >= TIGHTEN_ON_DD) tightened = true;
  else if (tightened && dd < TIGHTEN_OFF_DD) tightened = false;

  const buyAdd = tightened ? TIGHTEN_BUY_ADD : 0;
  const sellAdd = tightened ? TIGHTEN_SELL_ADD : 0;
  const buyBase = tinyQ > TINY_CONFIRM_THRESHOLD ? 0.50 : 0.60;
  const sellBase = tinyQ < -TINY_CONFIRM_THRESHOLD ? 0.50 : 0.60;
  const buyThreshold = Math.min(MAX_THRESHOLD, buyBase + buyAdd);
  const sellThreshold = Math.min(MAX_THRESHOLD, sellBase + sellAdd);

  if (side === "BTC" && pending === null && q > buyThreshold && response > 0 && s.active && tsS - lastFillTs >= MIN_FILL_DELAY_S) {
    pending = "SOL"; queuedTs = tsS; pendingRequestQ = q;
  } else if (side === "SOL" && pending === null && tsS - lastFillTs >= MIN_FILL_DELAY_S) {
    const trailHit = peakSinceEntry !== null && entryPrice !== null &&
      s.er30 < TRAIL_ER30_MAX &&
      peakSinceEntry >= entryPrice * (1 + TRAIL_MIN_PROFIT) &&
      b.lastPrice <= peakSinceEntry * (1 - TRAIL_PULLBACK);
    const failedEntryHit = entryFillTs !== null && entryPrice !== null &&
      (tsS - entryFillTs) >= FAILED_ENTRY_ELAPSED_S &&
      b.lastPrice <= entryPrice * (1 - FAILED_ENTRY_DRAWDOWN) &&
      entryReached10bps === false &&
      q <= FAILED_ENTRY_MAX_Q &&
      (pendingRequestQ === null || q < pendingRequestQ);
    // Lowest priority -- only checked if none of the above already triggered, matching the
    // challenger doc's reason-attribution order (pressure, trail, failed-entry, early response).
    let earlyResponseHit = false;
    if (!(q < -sellThreshold) && !trailHit && !failedEntryHit &&
        entryFillTs !== null && entryPrice !== null && entryRequestQ !== null) {
      const age = tsS - entryFillTs;
      earlyResponseHit = age >= EARLY_RESPONSE_MIN_AGE_S && age <= EARLY_RESPONSE_MAX_AGE_S &&
        b.lastPrice <= entryPrice * (1 - EARLY_RESPONSE_DRAWDOWN) &&
        q <= EARLY_RESPONSE_MAX_Q &&
        q < entryRequestQ;
    }
    if (q < -sellThreshold || trailHit || failedEntryHit || earlyResponseHit) {
      pending = "BTC"; queuedTs = tsS;
    }
  }

  return {
    state: {
      ...s, side, pending, queuedTs, lastFillTs, pendingRequestQ, U, W, Ut, Wt, lastTinyTs,
      lastLogPrice: x, qLagPrev: q, respNum, respDen, respBuf,
      peakSinceEntry, entryPrice, entryFillTs, entryReached10bps, entryRequestQ,
      logEquity, peakLogEquity, tightened,
    },
    fill, q, tinyQ, response,
  };
}

// Call once per completed real UTC minute, forward-filling `close` from the last known trade
// price when the minute had zero executions. `count` is the number of executions observed
// during that minute (0 if none). Updates the 30-minute rolling activity gate AND the ER30 trail
// value for the NEXT minute's batches to read (current minute's own stats aren't included until
// it closes).
export function closeMinute(s: EngineState, close: number, count: number): EngineState {
  const movementBps = s.prevMinuteClose !== null ? 10000 * Math.abs(Math.log(close / s.prevMinuteClose)) : 0;
  const movementSigned = s.prevMinuteClose !== null ? Math.log(close / s.prevMinuteClose) : 0;

  const minuteBuf = [...s.minuteBuf, { movementBps, movementSigned, count }];
  let windowMv = s.windowMv + movementBps;
  let windowSg = s.windowSg + movementSigned;
  let windowCt = s.windowCt + count;
  if (minuteBuf.length > ACTIVITY_WINDOW_MIN) {
    const old = minuteBuf.shift()!;
    windowMv -= old.movementBps; windowSg -= old.movementSigned; windowCt -= old.count;
  }
  const M = windowCt > 0 ? windowMv / windowCt : 0;

  let active = s.active;
  if (M < ACTIVITY_OFF) active = false;
  else if (M >= ACTIVITY_ON) active = true;

  const denom = windowMv / 10000;
  const er30 = denom > 0 ? Math.abs(windowSg) / denom : 1.0;

  return { ...s, minuteBuf, windowMv, windowSg, windowCt, active, er30, prevMinuteClose: close };
}
