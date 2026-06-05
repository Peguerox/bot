-- Run this in the Supabase SQL editor

CREATE TABLE faking_settings (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  enabled     boolean DEFAULT false,
  usdt_balance numeric DEFAULT 0,
  updated_at  timestamptz DEFAULT now()
);
INSERT INTO faking_settings (enabled) VALUES (false);

CREATE TABLE faking_positions (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  symbol         text NOT NULL,
  status         text NOT NULL DEFAULT 'open',
  entry_price    numeric,
  sl             numeric,
  tp             numeric,
  quantity       numeric,
  z_score        numeric,
  hold_count     int DEFAULT 0,
  tp_order_id    bigint,
  chase_order_id bigint,
  chase_price    numeric,
  exit_price     numeric,
  pnl            numeric,
  result         text,
  entry_time     timestamptz DEFAULT now(),
  exit_time      timestamptz
);

CREATE TABLE faking_runs (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  actions    jsonb
);

-- Allow frontend (anon key) to read
ALTER TABLE faking_settings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE faking_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE faking_runs      ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon read" ON faking_settings  FOR SELECT USING (true);
CREATE POLICY "anon read" ON faking_positions FOR SELECT USING (true);
CREATE POLICY "anon read" ON faking_runs      FOR SELECT USING (true);
