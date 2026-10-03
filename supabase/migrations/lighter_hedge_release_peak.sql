-- Worker 2 (hedge) volume-jump guard: release-target peak readout -- 2026-10-03.
-- Run in the Supabase SQL Editor.
-- Same feature as lighter_btc_initial_release_peak.sql. Only the LONG leg
-- (lighter_btc_optimal_state) publishes it, same "one owner" convention as everything else
-- shown on this panel.
ALTER TABLE public.lighter_btc_optimal_state ADD COLUMN IF NOT EXISTS live_volume_jump_release_peak DOUBLE PRECISION;
