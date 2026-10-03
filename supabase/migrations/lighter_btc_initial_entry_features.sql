-- Worker 1 entry-feature snapshot -- 2026-10-03.
-- Run in the Supabase SQL Editor.
-- Worker 1 never had this at all (the hedge legs have had entry_k/entry_balance_index/
-- entry_vol_pct/entry_dispersion since 2026-10-01 -- see lighter_hedge_entry_features.sql).
-- Same mechanism: on every entry, the stochastic K, color-weighted balance index, 10-min
-- volatility and 5-bar dispersion are recorded onto the state row, then copied onto the trade
-- row when the position closes. Purely descriptive, drives no bot decision.
--
-- entry_settings_snapshot (new, both Worker 1 and the hedge -- see
-- lighter_hedge_entry_settings_snapshot.sql): direct request ("make sure we are collecting all
-- that data... what settings won for what conditions"). One small JSON object per trade,
-- recording the exit settings (exit_mode, sl/tp/trigger/trail/dwell) and the volume-jump guard's
-- settings + live ratio reading, all exactly as they were at the moment this trade opened. See
-- StochBot._entry_settings_snapshot's docstring for the exact fields.
--
-- Safe to re-run: idempotent.

ALTER TABLE public.lighter_btc_initial_state
  ADD COLUMN IF NOT EXISTS entry_k                    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS entry_balance_index         DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS entry_vol_pct               DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS entry_dispersion            DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS entry_settings_snapshot     JSONB;

ALTER TABLE public.lighter_btc_initial_trades
  ADD COLUMN IF NOT EXISTS entry_k                    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS entry_balance_index         DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS entry_vol_pct               DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS entry_dispersion            DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS entry_settings_snapshot     JSONB;

-- No RLS changes needed: both tables already have RLS enabled with an anon-read policy, and new
-- columns inherit it. Writes go through the worker's own Supabase service role key.
