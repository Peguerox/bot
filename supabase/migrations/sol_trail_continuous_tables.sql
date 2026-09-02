-- Paper bot state/trades/runs for the CONTINUOUS (always-on, non-Trigger.dev) SOLUSD trailing-
-- stop-only strategy on Bitfinex. Same Pure Trail strategy verified via backtest (SL=0.1% trail,
-- no TP, no cooldown, instant re-entry, $100 seed, compounds) as sol_trail_bitfinex_*, but run
-- from a persistent worker process instead of a 1-min-cron + 50s-WS-burst — kept in entirely
-- separate tables so it can run side-by-side with the burst bot for direct comparison.
--
-- lock_owner/lock_heartbeat enforce a hard single-instance guarantee: a new process may only
-- start trading if no other instance's heartbeat is recent (see server/continuous-trail-bitfinex.ts).
CREATE TABLE IF NOT EXISTS sol_trail_continuous_state (
  id                INTEGER PRIMARY KEY DEFAULT 1,
  enabled           BOOLEAN NOT NULL DEFAULT false,
  mode              TEXT NOT NULL DEFAULT 'USD' CHECK (mode IN ('USD', 'SOL')),
  sol_quantity      DECIMAL(20,8),
  entry_price       DECIMAL(20,8),
  entry_time        TIMESTAMPTZ,
  usd_balance       DECIMAL(20,8) NOT NULL DEFAULT 100,
  peak_price        DECIMAL(20,8),
  stop_price        DECIMAL(20,8),
  realized_pnl_usd  DECIMAL(20,8) NOT NULL DEFAULT 0,
  total_trades      INTEGER NOT NULL DEFAULT 0,
  total_wins        INTEGER NOT NULL DEFAULT 0,
  lock_owner        TEXT,
  lock_heartbeat    TIMESTAMPTZ
);

INSERT INTO sol_trail_continuous_state (id, enabled, mode, usd_balance)
VALUES (1, false, 'USD', 100)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS sol_trail_continuous_trades (
  id           BIGSERIAL PRIMARY KEY,
  entry_price  DECIMAL(20,8) NOT NULL,
  exit_price   DECIMAL(20,8) NOT NULL,
  sol_quantity DECIMAL(20,8) NOT NULL,
  usd_in       DECIMAL(20,8) NOT NULL,
  usd_out      DECIMAL(20,8) NOT NULL,
  pnl_usd      DECIMAL(20,8) NOT NULL,
  pnl_pct      DECIMAL(10,4) NOT NULL,
  entry_time   TIMESTAMPTZ NOT NULL,
  exit_time    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sol_trail_continuous_runs (
  id     BIGSERIAL PRIMARY KEY,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data   JSONB
);

ALTER TABLE sol_trail_continuous_state  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sol_trail_continuous_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE sol_trail_continuous_runs   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read" ON sol_trail_continuous_state  FOR SELECT USING (true);
CREATE POLICY "public read" ON sol_trail_continuous_trades FOR SELECT USING (true);
CREATE POLICY "public read" ON sol_trail_continuous_runs   FOR SELECT USING (true);

ALTER PUBLICATION supabase_realtime ADD TABLE sol_trail_continuous_state;
ALTER PUBLICATION supabase_realtime ADD TABLE sol_trail_continuous_trades;
ALTER PUBLICATION supabase_realtime ADD TABLE sol_trail_continuous_runs;
