// Single source of truth for the SOL DCA-martingale strategy's parameters — imported by both
// server/sol-dca-bitfinex.ts (the live worker) and app/page.tsx (the dashboard panel), so the
// two can never drift apart the way the panel's hardcoded seed/trail % did before this file
// existed (see BOT_BUGS_CHECKLIST.md #3, "dashboard drift after a numeric config change").
//
// Chosen via a 12-window cross-validation (3 exchanges x 4 non-overlapping quarters, 2yr SOL
// 5-min data) ranked by WORST-CASE ROI across all 12, not average -- the config that looked best
// on fewer/coarser splits (6%/2.0x/1.5%TP/2.5%trail, the previous live config) turned out to have
// a $255k worst-case capital requirement once a genuinely bad quarter (Binance US, most recent)
// was in the test set. This config's worst case across the same 12 windows is $49,258 (5.2x
// less) with better worst-case ROI (+6.8% vs +2.2%).
export const DCA_DROP_PCT    = 10;
export const MULT            = 1.5;
export const TP_PCT          = 3;
export const TRAIL_PCT       = 1;

// Worst-case DCA depth seen across all 12 cross-validation windows was 8 levels. Reserve divisor
// is the geometric sum 1 + MULT + MULT^2 + ... + MULT^(LEVELS-1), i.e. the total capital needed
// if every level from 1 to LEVELS fires — this is the denominator new trades are sized against
// (balance / RESERVE_DIVISOR = level-1 size) so the account never needs more than `balance` to
// survive the worst case seen in backtesting.
const MAX_DCA_LEVELS = 8;
export const RESERVE_DIVISOR = (MULT ** MAX_DCA_LEVELS - 1) / (MULT - 1); // ≈ 49.26

export const SEED_USD = 500;
