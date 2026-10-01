-- Self-lock: lock_via column -- 2026-10-01.
-- Run manually in the Supabase SQL Editor (no exec_sql RPC in this project, see CLAUDE.md).
--
-- Tracks what caused the CURRENT self-lock ("real_sl", "hour_open", "boot", "enabled_toggle"),
-- so BotConfig.self_lock_hour_open_requires_tp can demand a literal TP to unlock specifically
-- when an hour-open relock caused the lock, without changing the easier "2 wins of any kind"
-- rule for an ordinary real-SL lock. See stoch_bot_core.py's docstring on that field.
--
-- Safe to re-run: idempotent.

ALTER TABLE public.lighter_btc_initial_state
  ADD COLUMN IF NOT EXISTS lock_via TEXT;
ALTER TABLE public.lighter_stoch_dca_btc_state
  ADD COLUMN IF NOT EXISTS lock_via TEXT;

-- No RLS changes needed: both tables already have RLS enabled with an anon-read policy, and new
-- columns inherit it. Writes go through the service role key, which bypasses RLS.
