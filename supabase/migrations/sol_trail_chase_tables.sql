-- Drop the old WebSocket-session bot entirely (repeated duplicate-trade/zombie-session bugs —
-- see BOT_BUGS_CHECKLIST.md). Replaced by sol_trail_chase_* below.
DROP TABLE IF EXISTS sol_trail_ws_trades;
DROP TABLE IF EXISTS sol_trail_ws_runs;
DROP TABLE IF EXISTS sol_trail_ws_state;

-- Paper bot state/trades/runs for SOLFDUSD trailing-stop-only strategy — same strategy as
-- live-bot-sol-trail.ts (SL=0.1% trail, no TP, $100 seed, compounds, 1-min entry cadence), but
-- while holding a position, each minute opens a short (~50s) WebSocket burst to catch the trail
-- in near-real-time instead of a single price check. No long-lived cross-invocation session —
-- every run is short and self-contained, same as every other bot, so no session lock is needed.
CREATE TABLE IF NOT EXISTS sol_trail_chase_state (
  id                INTEGER PRIMARY KEY DEFAULT 1,
  enabled           BOOLEAN NOT NULL DEFAULT false,
  mode              TEXT NOT NULL DEFAULT 'USD' CHECK (mode IN ('USD', 'SOL')),
  sol_quantity      DECIMAL(20,8),
  entry_price       DECIMAL(20,8),
  entry_time        TIMESTAMPTZ,
  usd_balance       DECIMAL(20,8) NOT NULL DEFAULT 100,
  peak_price        DECIMAL(20,8),
  stop_price        DECIMAL(20,8),
  last_candle_ts    BIGINT NOT NULL DEFAULT 0,
  realized_pnl_usd  DECIMAL(20,8) NOT NULL DEFAULT 0,
  total_trades      INTEGER NOT NULL DEFAULT 0,
  total_wins        INTEGER NOT NULL DEFAULT 0
);

INSERT INTO sol_trail_chase_state (id, enabled, mode, usd_balance)
VALUES (1, false, 'USD', 100)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS sol_trail_chase_trades (
  id           BIGSERIAL PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS sol_trail_chase_runs (
  id     BIGSERIAL PRIMARY KEY,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data   JSONB
);

ALTER TABLE sol_trail_chase_state  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sol_trail_chase_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE sol_trail_chase_runs   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read" ON sol_trail_chase_state  FOR SELECT USING (true);
CREATE POLICY "public read" ON sol_trail_chase_trades FOR SELECT USING (true);
CREATE POLICY "public read" ON sol_trail_chase_runs   FOR SELECT USING (true);

ALTER PUBLICATION supabase_realtime ADD TABLE sol_trail_chase_state;
ALTER PUBLICATION supabase_realtime ADD TABLE sol_trail_chase_trades;
ALTER PUBLICATION supabase_realtime ADD TABLE sol_trail_chase_runs;
