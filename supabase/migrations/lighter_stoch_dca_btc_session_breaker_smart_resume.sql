-- Adds the 2 new columns the smart-resume feature needs (direction at trip time, and when to
-- next re-check whether it's safe to resume). Worker 3 doesn't use smart resume yet (its
-- direction/calm-range settings stay unset), but keeping both tables' schemas in sync avoids
-- re-running a partial migration later if it gets enabled there too.
alter table lighter_stoch_dca_btc_state
  add column if not exists session_breaker_trip_direction text,
  add column if not exists session_breaker_next_check_at timestamptz;
