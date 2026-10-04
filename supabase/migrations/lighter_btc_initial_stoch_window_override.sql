-- Worker 1 live stochastic window override -- 2026-10-04. Run in the Supabase SQL Editor.
-- NULL means "use the compiled default" (BotConfig.stoch_window, currently 5). Governs both the
-- entry band and the reversal band checks -- compute_stoch_signal computes one K per call and
-- tests it against both. See StochBot._stoch_window_control.
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS override_stoch_window DOUBLE PRECISION;
