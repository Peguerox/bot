-- Worker 1: dwell (requires an exit touch to hold, not just happen once) -- 2026-10-03.
-- Run in the Supabase SQL Editor.
-- Direct request ("a dwell strategy... used in both fixed TP and trail"). Requires the TP level
-- (in exit_mode "tp") or the trail's pullback (in exit_mode "trail") to stay continuously true
-- for override_dwell_seconds before actually closing -- not a replacement for exit_mode, an
-- add-on that works with either. NULL/0 is instant, the exact behavior before this existed. SL
-- is never delayed. See StochBot._exit_params / _dwell_ready, and
-- research/codex-worker2/quiet_exit_study/dwell_test.py for the backing research (mixed: cuts
-- whipsaw on both mechanisms, hasn't beaten the plain no-dwell candidate yet).
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS override_dwell_seconds DOUBLE PRECISION;
