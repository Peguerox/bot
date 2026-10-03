-- Worker 1 volume-jump guard: explicit "paused until" readout -- 2026-10-03.
-- Run in the Supabase SQL Editor.
-- Direct request ("it does not tell me if armed not armed") -- the instant ratio reading
-- (live_volume_jump_ratio, from the earlier migration) can read calm while an earlier spike's
-- pause is still active; this column makes that state explicit. NULL = not currently paused.
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS live_volume_jump_paused_until TIMESTAMPTZ;
