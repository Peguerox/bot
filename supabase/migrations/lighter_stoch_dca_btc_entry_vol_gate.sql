-- Worker 3's replacement strategy (2026-09-24): entry volatility gate instead of the PnL-
-- drawdown session breaker. Persists across restarts for the same reason session_breaker_*
-- did -- Render redeploys every service on any push, and an active pause shouldn't reset.

ALTER TABLE lighter_stoch_dca_btc_state
  ADD COLUMN IF NOT EXISTS entry_vol_paused boolean NOT NULL DEFAULT false;

ALTER TABLE lighter_stoch_dca_btc_state
  ADD COLUMN IF NOT EXISTS entry_vol_last_bar_ts bigint;
