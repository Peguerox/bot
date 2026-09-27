-- Profit-lock trail for Worker 3 (2026-09-27): same mechanism as
-- lighter_btc_initial_profit_lock.sql / lighter_btc_optimal_profit_lock.sql -- see that
-- comment. Worker 3 already runs profit_lock_enabled=True via in-process tracking; this
-- column just adds cross-restart persistence once run.

alter table lighter_stoch_dca_btc_state
  add column if not exists profit_lock_peak_pct double precision;
