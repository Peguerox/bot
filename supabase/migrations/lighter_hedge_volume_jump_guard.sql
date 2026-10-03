-- Worker 2 (hedge) volume-jump guard -- 2026-10-03.
-- Run in the Supabase SQL Editor.
-- Same guard as Worker 1 (lighter_btc_initial_volume_jump.sql /
-- lighter_btc_initial_volume_jump_paused_until.sql / lighter_btc_initial_volume_jump_clear.sql),
-- built for the hedge's two legs. Each leg computes its own ratio/pause independently from its
-- own candle feed (see StochBot._update_volume_jump_guard), so both state tables need the three
-- override columns; only the LONG leg (lighter_btc_optimal_state) publishes the live readout
-- columns for the dashboard panel, same "one owner" convention as ER15/Vol10.

ALTER TABLE public.lighter_btc_optimal_state ADD COLUMN IF NOT EXISTS live_volume_jump_ratio DOUBLE PRECISION;
ALTER TABLE public.lighter_btc_optimal_state ADD COLUMN IF NOT EXISTS live_volume_jump_paused_until TIMESTAMPTZ;
ALTER TABLE public.lighter_btc_optimal_state ADD COLUMN IF NOT EXISTS override_volume_jump_ratio DOUBLE PRECISION;
ALTER TABLE public.lighter_btc_optimal_state ADD COLUMN IF NOT EXISTS override_volume_jump_pause_seconds DOUBLE PRECISION;
ALTER TABLE public.lighter_btc_optimal_state ADD COLUMN IF NOT EXISTS override_volume_jump_cleared_at TIMESTAMPTZ;

ALTER TABLE public.lighter_stoch_dca_btc_state ADD COLUMN IF NOT EXISTS override_volume_jump_ratio DOUBLE PRECISION;
ALTER TABLE public.lighter_stoch_dca_btc_state ADD COLUMN IF NOT EXISTS override_volume_jump_pause_seconds DOUBLE PRECISION;
ALTER TABLE public.lighter_stoch_dca_btc_state ADD COLUMN IF NOT EXISTS override_volume_jump_cleared_at TIMESTAMPTZ;
