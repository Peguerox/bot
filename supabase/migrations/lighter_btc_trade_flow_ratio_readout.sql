-- Worker 1 + Worker 4 real taker-flow readout -- 2026-10-12. Run in the Supabase SQL Editor.
-- Written every ~30s: buy_volume / (buy_volume + sell_volume) from Lighter's recentTrades
-- endpoint's is_maker_ask field (real executed aggressor side, not standing order-book intent).
-- Purely observational for now -- gates no entry or exit.
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS live_trade_flow_ratio DOUBLE PRECISION;
ALTER TABLE public.lighter_btc_worker4_state ADD COLUMN IF NOT EXISTS live_trade_flow_ratio DOUBLE PRECISION;
