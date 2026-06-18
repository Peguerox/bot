CREATE TABLE IF NOT EXISTS surfer_usdt_state (
  id              INTEGER PRIMARY KEY DEFAULT 1,
  enabled         BOOLEAN NOT NULL DEFAULT false,
  mode            TEXT NOT NULL DEFAULT 'USDT',
  status          TEXT NOT NULL DEFAULT 'idle',
  armed_for_sol   BOOLEAN NOT NULL DEFAULT false,
  last_candle_ts  BIGINT NOT NULL DEFAULT 0,
  sol_quantity    DECIMAL(18,8),
  entry_price     DECIMAL(10,2),
  entry_usdt      DECIMAL(18,4),
  entry_time      TIMESTAMPTZ,
  chase_order_id  BIGINT,
  chase_price     DECIMAL(10,2)
);
INSERT INTO surfer_usdt_state (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS surfer_usdt_trades (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_price   DECIMAL(10,2),
  exit_price    DECIMAL(10,2),
  sol_quantity  DECIMAL(18,8),
  usdt_in       DECIMAL(18,4),
  usdt_out      DECIMAL(18,4),
  pnl_usdt      DECIMAL(18,4),
  pnl_pct       DECIMAL(10,6),
  entry_time    TIMESTAMPTZ,
  exit_time     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS surfer_usdt_runs (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at  TIMESTAMPTZ DEFAULT now(),
  data    JSONB
);
