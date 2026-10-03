-- Worker 1 volume-jump guard: manual "clear pause" button -- 2026-10-03.
-- Run in the Supabase SQL Editor.
-- Direct request ("give me a button to unpause"). If the last-armed spike is at or before
-- this marker, the pause reads inactive -- a genuinely new spike after the clear still arms
-- normally (it only forgives the past, never disables the guard going forward). See
-- StochBot._update_volume_jump_guard.
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS override_volume_jump_cleared_at TIMESTAMPTZ;
