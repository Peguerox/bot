-- Worker 1 intrabar dispersion live readout -- 2026-10-01.
-- Run manually in the Supabase SQL Editor (no exec_sql RPC in this project, see CLAUDE.md).
--
-- Stores the live stdev((high+low)/2) reading over the trailing 5 bars, so the dashboard panel
-- can show what the intrabar_dispersion_pause_at gate is actually seeing right now, same
-- pattern as live_k/live_signal. See compute_intrabar_dispersion in stoch_bot_core.py.
--
-- Safe to re-run: idempotent.

ALTER TABLE public.lighter_btc_initial_state
  ADD COLUMN IF NOT EXISTS live_intrabar_dispersion DOUBLE PRECISION;

-- No RLS changes needed: the table already has RLS enabled with an anon-read policy, and new
-- columns inherit it. Writes go through the service role key, which bypasses RLS.
