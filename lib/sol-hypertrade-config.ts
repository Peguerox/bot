// Single source of truth for the SOL hypertrading paper strategy -- imported by both
// server/sol-hypertrade-paper.ts (the paper worker) and app/page.tsx (the dashboard panel).
//
// Chosen via a 2-year, 24-window worst-case comparison across SOL/BTC/ETH (all on Bitfinex,
// 1.1x/1%-DCA/0.2%-TP config): SOL won on both average monthly ROI (+3.8%) and capital
// efficiency (537.6x worst-case reserve, tied-lowest of the three). See conversation history
// for the full sweep. This is a continuous-grid strategy (no directional entry signal) with
// flat-plus-margin DCA sizing: each rescue add is MULT times the previous add's size.
export const DCA_STEP_PCT = 1;
export const MULT = 1.1;
export const TP_PCT = 0.2;

// Reference depth used only to size the paper bot's base unit against SEED_USD -- the ladder
// itself is NOT capped at this depth. The whole point of running this as a paper bot with
// unlimited sizing is to observe the *real* worst-case depth against live execution, which may
// turn out deeper or shallower than this reference.
const REFERENCE_LEVELS = 10;
export const RESERVE_DIVISOR = (MULT ** REFERENCE_LEVELS - 1) / (MULT - 1); // ~15.94

export const SEED_USD = 500;
export const BASE_SIZE_USD = SEED_USD / RESERVE_DIVISOR; // ~$31.37 per level-1 entry
