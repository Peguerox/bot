-- Worker 1 (2026-09-26): adds self-lock protection to the RSI-Stoch real strategy after 3 real
-- SLs hit in a 15-minute window, erasing its earlier gains. Same mechanism as Worker 2/3: a
-- real SL locks real order placement immediately; a continuous internal paper shadow (running
-- the identical RSI-Stoch signal) keeps trading on paper; 2 consecutive paper wins (TP, or a
-- winning reversal since self_lock_reversal_counts_as_win is set) unlock real trading again.

ALTER TABLE lighter_btc_initial_state
  ADD COLUMN IF NOT EXISTS real_trading_locked boolean NOT NULL DEFAULT false;

ALTER TABLE lighter_btc_initial_state
  ADD COLUMN IF NOT EXISTS paper_side text;

ALTER TABLE lighter_btc_initial_state
  ADD COLUMN IF NOT EXISTS paper_entry_price double precision;

ALTER TABLE lighter_btc_initial_state
  ADD COLUMN IF NOT EXISTS paper_entry_time bigint;

ALTER TABLE lighter_btc_initial_state
  ADD COLUMN IF NOT EXISTS paper_consecutive_tps integer NOT NULL DEFAULT 0;
