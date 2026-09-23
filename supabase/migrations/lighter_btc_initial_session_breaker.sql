-- Adds the session drawdown breaker to Worker 1 (never migrated before -- Worker 1 is getting
-- the "smart resume" version: direction + volatility gated, not just a fixed cooldown).
alter table lighter_btc_initial_state
  add column if not exists session_breaker_session_start timestamptz,
  add column if not exists session_breaker_baseline_pnl double precision,
  add column if not exists session_breaker_peak_pnl double precision,
  add column if not exists session_breaker_paused boolean,
  add column if not exists session_breaker_paused_at timestamptz,
  add column if not exists session_breaker_trip_direction text,
  add column if not exists session_breaker_next_check_at timestamptz;
