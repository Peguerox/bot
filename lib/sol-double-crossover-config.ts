// Double-crossover controller -- Worker 1 replacement. Continuous variable-exposure strategy, NOT
// a DCA grid: holds a target % of account equity in SOL (0% to ~53%), sized by two hard trend
// crossovers (direction) and one soft acceleration gate (intensity). See
// docs/adaptive_exposure_family.md for the full research trail -- independently reproduced against
// the source spec within ~0.4pp on full-history return, and won a final $1,000/2yr/quarterly
// bake-off against the deployed DCA grid and four other adaptive-family variants (+24.64% vs the
// DCA grid's +23.24%, though at ~36x the trade count).
//
// f_t = 0.5295188903808594 * T_t * L_t * A_t
//   T_t = 1 if EMA_360 > EMA_4320 else 0   (hard crossover: 6h trend vs 72h trend)
//   L_t = 1 if EMA_1440 > EMA_10080 else 0 (hard crossover: 1d trend vs 7d trend)
//   A_t = sigmoid((r_t - r_bar_t) / 0.00075)  (soft: is the short trend accelerating right now)
//   r_t = EMA_360/EMA_4320 - 1 (raw ratio, pre-sigmoid)
//   r_bar_t = EW mean of r_t itself, half-life 1440min (1 day)
//
// Both crossovers must agree (AND) for ANY exposure -- target is exactly zero otherwise, unlike
// the softer T*L-only variants that fade gradually. Seeded at $1000, not $500: research found a
// real minimum-order cliff around $1000 (Bitfinex's actual SOLUSD minimum is 0.02 SOL, ~$2, not
// the $10-25 an earlier report assumed) -- below that, the 0.5%-of-equity order cap can't clear
// the real exchange minimum often enough and return collapses (+6.64% at $500 vs +31.8% at $1000
// in our own backtest of this exact formula).

export function sigmoid(x: number): number {
  const c = Math.max(-20, Math.min(20, x));
  return 1 / (1 + Math.exp(-c));
}

// EW half-life recursion, half-life `h` in minutes, elapsed minutes `dtMin` (generalizes cleanly
// to irregular gaps -- a restart after downtime just takes one larger step, same formula).
export function emaStep(prev: number, price: number, halfLifeMin: number, dtMin: number): number {
  const alpha = 1 - Math.pow(2, -dtMin / halfLifeMin);
  return prev + alpha * (price - prev);
}

export const HALF_LIFE_360 = 360;   // 6h
export const HALF_LIFE_4320 = 4320; // 72h
export const HALF_LIFE_1440 = 1440; // 1d -- also used for r_bar
export const HALF_LIFE_10080 = 10080; // 7d

export const ACCEL_WIDTH = 0.00075;
export const TARGET_COEF = 0.5295188903808594;

export type EmaState = {
  ema360: number; ema4320: number; ema1440: number; ema10080: number; rBar: number;
};

export function stepEmaState(prev: EmaState, price: number, dtMin: number): EmaState {
  const ema360 = emaStep(prev.ema360, price, HALF_LIFE_360, dtMin);
  const ema4320 = emaStep(prev.ema4320, price, HALF_LIFE_4320, dtMin);
  const ema1440 = emaStep(prev.ema1440, price, HALF_LIFE_1440, dtMin);
  const ema10080 = emaStep(prev.ema10080, price, HALF_LIFE_10080, dtMin);
  const r = ema360 / ema4320 - 1;
  const rBar = emaStep(prev.rBar, r, HALF_LIFE_1440, dtMin);
  return { ema360, ema4320, ema1440, ema10080, rBar };
}

export function targetFraction(s: EmaState): number {
  const r = s.ema360 / s.ema4320 - 1;
  const T = s.ema360 > s.ema4320 ? 1 : 0;
  const L = s.ema1440 > s.ema10080 ? 1 : 0;
  const A = sigmoid((r - s.rBar) / ACCEL_WIDTH);
  return TARGET_COEF * T * L * A;
}

export const BFX_SYMBOL = "tSOLUSD";
export const SEED_USD = 1000;
export const DEADBAND_MULT = 0.01;       // |w - f| > 0.01 * f * (1-f) triggers a rebalance
export const ORDER_CAP_FRAC = 0.005;     // max 0.5% of equity per order
export const MIN_NOTIONAL_FRAC = 0.0001; // min order = 0.01% of initial equity (fixed, not scaled by compounding)
export const REAL_MIN_SOL_UNITS = 0.02;  // confirmed via Bitfinex pub:info:pair, 2026-09-13
export const ADVERSE_COST_PER_SIDE = 0.0002; // 2bps, matches every backtest in this research line

// How much trailing history to warm-seed the EMAs with on first boot (in days). 7d half-life needs
// real runway to mean anything -- starting flat would misprice every signal for days.
export const SEED_HISTORY_DAYS = 30;
