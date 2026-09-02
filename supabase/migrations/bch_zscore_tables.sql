-- Paper bot state/trades/runs for BCH/FDUSD z-score strategy
CREATE TABLE IF NOT EXISTS bch_zscore_state (
  id             INTEGER PRIMARY KEY DEFAULT 1,
  enabled        BOOLEAN NOT NULL DEFAULT false,
  mode           TEXT NOT NULL DEFAULT 'USD' CHECK (mode IN ('USD', 'BCH')),
  bch_quantity   DECIMAL(20,8),
  entry_price    DECIMAL(20,8),
  entry_time     TIMESTAMPTZ,
  usd_balance    DECIMAL(20,8) NOT NULL DEFAULT 50,
  last_candle_ts BIGINT NOT NULL DEFAULT 0
);

INSERT INTO bch_zscore_state (id, enabled, mode, usd_balance)
VALUES (1, false, 'USD', 50)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS bch_zscore_trades (
  id           BIGSERIAL PRIMARY KEY,
  entry_price  DECIMAL(20,8) NOT NULL,
  exit_price   DECIMAL(20,8) NOT NULL,
  bch_quantity DECIMAL(20,8) NOT NULL,
  usd_in       DECIMAL(20,8) NOT NULL,
  usd_out      DECIMAL(20,8) NOT NULL,
  pnl_usd      DECIMAL(20,8) NOT NULL,
  pnl_pct      DECIMAL(10,4) NOT NULL,
  exit_reason  TEXT NOT NULL CHECK (exit_reason IN ('TP', 'SL')),
  entry_time   TIMESTAMPTZ NOT NULL,
  exit_time    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bch_zscore_runs (
  id     BIGSERIAL PRIMARY KEY,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data   JSONB
);
