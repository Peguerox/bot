-- Worker 1 volume/wiggle lock -- 2026-10-03. Run in the Supabase SQL Editor.
-- live_volume_wiggle_ratio: the lock's own reading (volume avg / intrabar dispersion), written
-- every tick regardless of whether the lock is enabled -- lets the panel show the number before
-- a threshold is even chosen. override_volume_wiggle_lock_threshold: NULL means "off" (no lock).
-- override_volume_wiggle_lock_enabled: a separate on/off switch so the lock can be disabled
-- without losing the configured threshold; NULL/true means on, false means off. See
-- BotConfig.volume_wiggle_lock_threshold / StochBot._update_volume_wiggle_lock.
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS live_volume_wiggle_ratio DOUBLE PRECISION;
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS override_volume_wiggle_lock_threshold DOUBLE PRECISION;
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS override_volume_wiggle_lock_enabled BOOLEAN;
