-- Worker 2 (hedge dual-leg) cycle_id -- 2026-10-01.
-- Run manually in the Supabase SQL Editor (no exec_sql RPC in this project, see CLAUDE.md).
--
-- Lets both legs stamp the SAME id (the cycle barrier's release instant) onto their entry and
-- carry it to their close, so the dashboard can pair a cycle's two rows by id instead of
-- guessing from opened_at proximity -- a guess a slow confirm/retry on one leg can blow past,
-- splitting one real cycle into two unpaired single-leg rows. See
-- BotConfig.schema_has_cycle_id in server/stoch_bot_core.py.
--
-- Safe to re-run: every statement is idempotent.

ALTER TABLE public.lighter_btc_optimal_state
  ADD COLUMN IF NOT EXISTS cycle_id TEXT;
ALTER TABLE public.lighter_stoch_dca_btc_state
  ADD COLUMN IF NOT EXISTS cycle_id TEXT;

ALTER TABLE public.lighter_btc_optimal_trades
  ADD COLUMN IF NOT EXISTS cycle_id TEXT;
ALTER TABLE public.lighter_stoch_dca_btc_trades
  ADD COLUMN IF NOT EXISTS cycle_id TEXT;

-- No RLS changes needed: both tables already have RLS enabled with an anon-read policy, and new
-- columns inherit it. Writes go through the service role key, which bypasses RLS.
