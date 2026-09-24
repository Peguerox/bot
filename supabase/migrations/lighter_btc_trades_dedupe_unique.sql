-- Fixes a real bug found 2026-09-24: a Render restart can briefly overlap the old and new
-- process, both independently closing the same real position. Money was never double-counted
-- (both processes compute and write the identical realized_pnl_usd), but log_trade()'s INSERT
-- created a second row each time this happened. Confirmed via 3 independent cross-checks
-- (session breaker's own math, state self-consistency, real exchange collateral) that this is
-- a display/count bug only, not a money bug.

-- Step 1: remove existing duplicate rows (same opened_at + side + avg_entry_price), keeping
-- only the earliest (lowest id) of each group.
DELETE FROM lighter_btc_initial_trades a USING lighter_btc_initial_trades b
  WHERE a.id > b.id
    AND a.opened_at = b.opened_at
    AND a.side = b.side
    AND a.avg_entry_price = b.avg_entry_price;

DELETE FROM lighter_btc_optimal_trades a USING lighter_btc_optimal_trades b
  WHERE a.id > b.id
    AND a.opened_at = b.opened_at
    AND a.side = b.side
    AND a.avg_entry_price = b.avg_entry_price;

DELETE FROM lighter_stoch_dca_btc_trades a USING lighter_stoch_dca_btc_trades b
  WHERE a.id > b.id
    AND a.opened_at = b.opened_at
    AND a.side = b.side
    AND a.avg_entry_price = b.avg_entry_price;

-- Step 2: add the unique constraint the app now upserts against (log_trade in
-- stoch_bot_core.py posts with ?on_conflict=opened_at,side,avg_entry_price +
-- Prefer: resolution=ignore-duplicates).
ALTER TABLE lighter_btc_initial_trades
  ADD CONSTRAINT lighter_btc_initial_trades_dedupe UNIQUE (opened_at, side, avg_entry_price);

ALTER TABLE lighter_btc_optimal_trades
  ADD CONSTRAINT lighter_btc_optimal_trades_dedupe UNIQUE (opened_at, side, avg_entry_price);

ALTER TABLE lighter_stoch_dca_btc_trades
  ADD CONSTRAINT lighter_stoch_dca_btc_trades_dedupe UNIQUE (opened_at, side, avg_entry_price);
