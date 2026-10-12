-- Worker 1 + Worker 4 order-book depth/level ratio readouts -- 2026-10-12. Run in the Supabase
-- SQL Editor. Written every ~10s alongside live_k: bid depth / (bid+ask depth) and
-- bid level count / (bid+ask level count), both over the 20 price levels nearest the touch on
-- each side. Purely observational for now -- gates no entry or exit.
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS live_book_depth_ratio DOUBLE PRECISION;
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS live_book_level_ratio DOUBLE PRECISION;

ALTER TABLE public.lighter_btc_worker4_state ADD COLUMN IF NOT EXISTS live_book_depth_ratio DOUBLE PRECISION;
ALTER TABLE public.lighter_btc_worker4_state ADD COLUMN IF NOT EXISTS live_book_level_ratio DOUBLE PRECISION;
