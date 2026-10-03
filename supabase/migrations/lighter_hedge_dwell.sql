-- Worker 2 (hedge): dwell -- 2026-10-03.
-- Run in the Supabase SQL Editor.
-- Same feature as lighter_btc_initial_dwell.sql. Each leg reads its own row independently
-- (same as every other exit override here), so both tables need the column.
ALTER TABLE public.lighter_btc_optimal_state ADD COLUMN IF NOT EXISTS override_dwell_seconds DOUBLE PRECISION;
ALTER TABLE public.lighter_stoch_dca_btc_state ADD COLUMN IF NOT EXISTS override_dwell_seconds DOUBLE PRECISION;
