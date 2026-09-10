-- REUSES the existing sol_trail_bitfinex_state/trades/runs tables (left over from the deleted
-- paper-bot-sol-trail-bitfinex.ts) instead of creating new ones — same SOL+Bitfinex pairing, just
-- extended with the columns the DCA-martingale bot needs. Old columns (sol_quantity, peak_price,
-- stop_price, usd_balance) are left in place, unused, rather than dropped — harmless, and avoids
-- a destructive migration on a table that already has trade history in it.
--
-- positions is a JSONB array of the open trade's legs: [{price, usd_size, sol_qty}, ...] — one
-- entry per DCA level, oldest first. Needed because a single trade can carry up to ~5 legs at
-- different cost bases; portfolio value / TP target are computed by summing across all of them.
ALTER TABLE sol_trail_bitfinex_state
  ADD COLUMN IF NOT EXISTS positions         JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS total_cost        DECIMAL(20,8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dca_count         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_entry_price  DECIMAL(20,8),
  ADD COLUMN IF NOT EXISTS max_price         DECIMAL(20,8),
  ADD COLUMN IF NOT EXISTS tp_target         DECIMAL(20,8),
  ADD COLUMN IF NOT EXISTS dca_triggered     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS balance           DECIMAL(20,8) NOT NULL DEFAULT 1000;

-- Reset the one existing row (id=1, leftover state from the old trail bot) to fresh defaults for
-- the new strategy. enabled stays false — you flip it on when ready.
UPDATE sol_trail_bitfinex_state SET
  enabled = false, mode = 'USD', positions = '[]', total_cost = 0, dca_count = 0,
  entry_price = NULL, last_entry_price = NULL, max_price = NULL, tp_target = NULL,
  dca_triggered = false, balance = 500
WHERE id = 1;

ALTER TABLE sol_trail_bitfinex_trades
  ADD COLUMN IF NOT EXISTS positions    JSONB,
  ADD COLUMN IF NOT EXISTS dca_levels   INTEGER,
  ADD COLUMN IF NOT EXISTS exit_reason  TEXT;

-- sol_trail_bitfinex_runs already matches (id, run_at, data jsonb) — no changes needed.
