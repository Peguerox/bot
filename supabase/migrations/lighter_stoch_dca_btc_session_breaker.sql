-- Persists the session drawdown breaker's state so a restart (deploy, crash, Render's own
-- redeploy on any git push -- including unrelated frontend-only changes, which has already
-- wiped an active cooldown twice in production) doesn't silently re-arm trading mid-pause.
alter table lighter_stoch_dca_btc_state
  add column if not exists session_breaker_session_start timestamptz,
  add column if not exists session_breaker_baseline_pnl double precision,
  add column if not exists session_breaker_peak_pnl double precision,
  add column if not exists session_breaker_paused boolean,
  add column if not exists session_breaker_paused_at timestamptz;
