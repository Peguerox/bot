-- Worker 1 volume-jump guard: release-target peak readout -- 2026-10-03.
-- Run in the Supabase SQL Editor.
-- Direct report: "I only see the timer... you need to put the volume at which it was paused" --
-- without this there's no way to tell a wiggle/volume/rate release is making real progress
-- versus just silently riding out the fixed pause. live_volume_jump_release_peak is the peak of
-- whichever metric override_volume_jump_release_mode currently selects; NULL when no arm is
-- selected or the guard isn't currently paused. See StochBot._update_volume_jump_guard.
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS live_volume_jump_release_peak DOUBLE PRECISION;
