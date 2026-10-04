-- Hedge volume/wiggle lock -- 2026-10-03. Run in the Supabase SQL Editor.
-- Same mechanism as lighter_btc_initial_volume_wiggle_lock.sql. Only the LONG leg
-- (lighter_btc_optimal_state) publishes the live reading, same convention as
-- live_wiggle/live_volume_jump_rate/live_volume_jump_release_peak -- the dashboard reads one
-- leg's row for the shared readout. Both legs get the override columns so each instance's own
-- tick() can read its own state row (StochBot._update_volume_wiggle_lock), same reason both legs
-- always carry identical guard overrides.
ALTER TABLE public.lighter_btc_optimal_state ADD COLUMN IF NOT EXISTS live_volume_wiggle_ratio DOUBLE PRECISION;
ALTER TABLE public.lighter_btc_optimal_state ADD COLUMN IF NOT EXISTS override_volume_wiggle_lock_threshold DOUBLE PRECISION;
ALTER TABLE public.lighter_btc_optimal_state ADD COLUMN IF NOT EXISTS override_volume_wiggle_lock_enabled BOOLEAN;

ALTER TABLE public.lighter_stoch_dca_btc_state ADD COLUMN IF NOT EXISTS override_volume_wiggle_lock_threshold DOUBLE PRECISION;
ALTER TABLE public.lighter_stoch_dca_btc_state ADD COLUMN IF NOT EXISTS override_volume_wiggle_lock_enabled BOOLEAN;
