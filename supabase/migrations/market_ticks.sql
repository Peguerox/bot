-- Signal-agnostic live microstructure logger. No entry/exit logic involved -- every row is a
-- snapshot of live, tick-level market conditions (book, spread, trade flow, cross-venue gap),
-- labeled after the fact with what price actually did over the next 5s/15s/30s/60s. Purpose:
-- build a dataset to mine for real stay/exit or entry/exit patterns instead of guessing at
-- static rules first. features/labels kept as JSONB (not fixed columns) since the feature set
-- is expected to evolve while we figure out what's actually predictive.
CREATE TABLE IF NOT EXISTS market_ticks (
  id         BIGSERIAL PRIMARY KEY,
  symbol     TEXT NOT NULL,             -- e.g. tBTCUSD, tETHUSD
  ts         TIMESTAMPTZ NOT NULL,      -- snapshot time (features measured at this instant)
  mid_price  DECIMAL(20,8) NOT NULL,    -- denormalized for quick range queries/sanity checks
  features   JSONB NOT NULL,
  labels     JSONB NOT NULL,            -- filled in once the max horizon (60s) has elapsed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_ticks_symbol_ts_idx ON market_ticks (symbol, ts);

ALTER TABLE market_ticks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read" ON market_ticks FOR SELECT USING (true);
