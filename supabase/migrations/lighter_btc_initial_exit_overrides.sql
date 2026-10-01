-- Worker 1 manual exit levers -- 2026-10-01. Same columns as the hedge's
-- lighter_hedge_manual_exit_levers.sql. Run manually in the Supabase SQL Editor.
-- Seeded with Worker 1's current config values (SL 0.11 / trigger 0.05 / trail 0) so nothing
-- changes on deploy. live_vol_pct is the volatility readout the worker writes alongside live_k.
-- Safe to re-run: idempotent.

ALTER TABLE public.lighter_btc_initial_state
  ADD COLUMN IF NOT EXISTS override_sl_pct              DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS override_profit_lock_trigger DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS override_profit_lock_trail   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS live_vol_pct                 DOUBLE PRECISION;

UPDATE public.lighter_btc_initial_state
   SET override_sl_pct = COALESCE(override_sl_pct, 0.11),
       override_profit_lock_trigger = COALESCE(override_profit_lock_trigger, 0.05),
       override_profit_lock_trail = COALESCE(override_profit_lock_trail, 0.0)
 WHERE id = 1;
