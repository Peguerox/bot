CREATE TABLE IF NOT EXISTS sol_everybar_us_state (
  id               INTEGER PRIMARY KEY DEFAULT 1,
  enabled          BOOLEAN NOT NULL DEFAULT false,
  mode             TEXT NOT NULL DEFAULT 'USD' CHECK (mode IN ('USD', 'SOL')),
  sol_quantity     DECIMAL(20,8),
  entry_price      DECIMAL(20,8),
  entry_time       TIMESTAMPTZ,
  usd_balance      DECIMAL(20,8) NOT NULL DEFAULT 50,
  last_candle_ts   BIGINT NOT NULL DEFAULT 0,
  realized_pnl_usd DECIMAL(20,8) NOT NULL DEFAULT 0,
  total_trades     INTEGER NOT NULL DEFAULT 0,
  total_wins       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sol_everybar_us_trades (
  id           BIGSERIAL PRIMARY KEY,
  entry_price  DECIMAL(20,8) NOT NULL,
  exit_price   DECIMAL(20,8) NOT NULL,
  sol_quantity DECIMAL(20,8) NOT NULL,
  usd_in       DECIMAL(20,8) NOT NULL,
  usd_out      DECIMAL(20,8) NOT NULL,
  pnl_usd      DECIMAL(20,8) NOT NULL,
  pnl_pct      DECIMAL(10,4) NOT NULL,
  exit_reason  TEXT NOT NULL CHECK (exit_reason IN ('TP', 'SL')),
  entry_time   TIMESTAMPTZ NOT NULL,
  exit_time    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sol_everybar_us_runs (
  id     BIGSERIAL PRIMARY KEY,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data   JSONB
);

INSERT INTO sol_everybar_us_state (id, enabled, mode, usd_balance)
VALUES (1, false, 'USD', 50)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE sol_everybar_us_state  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sol_everybar_us_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE sol_everybar_us_runs   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read" ON sol_everybar_us_state  FOR SELECT USING (true);
CREATE POLICY "public read" ON sol_everybar_us_trades FOR SELECT USING (true);
CREATE POLICY "public read" ON sol_everybar_us_runs   FOR SELECT USING (true);
