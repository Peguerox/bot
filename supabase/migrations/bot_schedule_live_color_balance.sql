-- 2026-10-05, direct request: "put the color bar zebra and all that in the rules panel so we
-- can select depending on those too." Adds a universal color-balance reading
-- (compute_color_weighted_balance_index) alongside the other live_schedule_* fields, published
-- by every bot every tick regardless of that bot's own entry-gate config. Replaces reliance on
-- live_zebra_index for this purpose, which only Worker 1 ever wrote (gated behind its own
-- color_balance_index_min/max being set -- the hedge has neither configured, so it never had a
-- live reading there at all).
ALTER TABLE public.lighter_btc_initial_state
  ADD COLUMN IF NOT EXISTS live_schedule_color_balance DOUBLE PRECISION;

ALTER TABLE public.lighter_btc_optimal_state
  ADD COLUMN IF NOT EXISTS live_schedule_color_balance DOUBLE PRECISION;

ALTER TABLE public.lighter_stoch_dca_btc_state
  ADD COLUMN IF NOT EXISTS live_schedule_color_balance DOUBLE PRECISION;
