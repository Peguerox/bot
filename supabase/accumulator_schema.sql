-- Run this in Supabase SQL Editor (after schema.sql)

-- Current state of the accumulator bot (one row only)
CREATE TABLE accumulator_state (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  holding    TEXT NOT NULL DEFAULT 'BTC',   -- 'BTC' | 'SOL'
  quantity   DECIMAL(18,8) NOT NULL,        -- BTC qty or SOL qty
  btc_value  DECIMAL(18,8) NOT NULL,        -- current portfolio in BTC
  switches   INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Log of every switch
CREATE TABLE accumulator_switches (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_asset       TEXT NOT NULL,
  to_asset         TEXT NOT NULL,
  sol_btc_price    DECIMAL(18,8) NOT NULL,
  btc_value_before DECIMAL(18,8) NOT NULL,
  btc_value_after  DECIMAL(18,8) NOT NULL,
  switched_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE accumulator_state;

-- Indexes
CREATE INDEX idx_acc_switches_at ON accumulator_switches(switched_at DESC);

-- Seed initial state: $1,000 worth of BTC at start
-- (Run this AFTER inserting — replace btc_price with current BTC price)
-- INSERT INTO accumulator_state (holding, quantity, btc_value)
-- VALUES ('BTC', 0.009553, 0.009553);
