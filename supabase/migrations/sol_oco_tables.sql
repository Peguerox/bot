-- Live bot state/trades/runs for SOLFDUSD OCO strategy (Binance Global, real money).
-- usd_balance seeds at $20 — the buy amount is always derived fresh from $20 + all-time
-- realized PnL (not chained from the last trade's raw proceeds), so lot-size rounding loss
-- can't compound down over time (see trigger file for the exact calc).
CREATE TABLE IF NOT EXISTS sol_oco_state (
  id                 INTEGER PRIMARY KEY DEFAULT 1,
  enabled            BOOLEAN NOT NULL DEFAULT false,
  mode               TEXT NOT NULL DEFAULT 'USD' CHECK (mode IN ('USD', 'SOL')),
  sol_quantity       DECIMAL(20,8),
  entry_price        DECIMAL(20,8),
  entry_time         TIMESTAMPTZ,
  usd_balance        DECIMAL(20,8) NOT NULL DEFAULT 20,
  buy_order_id       BIGINT,
  oco_order_list_id  BIGINT,
  oco_tp_order_id    BIGINT,
  oco_sl_order_id    BIGINT,
  last_candle_ts     BIGINT NOT NULL DEFAULT 0,
  realized_pnl_usd   DECIMAL(20,8) NOT NULL DEFAULT 0,
  total_trades       INTEGER NOT NULL DEFAULT 0,
  total_wins         INTEGER NOT NULL DEFAULT 0
);

INSERT INTO sol_oco_state (id, enabled, mode, usd_balance)
VALUES (1, false, 'USD', 20)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS sol_oco_trades (
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

CREATE TABLE IF NOT EXISTS sol_oco_runs (
  id     BIGSERIAL PRIMARY KEY,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data   JSONB
);

ALTER TABLE sol_oco_state  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sol_oco_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE sol_oco_runs   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read" ON sol_oco_state  FOR SELECT USING (true);
CREATE POLICY "public read" ON sol_oco_trades FOR SELECT USING (true);
CREATE POLICY "public read" ON sol_oco_runs   FOR SELECT USING (true);
