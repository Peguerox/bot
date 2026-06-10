-- BTC Pure Lag live trading tables
-- Run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS btc_live_positions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol              TEXT NOT NULL DEFAULT 'BTCUSDT',
  status              TEXT NOT NULL DEFAULT 'pending_entry',
  -- 'pending_entry' | 'open' | 'chasing' | 'closed'

  entry_order_id      BIGINT,
  entry_price         DECIMAL(18,8),
  quantity            DECIMAL(18,8),
  tp                  DECIMAL(18,8),
  sl                  DECIMAL(18,8),
  tp_order_id         BIGINT,
  sl_order_id         BIGINT,
  chase_price         DECIMAL(18,8),

  z_score             DECIMAL(10,6),
  hold_count          INTEGER DEFAULT 0,

  exit_price          DECIMAL(18,8),
  pnl                 DECIMAL(18,8),
  result              TEXT,

  entry_time          TIMESTAMPTZ DEFAULT now(),
  exit_time           TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS btc_live_runs (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at  TIMESTAMPTZ DEFAULT now(),
  data    JSONB
);

CREATE TABLE IF NOT EXISTS btc_live_settings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enabled       BOOLEAN NOT NULL DEFAULT false,
  pending_sell  BOOLEAN NOT NULL DEFAULT false,
  usdt_balance  DECIMAL(18,8) DEFAULT 25,
  total_usdt    DECIMAL(18,8) DEFAULT 0,
  baseline_usdt DECIMAL(18,8) DEFAULT 0,
  updated_at    TIMESTAMPTZ DEFAULT now()
);
INSERT INTO btc_live_settings (enabled) VALUES (false);

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE btc_live_positions;
ALTER PUBLICATION supabase_realtime ADD TABLE btc_live_settings;
ALTER PUBLICATION supabase_realtime ADD TABLE btc_live_runs;
