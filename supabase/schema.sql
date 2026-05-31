-- Run this in Supabase SQL Editor

CREATE TABLE positions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pair         TEXT NOT NULL,
  entry_price  DECIMAL(18,8) NOT NULL,
  sl           DECIMAL(18,8) NOT NULL,
  tp           DECIMAL(18,8) NOT NULL,
  quantity     DECIMAL(18,8) NOT NULL,
  z_score      DECIMAL(10,6),
  hold_count   INTEGER DEFAULT 0,
  status       TEXT DEFAULT 'open',  -- 'open' | 'closed'
  result       TEXT,                 -- 'TP' | 'SL' | 'EXPIRE'
  pnl          DECIMAL(18,8),
  exit_price   DECIMAL(18,8),
  entry_time   TIMESTAMPTZ DEFAULT NOW(),
  exit_time    TIMESTAMPTZ
);

CREATE TABLE bot_runs (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at  TIMESTAMPTZ DEFAULT NOW(),
  data    JSONB
);

-- Enable realtime for live dashboard updates
ALTER PUBLICATION supabase_realtime ADD TABLE positions;

-- Indexes
CREATE INDEX idx_positions_status ON positions(status);
CREATE INDEX idx_positions_pair   ON positions(pair);
CREATE INDEX idx_bot_runs_run_at  ON bot_runs(run_at DESC);
