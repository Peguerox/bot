-- Profit-lock trail for Worker 1 (2026-09-27): once unrealized profit reaches
-- profit_lock_trigger_pct, tracks the peak unrealized % seen since arming; the moment it ticks
-- down at all from that peak, the position closes ("PROFIT_LOCK"). Persisted so an in-progress
-- trail survives a restart (Render restarts every service on any push).

alter table lighter_btc_initial_state
  add column if not exists profit_lock_peak_pct double precision;
