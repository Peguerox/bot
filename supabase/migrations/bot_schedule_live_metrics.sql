-- 2026-10-05, bug fix: the Master Schedule panel's "Currently governing" box was reading
-- Worker 1's own live_candle_volume/live_wiggle columns for BOTH bots, because the hedge never
-- published its own volume/wiggle anywhere. Whenever Worker 1 was off and only the hedge was
-- live, the panel showed whichever rule matched Worker 1's (stale/irrelevant) numbers instead
-- of the rule the hedge was actually running under.
--
-- These columns publish the exact ER/volume/wiggle/rate/vol-wiggle numbers
-- StochBot._apply_schedule_rules just matched against, written by whichever bot has
-- BotConfig.schema_has_schedule_metrics=True (Worker 1 and both hedge legs). Display only --
-- drives no trading decision, same contract as every other live_* readout.
ALTER TABLE public.lighter_btc_initial_state
  ADD COLUMN IF NOT EXISTS live_schedule_er DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS live_schedule_volume DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS live_schedule_wiggle DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS live_schedule_rate DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS live_schedule_vol_wiggle_ratio DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS live_schedule_vol_wiggle_product DOUBLE PRECISION;

ALTER TABLE public.lighter_btc_optimal_state
  ADD COLUMN IF NOT EXISTS live_schedule_er DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS live_schedule_volume DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS live_schedule_wiggle DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS live_schedule_rate DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS live_schedule_vol_wiggle_ratio DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS live_schedule_vol_wiggle_product DOUBLE PRECISION;

ALTER TABLE public.lighter_stoch_dca_btc_state
  ADD COLUMN IF NOT EXISTS live_schedule_er DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS live_schedule_volume DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS live_schedule_wiggle DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS live_schedule_rate DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS live_schedule_vol_wiggle_ratio DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS live_schedule_vol_wiggle_product DOUBLE PRECISION;

-- RLS/anon-read policies already exist on all three tables -- new columns are covered
-- automatically, no new policy needed.
