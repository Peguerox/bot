-- Live bot state/trades/runs for BTCUSDT OCO strategy (Binance.US, real money).
-- usd_balance is hard-capped at $20 total — the bot never buys with more than this
-- tracked pool, regardless of real account balance (see trigger file for the min() guard).
CREATE TABLE IF NOT EXISTS btc_oco_state (
  id                 INTEGER PRIMARY KEY DEFAULT 1,
  enabled            BOOLEAN NOT NULL DEFAULT false,
  mode               TEXT NOT NULL DEFAULT 'USD' CHECK (mode IN ('USD', 'BTC')),
  btc_quantity       DECIMAL(20,8),
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

INSERT INTO btc_oco_state (id, enabled, mode, usd_balance)
VALUES (1, false, 'USD', 20)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS btc_oco_trades (
  id           BIGSERIAL PRIMARY KEY,
  entry_price  DECIMAL(20,8) NOT NULL,
  exit_price   DECIMAL(20,8) NOT NULL,
  btc_quantity DECIMAL(20,8) NOT NULL,
  usd_in       DECIMAL(20,8) NOT NULL,
  usd_out      DECIMAL(20,8) NOT NULL,
  pnl_usd      DECIMAL(20,8) NOT NULL,
  pnl_pct      DECIMAL(10,4) NOT NULL,
  exit_reason  TEXT NOT NULL CHECK (exit_reason IN ('TP', 'SL')),
  entry_time   TIMESTAMPTZ NOT NULL,
  exit_time    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS btc_oco_runs (
  id     BIGSERIAL PRIMARY KEY,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data   JSONB
);

ALTER TABLE btc_oco_state  ENABLE ROW LEVEL SECURITY;
ALTER TABLE btc_oco_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE btc_oco_runs   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read" ON btc_oco_state  FOR SELECT USING (true);
CREATE POLICY "public read" ON btc_oco_trades FOR SELECT USING (true);
CREATE POLICY "public read" ON btc_oco_runs   FOR SELECT USING (true);
