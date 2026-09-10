// Single source of truth for the SOL DCA-martingale strategy's parameters — imported by both
// server/sol-dca-bitfinex.ts (the live worker) and app/page.tsx (the dashboard panel), so the
// two can never drift apart the way the panel's hardcoded seed/trail % did before this file
// existed (see BOT_BUGS_CHECKLIST.md #3, "dashboard drift after a numeric config change").
export const DCA_DROP_PCT    = 6;
export const MULT            = 2.0;
export const TP_PCT          = 1.5;
export const TRAIL_PCT       = 2.5;
export const RESERVE_DIVISOR = 31; // 1+2+4+8+16 — 5-level reserve at 2.0x
export const SEED_USD        = 500;
