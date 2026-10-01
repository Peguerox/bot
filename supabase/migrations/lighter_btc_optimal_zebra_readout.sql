-- Hedge (Worker 2) live color-balance index readout -- 2026-10-01.
-- Run in the Supabase SQL Editor. The long leg (dashboard readout owner) writes the live
-- 5-candle color-weighted balance index here (same column name Worker 1 uses, live_zebra_index
-- -- it's a live readout column, not a semantic record) so the hedge panel can show what the
-- 50-or-below trend gate is actually seeing. Direct request after the gate was live with no
-- visible readout at all. Safe to re-run: idempotent.

ALTER TABLE public.lighter_btc_optimal_state
  ADD COLUMN IF NOT EXISTS live_zebra_index DOUBLE PRECISION;
