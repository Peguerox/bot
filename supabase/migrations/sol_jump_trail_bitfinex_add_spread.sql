-- Track the real bid/ask spread at entry and exit on every trade so we can later check whether
-- performance correlates with spread width (couldn't do this before -- we were only showing live
-- spread on the dashboard, never persisting it).
ALTER TABLE sol_jump_trail_bitfinex_state  ADD COLUMN IF NOT EXISTS entry_spread_pct DECIMAL(10,5);
ALTER TABLE sol_jump_trail_bitfinex_trades ADD COLUMN IF NOT EXISTS entry_spread_pct DECIMAL(10,5);
ALTER TABLE sol_jump_trail_bitfinex_trades ADD COLUMN IF NOT EXISTS exit_spread_pct  DECIMAL(10,5);
