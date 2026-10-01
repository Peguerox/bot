-- Worker 1 reset cutoff -- 2026-10-01.
-- Run manually in the Supabase SQL Editor (no exec_sql RPC in this project, see CLAUDE.md).
--
-- Worker 1's "reset" has always been non-destructive: trade rows stay in
-- lighter_btc_initial_trades forever (audit trail), and the dashboard just hides everything
-- before a cutoff timestamp. That cutoff used to live ONLY as a hardcoded constant in
-- app/page.tsx (WORKER1_RESET_AT), bumped by hand on every reset. This moves it into the
-- database so the new Reset button can set it itself, no code deploy needed per reset.
--
-- Safe to re-run: idempotent.

ALTER TABLE public.lighter_btc_initial_state
  ADD COLUMN IF NOT EXISTS history_reset_at TIMESTAMPTZ;

-- No RLS changes needed: the table already has RLS enabled with an anon-read policy, and new
-- columns inherit it. Writes go through the service role key, which bypasses RLS.
