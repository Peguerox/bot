-- Adds the single-instance lock columns to sol_trail_bitfinex_state, needed now that the bot
-- is moving from a Trigger.dev cron job to a persistent Render worker (same guarantee pattern
-- as sol_jump_trail_bitfinex_state / sol_trail_continuous_state: a new process instance refuses
-- to start trading if another instance's heartbeat is still fresh).
ALTER TABLE sol_trail_bitfinex_state
  ADD COLUMN IF NOT EXISTS lock_owner     TEXT,
  ADD COLUMN IF NOT EXISTS lock_heartbeat TIMESTAMPTZ;
