-- Hedge SL dwell, split into two independent settings -- 2026-10-08. Run in the Supabase SQL
-- Editor (after lighter_hedge_sl_dwell.sql, which adds override_sl_dwell_seconds).
-- Direct request: "we need to have dwelling for first leg and dwelling for second leg
-- split... maybe I want to put dwelling for the one leg and then not dwelling for the other
-- one." override_sl_dwell_seconds (existing column) keeps meaning "1st leg": applies BEFORE
-- either leg of a cycle has been cut. This new column is "2nd leg" (the survivor): applies
-- only to a leg's own SL AFTER its partner has already closed for the cycle, independently
-- tunable -- see StochBot._exit_params / BotConfig.survivor_sl_dwell_seconds in
-- stoch_bot_core.py for the full mechanism.
-- 0/NULL means instant (unchanged default), same contract as override_sl_dwell_seconds.
ALTER TABLE public.lighter_btc_optimal_state
  ADD COLUMN IF NOT EXISTS override_survivor_sl_dwell_seconds DOUBLE PRECISION;

ALTER TABLE public.lighter_stoch_dca_btc_state
  ADD COLUMN IF NOT EXISTS override_survivor_sl_dwell_seconds DOUBLE PRECISION;

-- RLS/anon-read policies already exist on both tables -- new column is covered automatically,
-- no new policy needed.
