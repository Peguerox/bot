-- Worker 1 wiggle/vol rise exit -- 2026-10-09. Run in the Supabase SQL Editor.
-- Direct request after a real-trade audit: "first you dont go in if your wiggle/volume is 3
-- then you come out the moment your wiggle volume goes up by 10%". Checked on a 16-trade real
-- window: all 5 real SL losses showed wig/vol rising from entry to close (17% to 369%); 9 of
-- 11 real wins showed it falling. The ENTRY half ("dont go in if less than 3") already exists
-- as override_volume_wiggle_lock_threshold/override_volume_wiggle_lock_enabled -- no migration
-- needed there, just set threshold=3 and enabled=true from the dashboard. This migration adds
-- only the NEW exit half: closes a position the moment its own wig/vol ratio rises by this many
-- percent relative to its own reading at entry (captured per-position, in-process).
-- NULL (default) is off. A SEPARATE boolean (override_wiggle_vol_rise_exit_enabled) lets the
-- switch flip off without losing the configured percentage, same pattern as every other
-- paired threshold/enabled control in this file.
ALTER TABLE public.lighter_btc_initial_state
  ADD COLUMN IF NOT EXISTS override_wiggle_vol_rise_exit_pct DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS override_wiggle_vol_rise_exit_enabled BOOLEAN;

-- RLS/anon-read policy already exists on this table -- new columns are covered automatically,
-- no new policy needed.
