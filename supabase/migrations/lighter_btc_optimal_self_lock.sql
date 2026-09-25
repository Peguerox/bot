-- Worker 2 combined-strategy draft (2026-09-25): adds Worker 3's self-lock columns to Worker 2's
-- table so the mechanism persists across restarts (Render redeploys every service on any push).
-- NOT YET APPLIED -- part of the "Worker 1 + Worker 3 combined" config prepared for tonight,
-- run this manually in the Supabase SQL editor before deploying the new config.

ALTER TABLE lighter_btc_optimal_state
  ADD COLUMN IF NOT EXISTS real_trading_locked boolean NOT NULL DEFAULT false;

ALTER TABLE lighter_btc_optimal_state
  ADD COLUMN IF NOT EXISTS paper_side text;

ALTER TABLE lighter_btc_optimal_state
  ADD COLUMN IF NOT EXISTS paper_entry_price double precision;

ALTER TABLE lighter_btc_optimal_state
  ADD COLUMN IF NOT EXISTS paper_entry_time bigint;

ALTER TABLE lighter_btc_optimal_state
  ADD COLUMN IF NOT EXISTS paper_consecutive_tps integer NOT NULL DEFAULT 0;
