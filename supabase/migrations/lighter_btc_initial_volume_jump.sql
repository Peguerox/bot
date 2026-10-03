-- Worker 1 volume-jump guard -- 2026-10-02. Run in the Supabase SQL Editor.
-- live_volume_jump_ratio: the guard's own reading, written every ~10s regardless of whether
-- the guard is enabled. override_volume_jump_ratio/pause_seconds: live overrides, NULL means
-- "use the compiled default". See BotConfig.volume_jump_ratio / StochBot._update_volume_jump_guard.
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS live_volume_jump_ratio DOUBLE PRECISION;
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS override_volume_jump_ratio DOUBLE PRECISION;
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS override_volume_jump_pause_seconds DOUBLE PRECISION;
