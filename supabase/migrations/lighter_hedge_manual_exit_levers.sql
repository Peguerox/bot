-- Manual exit levers + live volatility readout for the Worker 2 hedge -- 2026-09-30.
-- Run in the Supabase SQL Editor. Idempotent, safe to re-run.
--
-- Purpose: volatility on 2026-09-30 ranged from 0.0195% (calm) to 0.1945% (US open) -- a 10x
-- spread -- and no single stop-loss is right across that. Until an adaptive rule is derived from
-- data, these columns let the exits be tuned from the dashboard without a code deploy, so the
-- best setting per volatility regime can be found by observation.
--
-- All three override columns are NULL by default, which means "use the value compiled into
-- BotConfig". Only a non-NULL value overrides. Both legs MUST always carry identical values --
-- unequal exits between the legs break the breakeven floor -- so the API route writes both rows
-- together and never one alone.

ALTER TABLE public.lighter_btc_optimal_state
  ADD COLUMN IF NOT EXISTS live_vol_pct                 DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS override_sl_pct              DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS override_profit_lock_trigger DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS override_profit_lock_trail   DOUBLE PRECISION;

ALTER TABLE public.lighter_stoch_dca_btc_state
  ADD COLUMN IF NOT EXISTS live_vol_pct                 DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS override_sl_pct              DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS override_profit_lock_trigger DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS override_profit_lock_trail   DOUBLE PRECISION;

-- Seed the overrides with the values currently compiled in, so the dashboard shows real numbers
-- immediately rather than blanks, and so the first nudge steps from the live setting.
UPDATE public.lighter_btc_optimal_state
   SET override_sl_pct = COALESCE(override_sl_pct, 0.06),
       override_profit_lock_trigger = COALESCE(override_profit_lock_trigger, 0.10),
       override_profit_lock_trail = COALESCE(override_profit_lock_trail, 0.03)
 WHERE id = 1;
UPDATE public.lighter_stoch_dca_btc_state
   SET override_sl_pct = COALESCE(override_sl_pct, 0.06),
       override_profit_lock_trigger = COALESCE(override_profit_lock_trigger, 0.10),
       override_profit_lock_trail = COALESCE(override_profit_lock_trail, 0.03)
 WHERE id = 1;

-- New columns inherit the existing RLS + anon-read policy; writes go through the service role key.
