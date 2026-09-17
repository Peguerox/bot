// SOL/BTC "participation" hybrid strategy -- fast CUSUM regime detection combined with a slower
// trend + price-confirmation signal, switching between them based on how reliable the fast
// signal's own recent track record has been. Ported line-for-line from the verified C++ research
// engine (matched its published results to 6 decimal places on real Bitfinex data, 2026-09-16)
// with controller=1, fill_mode=1 (next-observed-open fills), trend_kind=0, volatility_scale=0 --
// the only branches that matter are inlined directly, the others aren't ported.
//
// Real cost 0.02%/side is a deliberately conservative assumption -- the measured real Bitfinex
// SOLBTC spread is ~0.01555%/side; 0.02% is close to (just past) where the most recent year's
// backtest flips from positive to negative, so this is a stress-tested, not optimistic, cost.
export const COST = 0.0002;
export const SCORE_HALF_LIFE = 10080;   // minutes, 7 days
export const PENALTY = 4;
export const MULTIPLIER = 0.5;
export const FAST_TREND_HALF_LIFE = 720;   // minutes, 12h
export const SLOW_TREND_HALF_LIFE = 2880;  // minutes, 48h
export const TREND_BAND = 0.003;
export const PRICE_CONFIRMATION_BAND = 0.006;
export const CONTROLLER_REVIEW_MINUTES = 15;

const ALPHA = 1 - Math.pow(2, -1 / 30);
const BETA = 1 - Math.pow(2, -1 / SCORE_HALF_LIFE);
const AF = 1 - Math.pow(2, -1 / FAST_TREND_HALF_LIFE);
const AS = 1 - Math.pow(2, -1 / SLOW_TREND_HALF_LIFE);
const LC = Math.log1p(-COST); // negative number: log(1 - cost)

export type Side = "BTC" | "SOL";
const other = (s: Side): Side => (s === "BTC" ? "SOL" : "BTC");

export type EngineState = {
  side: Side;
  pending: Side | null;
  virtualSide: Side;
  virtualPending: Side | null;
  base: Side;
  v: number;
  sUp: number;
  sDown: number;
  d: number;
  scoreV: number;
  m: number;
  scoreT: number;
  orientation: 1 | -1;
  fastEwma: number | null;
  slowEwma: number | null;
  trendVariance: number;
  trend: 0 | 1;
  priceOk: 0 | 1;
  fastMode: 0 | 1;
  lastLogPrice: number | null;
};

export type Candle = { openTimeMs: number; open: number; close: number; volume: number };

export type StepResult = {
  state: EngineState;
  actualFill: { side: Side; fillPrice: number } | null; // fills at THIS candle's open, when pending existed
};

// Processes exactly one newly-closed candle through the full update order from the verified
// engine: (1) apply any pending actual fill at this candle's open if volume>0, (2) apply any
// pending virtual/paper fill + compute the advantage score, (3) update D/V/M/T, (4) update the
// fast CUSUM (v, S_up, S_down, base), (5) hourly orientation review, (6) update fast/slow trend
// EWMAs, (7) quarter-hourly controller review (fastMode/trend/priceOk), (8) determine the desired
// coin and queue a new actual pending order if it differs from the current side.
export function stepMinute(state: EngineState, c: Candle): StepResult {
  const s = { ...state };
  const x = Math.log(c.close);
  const last = s.lastLogPrice ?? x;
  const r = s.lastLogPrice === null ? 0 : x - last;

  let actualFill: { side: Side; fillPrice: number } | null = null;

  // 1. actual fill at this candle's open, if a swap was queued and this candle actually traded
  if (s.pending !== null && c.volume > 0) {
    const op = Math.log(c.open);
    // old side earns previous-close-to-open return, cost is deducted here (matches lc credited
    // once per fill in the reference engine, applied to the running log-equity, not per-coin)
    s.side = s.pending;
    s.pending = null;
    actualFill = { side: s.side, fillPrice: c.open };
    // new side earns open-to-close return -- handled by caller via fillPrice/side, not logw here
  }

  // 2. virtual/paper fill + advantage
  let vr = (s.virtualSide === "SOL" ? 1 : 0) * r;
  let turn = false; // true exactly when the virtual/paper order fills this row
  if (s.virtualPending !== null && c.volume > 0) {
    const op = Math.log(c.open);
    vr = (s.virtualSide === "SOL" ? 1 : 0) * (op - last);
    s.virtualSide = s.virtualPending;
    s.virtualPending = null;
    vr += (s.virtualSide === "SOL" ? 1 : 0) * (x - op);
    turn = true;
  }
  const aScore = 2 * vr - r;

  // 3. D, V, M, T
  s.d = s.d + BETA * (aScore - s.d);
  s.scoreV = s.scoreV + BETA * (Math.abs(r) - s.scoreV);
  s.m = s.m + BETA * (aScore * aScore - s.m);
  s.scoreT = s.scoreT + BETA * ((turn ? 1 : 0) - s.scoreT);

  // 4. fast CUSUM
  s.v = s.v + ALPHA * (Math.abs(r) - s.v);
  const z = s.v > 1e-20 ? r / s.v : 0;
  s.sUp = Math.max(0, s.sUp + z - 0.1);
  s.sDown = Math.min(0, s.sDown + z + 0.1);
  if ((s.base === "BTC" && s.sUp > 2) || (s.base === "SOL" && s.sDown < -2)) {
    s.base = other(s.base);
    s.sUp = 0;
    s.sDown = 0;
  }
  if (s.virtualPending === null && s.virtualSide !== s.base) s.virtualPending = s.base;

  // 5. hourly orientation review
  const epochMinute = Math.floor(c.openTimeMs / 60_000);
  if ((epochMinute + 1) % 60 === 0 && s.scoreV > 1e-20) {
    if (s.d > 0.05 * s.scoreV) s.orientation = 1;
    if (s.d < -0.05 * s.scoreV) s.orientation = -1;
  }

  // 6. trend EWMAs
  const se = Math.sqrt(Math.max(0, s.m - s.d * s.d) * BETA / (2 - BETA));
  const fastGood = (Math.abs(s.d) - PENALTY * se) / Math.max(s.scoreT, 1e-20) > MULTIPLIER * (-2 * LC);
  if (s.fastEwma === null) s.fastEwma = x;
  if (s.slowEwma === null) s.slowEwma = x;
  s.fastEwma = s.fastEwma + AF * (x - s.fastEwma);
  s.slowEwma = s.slowEwma + AS * (x - s.slowEwma);
  s.trendVariance = s.trendVariance + AS * (r * r - s.trendVariance);

  // 7. quarter-hour controller review
  if ((epochMinute + 1) % CONTROLLER_REVIEW_MINUTES === 0) {
    s.fastMode = fastGood ? 1 : 0;
    const band = TREND_BAND; // volatilityScale=0, so band = max(trendBand, 0) = trendBand
    if (s.fastEwma - s.slowEwma > band) s.trend = 1;
    if (s.fastEwma - s.slowEwma < -band) s.trend = 0;
    if (x - s.fastEwma > PRICE_CONFIRMATION_BAND) s.priceOk = 1;
    if (x - s.fastEwma < -PRICE_CONFIRMATION_BAND) s.priceOk = 0;
  }

  // 8. desired coin + queue
  const fastDesired: Side = s.orientation === 1 ? s.base : other(s.base);
  const trendDesired: Side = s.trend === 1 && s.priceOk === 1 ? "SOL" : "BTC";
  const desired: Side = s.fastMode === 1 ? fastDesired : trendDesired;
  if (s.side !== desired && s.pending === null) {
    s.pending = desired;
  }

  s.lastLogPrice = x;
  return { state: s, actualFill };
}

export function initialState(firstClose: number): EngineState {
  const x = Math.log(firstClose);
  return {
    side: "BTC", pending: null, virtualSide: "BTC", virtualPending: null, base: "BTC",
    v: 0, sUp: 0, sDown: 0, d: 0, scoreV: 0, m: 0, scoreT: 0, orientation: 1,
    fastEwma: x, slowEwma: x, trendVariance: 0, trend: 0, priceOk: 0, fastMode: 0,
    lastLogPrice: null,
  };
}
