-- Paper bot: watches Binance SOLUSDT for "jumps" (>=0.02% cumulative move within 2s) and, when
-- one fires while flat, enters a Bitfinex tSOLUSD position in that same direction (long on an
-- up-jump, short on a down-jump), managed with a 0.1% trailing stop, worst-case-consistent
-- spread. Session finding motivating this: 20/27 (74.1%) of tested Binance jumps were followed
-- by a same-direction Bitfinex move within ~10s, vs ~33-50% (noise level) on Binance US/KuCoin.
CREATE TABLE IF NOT EXISTS sol_jump_trail_bitfinex_state (
  id                INTEGER PRIMARY KEY DEFAULT 1,
  enabled           BOOLEAN NOT NULL DEFAULT false,
  mode              TEXT NOT NULL DEFAULT 'FLAT' CHECK (mode IN ('FLAT', 'LONG', 'SHORT')),
  sol_quantity      DECIMAL(20,8),
  entry_price       DECIMAL(20,8),
  entry_time        TIMESTAMPTZ,
  usd_balance       DECIMAL(20,8) NOT NULL DEFAULT 100,
  extreme_price     DECIMAL(20,8),
  stop_price        DECIMAL(20,8),
  realized_pnl_usd  DECIMAL(20,8) NOT NULL DEFAULT 0,
  total_trades      INTEGER NOT NULL DEFAULT 0,
  total_wins        INTEGER NOT NULL DEFAULT 0,
  lock_owner        TEXT,
  lock_heartbeat    TIMESTAMPTZ
);

INSERT INTO sol_jump_trail_bitfinex_state (id, enabled, mode, usd_balance)
VALUES (1, false, 'FLAT', 100)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS sol_jump_trail_bitfinex_trades (
  id           BIGSERIAL PRIMARY KEY,
  direction    TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
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

CREATE TABLE IF NOT EXISTS sol_jump_trail_bitfinex_runs (
  id     BIGSERIAL PRIMARY KEY,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data   JSONB
);

ALTER TABLE sol_jump_trail_bitfinex_state  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sol_jump_trail_bitfinex_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE sol_jump_trail_bitfinex_runs   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read" ON sol_jump_trail_bitfinex_state  FOR SELECT USING (true);
CREATE POLICY "public read" ON sol_jump_trail_bitfinex_trades FOR SELECT USING (true);
CREATE POLICY "public read" ON sol_jump_trail_bitfinex_runs   FOR SELECT USING (true);

ALTER PUBLICATION supabase_realtime ADD TABLE sol_jump_trail_bitfinex_state;
ALTER PUBLICATION supabase_realtime ADD TABLE sol_jump_trail_bitfinex_trades;
ALTER PUBLICATION supabase_realtime ADD TABLE sol_jump_trail_bitfinex_runs;
