-- Worker 1 higher-timeframe stochastic alignment block -- 2026-10-09. Run in the Supabase SQL
-- Editor. Direct request after a real-data study (449 real trades): blocks a fresh entry when
-- the longer-timeframe stochastic AGREES with the 1-minute signal about to fire -- found
-- backwards from intuition (alignment meant WORSE outcomes). Off by default (no timeframe
-- selected); live-selectable among '5m' / '10m' / '1h' from the dashboard.
ALTER TABLE public.lighter_btc_initial_state
  ADD COLUMN IF NOT EXISTS override_htf_alignment_block_timeframe TEXT,
  ADD COLUMN IF NOT EXISTS live_htf_k DOUBLE PRECISION;

-- RLS/anon-read policy already exists on this table -- new columns are covered automatically,
-- no new policy needed.
