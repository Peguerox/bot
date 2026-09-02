-- Fixes: dashboard PnL/win-rate stats were computed by summing the `trades` fetch, which is
-- limited to the last 20 rows. Bots past 20 trades were showing a rolling-20-trade window
-- instead of true cumulative performance. This adds persistent running totals to every bot's
-- state table (updated on every trade going forward) and backfills them from full trade history.

-- Live bots
ALTER TABLE surfer_state      ADD COLUMN IF NOT EXISTS realized_pnl_btc DECIMAL(20,8) NOT NULL DEFAULT 0;
ALTER TABLE surfer_state      ADD COLUMN IF NOT EXISTS total_trades     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE surfer_state      ADD COLUMN IF NOT EXISTS total_wins       INTEGER NOT NULL DEFAULT 0;

ALTER TABLE surfer_usdt_state ADD COLUMN IF NOT EXISTS realized_pnl_usdt DECIMAL(20,8) NOT NULL DEFAULT 0;
ALTER TABLE surfer_usdt_state ADD COLUMN IF NOT EXISTS total_trades      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE surfer_usdt_state ADD COLUMN IF NOT EXISTS total_wins        INTEGER NOT NULL DEFAULT 0;

-- Paper bots
ALTER TABLE bch_zscore_state     ADD COLUMN IF NOT EXISTS realized_pnl_usd DECIMAL(20,8) NOT NULL DEFAULT 0;
ALTER TABLE bch_zscore_state     ADD COLUMN IF NOT EXISTS total_trades     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bch_zscore_state     ADD COLUMN IF NOT EXISTS total_wins       INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sol_zscore_state     ADD COLUMN IF NOT EXISTS realized_pnl_usd DECIMAL(20,8) NOT NULL DEFAULT 0;
ALTER TABLE sol_zscore_state     ADD COLUMN IF NOT EXISTS total_trades     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sol_zscore_state     ADD COLUMN IF NOT EXISTS total_wins       INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sol_vwap_scalp_state ADD COLUMN IF NOT EXISTS realized_pnl_usd DECIMAL(20,8) NOT NULL DEFAULT 0;
ALTER TABLE sol_vwap_scalp_state ADD COLUMN IF NOT EXISTS total_trades     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sol_vwap_scalp_state ADD COLUMN IF NOT EXISTS total_wins       INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sol_everybar_state   ADD COLUMN IF NOT EXISTS realized_pnl_usd DECIMAL(20,8) NOT NULL DEFAULT 0;
ALTER TABLE sol_everybar_state   ADD COLUMN IF NOT EXISTS total_trades     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sol_everybar_state   ADD COLUMN IF NOT EXISTS total_wins       INTEGER NOT NULL DEFAULT 0;

-- Backfill from full trade history
UPDATE surfer_state SET
  realized_pnl_btc = COALESCE((SELECT SUM(pnl_btc) FROM surfer_trades), 0),
  total_trades     = (SELECT COUNT(*) FROM surfer_trades),
  total_wins       = (SELECT COUNT(*) FROM surfer_trades WHERE pnl_btc > 0)
WHERE id = 1;

UPDATE surfer_usdt_state SET
  realized_pnl_usdt = COALESCE((SELECT SUM(pnl_usdt) FROM surfer_usdt_trades), 0),
  total_trades      = (SELECT COUNT(*) FROM surfer_usdt_trades),
  total_wins        = (SELECT COUNT(*) FROM surfer_usdt_trades WHERE pnl_usdt > 0)
WHERE id = 1;

UPDATE bch_zscore_state SET
  realized_pnl_usd = COALESCE((SELECT SUM(pnl_usd) FROM bch_zscore_trades), 0),
  total_trades     = (SELECT COUNT(*) FROM bch_zscore_trades),
  total_wins       = (SELECT COUNT(*) FROM bch_zscore_trades WHERE pnl_usd > 0)
WHERE id = 1;

UPDATE sol_zscore_state SET
  realized_pnl_usd = COALESCE((SELECT SUM(pnl_usd) FROM sol_zscore_trades), 0),
  total_trades     = (SELECT COUNT(*) FROM sol_zscore_trades),
  total_wins       = (SELECT COUNT(*) FROM sol_zscore_trades WHERE pnl_usd > 0)
WHERE id = 1;

UPDATE sol_vwap_scalp_state SET
  realized_pnl_usd = COALESCE((SELECT SUM(pnl_usd) FROM sol_vwap_scalp_trades), 0),
  total_trades     = (SELECT COUNT(*) FROM sol_vwap_scalp_trades),
  total_wins       = (SELECT COUNT(*) FROM sol_vwap_scalp_trades WHERE pnl_usd > 0)
WHERE id = 1;

UPDATE sol_everybar_state SET
  realized_pnl_usd = COALESCE((SELECT SUM(pnl_usd) FROM sol_everybar_trades), 0),
  total_trades     = (SELECT COUNT(*) FROM sol_everybar_trades),
  total_wins       = (SELECT COUNT(*) FROM sol_everybar_trades WHERE pnl_usd > 0)
WHERE id = 1;
