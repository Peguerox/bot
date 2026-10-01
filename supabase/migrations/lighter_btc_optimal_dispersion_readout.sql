-- Hedge (Worker 2) intrabar dispersion live readout -- 2026-10-01.
-- Run manually in the Supabase SQL Editor (no exec_sql RPC in this project, see CLAUDE.md).
-- The long leg (dashboard readout owner) writes the live 5-bar dispersion here so the hedge panel
-- can show what min_intrabar_dispersion_to_enter is seeing. Safe to re-run: idempotent.

ALTER TABLE public.lighter_btc_optimal_state
  ADD COLUMN IF NOT EXISTS live_intrabar_dispersion DOUBLE PRECISION;

-- No RLS changes needed: existing anon-read policy covers new columns.
