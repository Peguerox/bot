-- Non-destructive hedge reset. Run in Supabase SQL Editor before deploying the reset change.
-- Adds nullable columns only; does not reset balances, delete trades, or change enabled flags.
-- Existing state-table RLS policies cover the new columns. Safe to run again.
ALTER TABLE public.lighter_btc_optimal_state ADD COLUMN IF NOT EXISTS history_reset_at TIMESTAMPTZ;
ALTER TABLE public.lighter_stoch_dca_btc_state ADD COLUMN IF NOT EXISTS history_reset_at TIMESTAMPTZ;
