-- Profit-lock trail for Worker 2 (2026-09-27): same mechanism as
-- lighter_btc_initial_profit_lock.sql -- see that file's comment.

alter table lighter_btc_optimal_state
  add column if not exists profit_lock_peak_pct double precision;
