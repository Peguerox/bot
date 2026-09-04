-- Paper bot: EMA9/EMA21 + VWAP scalping strategy on SOL/USD (Bitfinex), 5m timeframe.
-- Long-only. See trigger/paper-bot-ema-vwap-solusd.ts for the full logic writeup.
CREATE TABLE IF NOT EXISTS sol_ema_vwap_state (
  id                INTEGER PRIMARY KEY DEFAULT 1,
  enabled           BOOLEAN NOT NULL DEFAULT false,
  position_state    TEXT NOT NULL DEFAULT 'FLAT' CHECK (position_state IN ('FLAT', 'ARMED', 'FULL', 'HALF')),
  armed_since_ts    BIGINT,
  entry_price       DECIMAL(20,8),
  entry_time        TIMESTAMPTZ,
  full_qty          DECIMAL(20,8),
  remaining_qty     DECIMAL(20,8),
  sl_price          DECIMAL(20,8),
  tp_price          DECIMAL(20,8),
  usd_balance       DECIMAL(20,8) NOT NULL DEFAULT 100,
  realized_pnl_usd  DECIMAL(20,8) NOT NULL DEFAULT 0,
  total_trades      INTEGER NOT NULL DEFAULT 0,
  total_wins        INTEGER NOT NULL DEFAULT 0,
  last_5m_candle_ts BIGINT NOT NULL DEFAULT 0
);

INSERT INTO sol_ema_vwap_state (id, enabled, position_state, usd_balance)
VALUES (1, false, 'FLAT', 100)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS sol_ema_vwap_trades (
  id           BIGSERIAL PRIMARY KEY,
  entry_price  DECIMAL(20,8) NOT NULL,
  exit_price   DECIMAL(20,8) NOT NULL,
  qty          DECIMAL(20,8) NOT NULL,
  usd_in       DECIMAL(20,8) NOT NULL,
  usd_out      DECIMAL(20,8) NOT NULL,
  pnl_usd      DECIMAL(20,8) NOT NULL,
  pnl_pct      DECIMAL(10,4) NOT NULL,
  exit_reason  TEXT NOT NULL CHECK (exit_reason IN ('TP_PARTIAL', 'BREAKEVEN', 'SL')),
  entry_time   TIMESTAMPTZ NOT NULL,
  exit_time    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sol_ema_vwap_runs (
  id     BIGSERIAL PRIMARY KEY,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data   JSONB
);

ALTER TABLE sol_ema_vwap_state  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sol_ema_vwap_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE sol_ema_vwap_runs   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read" ON sol_ema_vwap_state  FOR SELECT USING (true);
CREATE POLICY "public read" ON sol_ema_vwap_trades FOR SELECT USING (true);
CREATE POLICY "public read" ON sol_ema_vwap_runs   FOR SELECT USING (true);
