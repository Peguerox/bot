-- Worker 1's breaker now resumes once volatility is back to whatever it was AT the trip
-- moment (adaptive), instead of a fixed 0.20% threshold. Needs a new column to persist that
-- trip-moment reading across a restart, same reason session_breaker_trip_direction exists --
-- Render redeploys every service on any push, and this must survive that.
--
-- Added to both tables (not just Worker 1's) because _persist_session_breaker_patch() writes
-- this column unconditionally whenever schema_has_session_breaker=True, and Worker 3 also has
-- that flag set even though it doesn't use adaptive mode.

ALTER TABLE lighter_btc_initial_state
  ADD COLUMN IF NOT EXISTS session_breaker_trip_range_pct double precision;

ALTER TABLE lighter_stoch_dca_btc_state
  ADD COLUMN IF NOT EXISTS session_breaker_trip_range_pct double precision;
