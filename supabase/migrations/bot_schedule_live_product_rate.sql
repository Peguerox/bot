-- 2026-10-07, direct request: "product rate... puts 3 variables instead of 2" -- a new schedule
-- condition/readout, change in (volume_avg * wiggle) between the latest closed candle and the
-- one before it (see compute_product_rate in server/stoch_bot_core.py). Backtested against real
-- Worker 1 trades as a better predictor than the existing plain volume rate (matched-n
-- comparison: 71.0% win / +$0.285 net vs 67.6% win / -$0.413 net on volume_rate). Display +
-- rule-condition only -- drives no trading decision on its own, same contract as every other
-- live_schedule_* column.
ALTER TABLE public.lighter_btc_initial_state
  ADD COLUMN IF NOT EXISTS live_schedule_product_rate DOUBLE PRECISION;

ALTER TABLE public.lighter_btc_optimal_state
  ADD COLUMN IF NOT EXISTS live_schedule_product_rate DOUBLE PRECISION;

ALTER TABLE public.lighter_stoch_dca_btc_state
  ADD COLUMN IF NOT EXISTS live_schedule_product_rate DOUBLE PRECISION;

-- RLS/anon-read policies already exist on all three tables -- new column is covered
-- automatically, no new policy needed.
