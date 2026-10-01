-- Worker 1 live zebra / candle-size index readout -- 2026-10-01. Run in the Supabase SQL Editor.
-- Written every ~10s with live_k so the panel can show what the 600-1000 entry band is reading.
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS live_zebra_index DOUBLE PRECISION;
