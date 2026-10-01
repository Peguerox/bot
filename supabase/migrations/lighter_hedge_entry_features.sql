-- Worker 2 (hedge) entry-feature snapshot -- 2026-10-01.
-- Run manually in the Supabase SQL Editor (no exec_sql RPC in this project, see CLAUDE.md).
--
-- On every entry, each leg now records what the stochastic K, the color-weighted balance index,
-- 10-min volatility, and 5-bar dispersion read at that exact moment -- onto the state row at
-- entry, then onto the trade row when the position closes. Purely descriptive (hover on the
-- dashboard to review); drives no bot decision. See BotConfig.schema_has_entry_features.
--
-- Safe to re-run: idempotent.

ALTER TABLE public.lighter_btc_optimal_state
  ADD COLUMN IF NOT EXISTS entry_k              DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS entry_balance_index   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS entry_vol_pct         DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS entry_dispersion      DOUBLE PRECISION;

ALTER TABLE public.lighter_btc_optimal_trades
  ADD COLUMN IF NOT EXISTS entry_k              DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS entry_balance_index   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS entry_vol_pct         DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS entry_dispersion      DOUBLE PRECISION;

ALTER TABLE public.lighter_stoch_dca_btc_state
  ADD COLUMN IF NOT EXISTS entry_k              DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS entry_balance_index   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS entry_vol_pct         DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS entry_dispersion      DOUBLE PRECISION;

ALTER TABLE public.lighter_stoch_dca_btc_trades
  ADD COLUMN IF NOT EXISTS entry_k              DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS entry_balance_index   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS entry_vol_pct         DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS entry_dispersion      DOUBLE PRECISION;

-- No RLS changes needed: both tables already have RLS enabled with an anon-read policy, and
-- new columns inherit it. Writes go through the worker's own Supabase service role key.
