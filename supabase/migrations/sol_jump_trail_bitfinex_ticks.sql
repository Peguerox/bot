-- Adds jump-size tracking and full tick-by-tick logging while a position is open, so we can
-- later answer (1) does jump size predict win rate, (2) what SL would have performed best —
-- using the bot's own real tick history instead of an approximation from 1-min candles.
ALTER TABLE sol_jump_trail_bitfinex_trades ADD COLUMN IF NOT EXISTS jump_pct DECIMAL(10,4);

CREATE TABLE IF NOT EXISTS sol_jump_trail_bitfinex_ticks (
  id         BIGSERIAL PRIMARY KEY,
  entry_time TIMESTAMPTZ NOT NULL, -- ties back to the open trade's entry_time for joining
  tick_time  TIMESTAMPTZ NOT NULL,
  price      DECIMAL(20,8) NOT NULL
);
CREATE INDEX IF NOT EXISTS sol_jump_trail_bitfinex_ticks_entry_time_idx
  ON sol_jump_trail_bitfinex_ticks (entry_time);

ALTER TABLE sol_jump_trail_bitfinex_ticks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read" ON sol_jump_trail_bitfinex_ticks FOR SELECT USING (true);
