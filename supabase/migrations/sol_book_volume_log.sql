-- Pure research logging, no trading. Records raw order book volume (top 25 levels each side)
-- alongside price over time, so bid/ask volume vs price behavior can be inspected directly
-- instead of predefining a ratio/threshold signal up front.
CREATE TABLE IF NOT EXISTS sol_book_volume_log (
  id         BIGSERIAL PRIMARY KEY,
  logged_at  TIMESTAMPTZ NOT NULL,
  price      DECIMAL(20,8) NOT NULL,
  bid_volume DECIMAL(20,8) NOT NULL,
  ask_volume DECIMAL(20,8) NOT NULL,
  imbalance  DECIMAL(10,6) NOT NULL, -- (bid_volume - ask_volume) / (bid_volume + ask_volume), -1..1, top 250 levels
  imbalance_25  DECIMAL(10,6),       -- same ratio, top 25 levels -- 250 alone found too sluggish to react to real price moves
  imbalance_100 DECIMAL(10,6),       -- same ratio, top 100 levels -- logging all 3 Bitfinex-supported depths to compare directly
  binance_bid  DECIMAL(20,8),
  binance_ask  DECIMAL(20,8)
);
CREATE INDEX IF NOT EXISTS sol_book_volume_log_logged_at_idx
  ON sol_book_volume_log (logged_at);

ALTER TABLE sol_book_volume_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read" ON sol_book_volume_log FOR SELECT USING (true);
