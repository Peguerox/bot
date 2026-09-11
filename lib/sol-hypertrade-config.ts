// Single source of truth for the SOL hypertrading paper strategy -- imported by both
// server/sol-hypertrade-paper.ts (the paper worker) and app/page.tsx (the dashboard panel).
//
// VARIABLE-RATE FORMULA (replaces the earlier fixed-multiplier version) -- see
// docs/hypertrade_variable_rate_formula_ORIGINAL.md for the full derivation and problem
// write-up this was produced from. Independently re-verified against our own 1-min OHLC engine
// on both Binance Global (full ~5yr) and Bitfinex (~2yr): max level ever reached was 9 on both,
// real reserve needed $2,535.17 per $100 base bet, zero cycles ever closed at a realized loss.
// Binance US (deliberately excluded from sizing decisions -- known liquidity problems) needed
// 26 levels / $12,981 in the same test, so this is NOT assumed to hold everywhere; it's the
// two exchanges we trust.
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

// Empirically verified worst-case reserve: $2,535.17 needed per $100 base bet (9 levels, cross-
// validated on Binance Global 5yr + Bitfinex 2yr). This is the real number, not a reference
// assumption -- unlike the old config, there's no "unlimited, we'll find out" framing needed
// here since we already found it.
export const RESERVE_DIVISOR = 2535.17 / 100; // ~25.3517

export const SEED_USD = 500;
export const BASE_SIZE_USD = SEED_USD / RESERVE_DIVISOR; // ~$19.72 per level-1 entry, scales with balance (compounding)
