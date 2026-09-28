-- Joint adaptive formula (2026-09-28): all five parameters (window, K thresholds, TP, SL,
-- reversal blanking) move continuously with volatility. joint_adaptive_last persists the live
-- formula reading for the dashboard; position_blank_seconds persists the reversal-blanking
-- value frozen at the currently open position's entry (mirrors position_tp_pct/position_sl_pct,
-- which already exist on this table from the earlier regime-switch era).

alter table lighter_stoch_dca_btc_state
  add column if not exists joint_adaptive_last jsonb,
  add column if not exists position_blank_seconds double precision;
