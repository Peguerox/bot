-- Live bot: continuous rolling z-score mean-reversion on ETH via Bitfinex. Watches Binance
-- ETHUSDT's own price against a continuously-updating 25-minute rolling mean/std (not gated to
-- 5-min candle closes like the original SOLFDUSD paper bot design), enters when z <= -2.0, and
-- manages with a 0.1% trailing stop on Bitfinex's real bid -- NOT the original fixed TP+1.0%/
-- SL-0.1% OCO exit, which backtested far worse on Bitfinex's real spread (10.3% win rate, $745
-- total over 1yr) vs the trailing exit (36.6% win rate, $2,878 total over the same window).
-- Starts disabled (enabled=false) -- built ahead of a decision on whether/when to run it.
CREATE TABLE IF NOT EXISTS eth_zscore_bitfinex_state (
  id                INTEGER PRIMARY KEY DEFAULT 1,
  enabled           BOOLEAN NOT NULL DEFAULT false,
  mode              TEXT NOT NULL DEFAULT 'FLAT' CHECK (mode IN ('FLAT', 'LONG')),
  eth_quantity      DECIMAL(20,8),
  entry_price       DECIMAL(20,8),
  entry_time        TIMESTAMPTZ,
  usd_balance       DECIMAL(20,8) NOT NULL DEFAULT 20,
  extreme_price     DECIMAL(20,8),
  stop_price        DECIMAL(20,8),
  entry_spread_pct  DECIMAL(10,5),
  realized_pnl_usd  DECIMAL(20,8) NOT NULL DEFAULT 0,
  total_trades      INTEGER NOT NULL DEFAULT 0,
  total_wins        INTEGER NOT NULL DEFAULT 0,
  lock_owner        TEXT,
  lock_heartbeat    TIMESTAMPTZ
);

INSERT INTO eth_zscore_bitfinex_state (id, enabled, mode, usd_balance)
VALUES (1, false, 'FLAT', 20)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS eth_zscore_bitfinex_trades (
  id                BIGSERIAL PRIMARY KEY,
  entry_price       DECIMAL(20,8) NOT NULL,
  exit_price        DECIMAL(20,8) NOT NULL,
  eth_quantity      DECIMAL(20,8) NOT NULL,
  usd_in            DECIMAL(20,8) NOT NULL,
  usd_out           DECIMAL(20,8) NOT NULL,
  pnl_usd           DECIMAL(20,8) NOT NULL,
  pnl_pct           DECIMAL(10,4) NOT NULL,
  zscore_at_entry   DECIMAL(10,4),
  entry_spread_pct  DECIMAL(10,5),
  exit_spread_pct   DECIMAL(10,5),
  entry_time        TIMESTAMPTZ NOT NULL,
  exit_time         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eth_zscore_bitfinex_runs (
  id     BIGSERIAL PRIMARY KEY,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data   JSONB
);

ALTER TABLE eth_zscore_bitfinex_state  ENABLE ROW LEVEL SECURITY;
ALTER TABLE eth_zscore_bitfinex_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE eth_zscore_bitfinex_runs   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read" ON eth_zscore_bitfinex_state  FOR SELECT USING (true);
CREATE POLICY "public read" ON eth_zscore_bitfinex_trades FOR SELECT USING (true);
CREATE POLICY "public read" ON eth_zscore_bitfinex_runs   FOR SELECT USING (true);

ALTER PUBLICATION supabase_realtime ADD TABLE eth_zscore_bitfinex_state;
ALTER PUBLICATION supabase_realtime ADD TABLE eth_zscore_bitfinex_trades;
ALTER PUBLICATION supabase_realtime ADD TABLE eth_zscore_bitfinex_runs;
