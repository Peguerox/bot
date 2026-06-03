-- Live trading positions (ATOM only, $200 allocation)
-- Separate from paper trading 'positions' table

CREATE TABLE IF NOT EXISTS live_positions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol              TEXT NOT NULL DEFAULT 'ATOMUSDT',
  status              TEXT NOT NULL DEFAULT 'pending',
  -- 'pending' | 'open' | 'chasing' | 'closed'

  -- Position details
  entry_price         DECIMAL(18,8),
  sl                  DECIMAL(18,8),
  tp                  DECIMAL(18,8),
  quantity            DECIMAL(18,8),
  z_score             DECIMAL(10,6),
  hold_count          INTEGER DEFAULT 0,

  -- Order IDs
  entry_order_id      BIGINT,          -- limit buy
  tp_order_id         BIGINT,          -- limit sell leg of OCO
  sl_order_id         BIGINT,          -- stop-limit leg of OCO
  oco_order_list_id   BIGINT,          -- needed to cancel the OCO
  chase_order_id      BIGINT,          -- limit sell during chase
  chase_price         DECIMAL(18,8),

  -- Exit
  exit_price          DECIMAL(18,8),
  pnl                 DECIMAL(18,8),
  result              TEXT,            -- 'TP' | 'SL' | 'CHASE_FILL' | 'MISSED'

  entry_time          TIMESTAMPTZ DEFAULT now(),
  exit_time           TIMESTAMPTZ
);

-- Run log
CREATE TABLE IF NOT EXISTS live_runs (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at  TIMESTAMPTZ DEFAULT now(),
  data    JSONB
);

-- Single-row settings: on/off switch + last known balance
CREATE TABLE IF NOT EXISTS live_settings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enabled       BOOLEAN NOT NULL DEFAULT false,
  usdt_balance  DECIMAL(18,8)    DEFAULT 0,
  updated_at    TIMESTAMPTZ      DEFAULT now()
);
INSERT INTO live_settings (enabled) VALUES (false);
