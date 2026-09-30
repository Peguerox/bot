-- Worker 2 (hedge dual-leg) audit fixes -- 2026-09-30.
-- Run manually in the Supabase SQL Editor (no exec_sql RPC in this project, see CLAUDE.md).
--
-- Covers three separate findings from the audit of server/lighter_hedge_dual_leg.py. Safe to
-- re-run: every statement is idempotent.

-- ---------------------------------------------------------------------------------------------
-- 1. Clear stale per-position TP/SL bands (the money bug).
--
-- The hedge legs run with schema_has_position_bands=False, so they never WRITE these columns --
-- but stoch_bot_core.py read them anyway (now fixed). lighter_stoch_dca_btc_state still held
-- position_sl_pct = 0.090959884784963 from the retired Worker 3 joint-adaptive strategy that
-- owned this table before the hedge pivot, which gave the hedge SHORT leg a stop 3x wider than
-- its configured 0.03%. The code fix means these values can no longer be read, but they are
-- cleared here too so the rows stop lying about what the bot is doing.
UPDATE public.lighter_stoch_dca_btc_state
   SET position_tp_pct = NULL, position_sl_pct = NULL WHERE id = 1;
UPDATE public.lighter_btc_optimal_state
   SET position_tp_pct = NULL, position_sl_pct = NULL WHERE id = 1;

-- ---------------------------------------------------------------------------------------------
-- 2. Breakeven-floor support: snapshot of the partner leg's cumulative realized PnL, taken at
-- this leg's entry. The floor needs the partner's PnL for THIS cycle only (realized_now minus
-- this baseline), and it has to survive a Render restart mid-position, so it is persisted rather
-- than held in memory. NULL whenever this leg is flat.
ALTER TABLE public.lighter_btc_optimal_state
  ADD COLUMN IF NOT EXISTS cycle_partner_pnl_baseline DOUBLE PRECISION;
ALTER TABLE public.lighter_stoch_dca_btc_state
  ADD COLUMN IF NOT EXISTS cycle_partner_pnl_baseline DOUBLE PRECISION;

-- ---------------------------------------------------------------------------------------------
-- 3. Single-instance lock, same pattern the retired Bitfinex workers already used
-- (sol_dca_bitfinex_lock_columns.sql). Render does not stop the old container before starting the
-- new one, so on every deploy two copies of a worker are briefly alive and both can place a real
-- entry -- the "zombie double-entry" incident. A process only trades while it holds the lock on
-- its own state row.
ALTER TABLE public.lighter_btc_optimal_state
  ADD COLUMN IF NOT EXISTS lock_owner     TEXT,
  ADD COLUMN IF NOT EXISTS lock_heartbeat TIMESTAMPTZ;
ALTER TABLE public.lighter_stoch_dca_btc_state
  ADD COLUMN IF NOT EXISTS lock_owner     TEXT,
  ADD COLUMN IF NOT EXISTS lock_heartbeat TIMESTAMPTZ;

-- No RLS changes needed: both tables already have RLS enabled with an anon-read policy, and new
-- columns inherit it. Writes go through the service role key, which bypasses RLS.
