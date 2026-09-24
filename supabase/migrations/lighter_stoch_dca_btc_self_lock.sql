-- Worker 3's third strategy iteration (2026-09-24): drops the entry volatility gate (too many
-- silent no-ops -- detected spikes without actually blocking anything most of the time) for a
-- self-lock mechanism instead. Real SL -> lock real orders, keep trading the same signal on
-- paper; two consecutive paper TPs -> unlock. Persists across restarts for the same reason
-- every other gate on this table does -- Render redeploys every service on any push.

ALTER TABLE lighter_stoch_dca_btc_state
  ADD COLUMN IF NOT EXISTS real_trading_locked boolean NOT NULL DEFAULT false;

ALTER TABLE lighter_stoch_dca_btc_state
  ADD COLUMN IF NOT EXISTS paper_side text;

ALTER TABLE lighter_stoch_dca_btc_state
  ADD COLUMN IF NOT EXISTS paper_entry_price double precision;

ALTER TABLE lighter_stoch_dca_btc_state
  ADD COLUMN IF NOT EXISTS paper_entry_time bigint;

ALTER TABLE lighter_stoch_dca_btc_state
  ADD COLUMN IF NOT EXISTS paper_consecutive_tps integer NOT NULL DEFAULT 0;
