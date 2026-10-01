-- Worker 1 single-instance lock -- 2026-10-01.
-- Run manually in the Supabase SQL Editor (no exec_sql RPC in this project, see CLAUDE.md).
-- Render starts the new container before stopping the old one, so on every deploy two Worker 1
-- processes run for ~30-60s. On 2026-10-01 14:40 UTC both entered the same candle (real qty
-- 0.00234 vs 0.00117 intended) and the oversize guard had to emergency-flatten. With
-- single_instance_lock=True only the instance holding this lock may open new entries.
-- Safe to re-run: idempotent.

ALTER TABLE public.lighter_btc_initial_state
  ADD COLUMN IF NOT EXISTS lock_owner     TEXT,
  ADD COLUMN IF NOT EXISTS lock_heartbeat TIMESTAMPTZ;
