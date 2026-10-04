-- Worker 1 2-hour efficiency-ratio readout -- 2026-10-04. Run in the Supabase SQL Editor.
-- Same formula as the hedge's existing ER15 (net move / total path length over the window,
-- compute_er_and_direction), just over 120 one-minute candles instead of 15 -- a slower,
-- less noisy regime indicator. Direction holding steady across several checks is the
-- meaningful signal, not any single reading. See StochBot.tick()'s live_er_2h write.
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS live_er_2h DOUBLE PRECISION;
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS live_er_2h_direction TEXT;
