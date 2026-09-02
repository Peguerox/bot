-- Adds trailing-stop state to surfer_usdt_state: tracks the best (peak) unrealized % gain
-- seen since entry, needed to implement the stepped trailing stop (10pp trail until +30%
-- gain, then tighten to 6pp) alongside the existing -6% hard stop.
ALTER TABLE surfer_usdt_state ADD COLUMN IF NOT EXISTS best_pct DECIMAL(10,4) NOT NULL DEFAULT 0;
