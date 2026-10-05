-- 2026-10-05, direct request: "put it in the measurements with the top volume and wiggle and
-- all that, the last one" -- adds the true alternation-counting zebra index
-- (compute_zebra_size_index: color flips over the last 5 candles / average candle size) as a
-- live readout next to ER/volume/wiggle/vol-wiggle/rate. Distinct from compute_color_weighted_
-- balance_index, which is the one actually gating Worker 1's entries today under the same
-- "zebra index" dashboard label. Display only -- drives no trading decision.
ALTER TABLE public.lighter_btc_initial_state
  ADD COLUMN IF NOT EXISTS live_schedule_zebra DOUBLE PRECISION;

ALTER TABLE public.lighter_btc_optimal_state
  ADD COLUMN IF NOT EXISTS live_schedule_zebra DOUBLE PRECISION;

ALTER TABLE public.lighter_stoch_dca_btc_state
  ADD COLUMN IF NOT EXISTS live_schedule_zebra DOUBLE PRECISION;
