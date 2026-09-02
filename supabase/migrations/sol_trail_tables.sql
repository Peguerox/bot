-- Live bot state/trades/runs for SOLFDUSD trailing-stop-only strategy (Binance Global, real
-- money). Every 1m bar entry, NO take-profit — a 0.1% trailing stop that ratchets up with the
-- price peak since entry, only exits on a 0.1% pullback from that peak. Backtested (fixed
-- $5000/trade, no compounding): 2yr avg $1,695/week, 98.1% of weeks positive.
CREATE TABLE IF NOT EXISTS sol_trail_state (
  id                INTEGER PRIMARY KEY DEFAULT 1,
  enabled           BOOLEAN NOT NULL DEFAULT false,
  mode              TEXT NOT NULL DEFAULT 'USD' CHECK (mode IN ('USD', 'SOL')),
  sol_quantity      DECIMAL(20,8),
  entry_price       DECIMAL(20,8),
  entry_time        TIMESTAMPTZ,
  usd_balance       DECIMAL(20,8) NOT NULL DEFAULT 100,
  buy_order_id      BIGINT,
  stop_order_id     BIGINT,
  peak_price        DECIMAL(20,8),
  stop_price        DECIMAL(20,8),
  last_candle_ts    BIGINT NOT NULL DEFAULT 0,
  realized_pnl_usd  DECIMAL(20,8) NOT NULL DEFAULT 0,
  total_trades      INTEGER NOT NULL DEFAULT 0,
  total_wins        INTEGER NOT NULL DEFAULT 0
);

INSERT INTO sol_trail_state (id, enabled, mode, usd_balance)
VALUES (1, false, 'USD', 100)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS sol_trail_trades (
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

CREATE TABLE IF NOT EXISTS sol_trail_runs (
  id     BIGSERIAL PRIMARY KEY,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data   JSONB
);

ALTER TABLE sol_trail_state  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sol_trail_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE sol_trail_runs   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read" ON sol_trail_state  FOR SELECT USING (true);
CREATE POLICY "public read" ON sol_trail_trades FOR SELECT USING (true);
CREATE POLICY "public read" ON sol_trail_runs   FOR SELECT USING (true);
