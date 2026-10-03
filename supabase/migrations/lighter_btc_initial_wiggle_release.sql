-- Worker 1 volume-jump guard: 3-arm early release -- 2026-10-03.
-- Run in the Supabase SQL Editor.
-- Direct request ("build them both... volume, wiggle, or rate"). live_wiggle and
-- live_volume_jump_rate are readouts of the two new comparison metrics (dispersion and signed
-- volume rate-of-change), shown next to the existing live_volume_jump_ratio regardless of
-- which arm is selected. override_volume_jump_release_mode picks the controlling arm live:
-- NULL (default) keeps the plain fixed-timer pause, or 'volume'/'wiggle'/'rate'. See
-- StochBot._update_volume_jump_guard's docstring for the full reasoning.
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS live_wiggle DOUBLE PRECISION;
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS live_volume_jump_rate DOUBLE PRECISION;
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS override_volume_jump_release_mode TEXT;
