-- Worker 1 live flip-streak counter -- 2026-10-02. Run in the Supabase SQL Editor.
-- Written every ~10s alongside live_candle_volume: how many consecutive same-color closed
-- candles are running right now, and which direction the flip signal would enter if the next
-- candle broke that streak. Purely a display readout, drives no decision.
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS live_flip_streak_dir TEXT;
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS live_flip_streak_len INTEGER;
