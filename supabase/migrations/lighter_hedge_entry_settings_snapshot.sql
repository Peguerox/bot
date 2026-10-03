-- Worker 2 (hedge) entry-settings snapshot -- 2026-10-03.
-- Run in the Supabase SQL Editor.
-- Direct request ("make sure we are collecting all that data... what settings won for what
-- conditions"). The hedge already has entry_k/entry_balance_index/entry_vol_pct/
-- entry_dispersion (lighter_hedge_entry_features.sql); this adds one more small JSON object per
-- trade, recording the exit settings (exit_mode, sl/tp/trigger/trail/dwell) and the
-- volume-jump guard's settings + live ratio reading, all exactly as they were at the moment
-- this trade opened. Kept to one JSONB column deliberately, not a dozen new flat ones. See
-- StochBot._entry_settings_snapshot's docstring for the exact fields.
--
-- Safe to re-run: idempotent.

ALTER TABLE public.lighter_btc_optimal_state  ADD COLUMN IF NOT EXISTS entry_settings_snapshot JSONB;
ALTER TABLE public.lighter_btc_optimal_trades ADD COLUMN IF NOT EXISTS entry_settings_snapshot JSONB;

ALTER TABLE public.lighter_stoch_dca_btc_state  ADD COLUMN IF NOT EXISTS entry_settings_snapshot JSONB;
ALTER TABLE public.lighter_stoch_dca_btc_trades ADD COLUMN IF NOT EXISTS entry_settings_snapshot JSONB;
