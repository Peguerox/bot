-- Surfer bot — SOL/BTC rotation on Binance.US
-- RSI(14) 15m + 12h EMA(7/25) liveMode filter

-- Single-row state machine (id always = 1)
CREATE TABLE IF NOT EXISTS surfer_state (
  id              INTEGER PRIMARY KEY DEFAULT 1,
  enabled         BOOLEAN NOT NULL DEFAULT false,
  mode            TEXT NOT NULL DEFAULT 'BTC',        -- 'BTC' | 'SOL'
  status          TEXT NOT NULL DEFAULT 'idle',       -- 'idle' | 'chasing_buy' | 'chasing_sell'
  armed_for_sol   BOOLEAN NOT NULL DEFAULT false,
  armed_for_btc   BOOLEAN NOT NULL DEFAULT false,
  last_candle_ts  BIGINT NOT NULL DEFAULT 0,          -- open-time of last processed 15m candle

  -- Set when buy fills, cleared when sell fills
  sol_quantity    DECIMAL(18,8),
  entry_price     DECIMAL(18,8),   -- SOLBTC rate we bought at
  entry_btc       DECIMAL(18,8),   -- BTC we spent (used for PnL)
  entry_time      TIMESTAMPTZ,

  -- Active chase order
  chase_order_id  BIGINT,
  chase_price     DECIMAL(18,8)
);
INSERT INTO surfer_state (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Trade log — one row per round trip (BTC→SOL→BTC)
CREATE TABLE IF NOT EXISTS surfer_trades (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol        TEXT NOT NULL DEFAULT 'SOLBTC',
  buy_price     DECIMAL(18,8),    -- SOLBTC rate on entry
  sell_price    DECIMAL(18,8),    -- SOLBTC rate on exit
  sol_quantity  DECIMAL(18,8),
  btc_in        DECIMAL(18,8),    -- BTC spent to buy SOL
  btc_out       DECIMAL(18,8),    -- BTC received from selling SOL
  pnl_btc       DECIMAL(18,8),    -- btc_out - btc_in
  pnl_pct       DECIMAL(10,6),    -- pnl_btc / btc_in * 100
  entry_time    TIMESTAMPTZ,
  exit_time     TIMESTAMPTZ DEFAULT now(),
  result        TEXT DEFAULT 'SELL'
);

-- Per-minute run log
CREATE TABLE IF NOT EXISTS surfer_runs (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at  TIMESTAMPTZ DEFAULT now(),
  data    JSONB
);
