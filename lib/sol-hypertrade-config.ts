// Single source of truth for the SOL hypertrading paper strategy -- imported by both
// server/sol-hypertrade-paper.ts (the paper worker) and app/page.tsx (the dashboard panel).
//
// VARIABLE-RATE FORMULA (replaces the earlier fixed-multiplier version) -- see
// docs/hypertrade_variable_rate_formula_ORIGINAL.md for the derivation and
// docs/hypertrade_formula_database.md for the full catalog of alternatives considered (and why
// they were rejected -- the higher-return ones are dramatically more fragile to small coefficient
// changes). Independently re-verified against our own 1-min OHLC engine on both Binance Global
// (full ~5yr) and Bitfinex (~2yr): max level ever reached was 9 on both, bare reserve needed
// $2,535.17 per $100 base bet (zero cushion), zero cycles ever closed at a realized loss. Binance
// US (deliberately excluded from sizing decisions -- known liquidity problems) needed 26 levels /
// $12,981 in the same test, so this is NOT assumed to hold everywhere; it's the two exchanges we
// trust. Actual deployed reserve is 35x, not the bare 25.35x -- see RESERVE_DIVISOR below.
//
// Continuous grid, no directional entry signal: always in a position, re-enter immediately
// after every close. Unlike the old fixed-MULT version, purchase size, drop gap, and take-profit
// target all vary by level -- see the three functions below.

// Purchase size: x_1 = BASE, x_i = x_{i-1} * multForLevel(i) for i >= 2.
// Multiplier starts at ~1.662 (level 2) and decays toward 1 as levels increase -- aggressive
// early averaging-down without unbounded exponential growth.
export function multForLevel(i: number): number {
  return 1 + 0.66174 / (1 + 1.19508 * (i - 2));
}

// % drop from the last entry required to trigger level i (i >= 2). Starts at ~8.03%, widens
// slowly so real crash depth is required to keep stacking levels, capped at 50%.
export function dropPctForLevel(i: number): number {
  return Math.min(50, 0.0803073 * 100 * (1 + 0.0263671 * (i - 2)));
}

// % above blended average cost required to exit, as a function of the CURRENT level count i
// (i=1 means no DCA yet). Starts at ~1.52% and shrinks toward a 0.05% floor as levels stack --
// the deeper the rescue, the easier the eventual exit, which is what keeps cycles from getting
// stuck the way flat/fixed-multiplier sizing did.
export function tpPctForLevel(i: number): number {
  return Math.max(0.05, (0.0152177 * 100) / Math.pow(i, 0.539209));
}

// Bare historical worst case (9 levels) needs 25.3517x base -- zero cushion beyond exactly what
// was observed. Sized here at 35x instead, buying two extra levels of margin (survives a level 11
// event) at a real, quantified cost: 334.31% zero-commission historical ROI at 25.3517x drops to
// 189.76% at 35x. Raised from an initial 30x once external research showed 35x was the smallest
// reserve level with an explicit pass on BOTH stress-test axes (0/48 coefficient perturbation and
// 0/57 different-start-date tests) -- 30x had only been confirmed on the former, not the latter.
// See docs/hypertrade_formula_database.md for the full reserve-vs-ROI table and reasoning.
export const RESERVE_DIVISOR = 35;

export const SEED_USD = 500;
export const BASE_SIZE_USD = SEED_USD / RESERVE_DIVISOR; // ~$19.72 per level-1 entry, scales with balance (compounding)
