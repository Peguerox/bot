-- Worker 2 (hedge) volume-jump guard: 3-arm early release -- 2026-10-03.
-- Run in the Supabase SQL Editor.
-- Same feature as lighter_btc_initial_wiggle_release.sql, built for the hedge's two legs. Each
-- leg computes its own guard independently from its own candle feed (same as the ratio/pause
-- columns already added by lighter_hedge_volume_jump_guard.sql), so both state tables need the
-- release-mode override column; only the LONG leg (lighter_btc_optimal_state) publishes the
-- live wiggle/rate readouts for the dashboard panel, same "one owner" convention as everything
-- else shown there.
ALTER TABLE public.lighter_btc_optimal_state ADD COLUMN IF NOT EXISTS live_wiggle DOUBLE PRECISION;
ALTER TABLE public.lighter_btc_optimal_state ADD COLUMN IF NOT EXISTS live_volume_jump_rate DOUBLE PRECISION;
ALTER TABLE public.lighter_btc_optimal_state ADD COLUMN IF NOT EXISTS override_volume_jump_release_mode TEXT;

ALTER TABLE public.lighter_stoch_dca_btc_state ADD COLUMN IF NOT EXISTS override_volume_jump_release_mode TEXT;
