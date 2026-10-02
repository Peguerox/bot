-- Worker 1 live traded-volume readout -- 2026-10-02. Run in the Supabase SQL Editor.
-- Written every ~10s alongside live_k: mean BTC traded (candle "v", not a volatility/vol_pct
-- reading) over the trailing 10 closed candles -- the exact reading the volume regime switch
-- (stochastic+zebra below 2 BTC, flip signal at/above it) acts on.
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS live_candle_volume DOUBLE PRECISION;
