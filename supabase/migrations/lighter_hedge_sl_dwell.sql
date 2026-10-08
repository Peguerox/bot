-- Hedge SL dwell -- 2026-10-08. Run in the Supabase SQL Editor.
-- Direct request, backed by a real-tick test: of 61 real SL-closed hedge legs (Rules 6/7),
-- 27 (44%) would NOT have closed yet if given a 10-second continuous-touch confirmation window
-- before acting on the stop -- the same sl_dwell_seconds mechanism Worker 1 already uses
-- (direct request there too, "lets do 30 seconds"). The underlying mechanism in
-- stoch_bot_core.py (_exit_params / _sl_dwell_ready) is already generic across every bot with
-- schema_has_exit_overrides=True, which both hedge legs already have -- this migration is the
-- only piece that was missing; no code change needed beyond the dashboard field.
-- override_sl_dwell_seconds: 0/NULL means instant (unchanged default), same as Worker 1's.
ALTER TABLE public.lighter_btc_optimal_state
  ADD COLUMN IF NOT EXISTS override_sl_dwell_seconds DOUBLE PRECISION;

ALTER TABLE public.lighter_stoch_dca_btc_state
  ADD COLUMN IF NOT EXISTS override_sl_dwell_seconds DOUBLE PRECISION;

-- RLS/anon-read policies already exist on both tables -- new column is covered automatically,
-- no new policy needed.
