-- Hedge 2-hour efficiency-ratio readout -- 2026-10-04. Run in the Supabase SQL Editor.
-- Same mechanism as Worker 1's (lighter_btc_initial_er_2h.sql) -- the LONG leg already has
-- schema_has_live_signal=True (lighter_hedge_dual_leg.py), so it's already computing this on
-- every tick; it just needs somewhere to write it. Only the LONG leg publishes, same convention
-- as every other shared hedge readout (ER15/Vol10/wiggle/jump-guard).
ALTER TABLE public.lighter_btc_optimal_state ADD COLUMN IF NOT EXISTS live_er_2h DOUBLE PRECISION;
ALTER TABLE public.lighter_btc_optimal_state ADD COLUMN IF NOT EXISTS live_er_2h_direction TEXT;
