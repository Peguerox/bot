-- Worker 1 live stochastic band override -- 2026-10-02. Run in the Supabase SQL Editor.
-- A single shared band applied to BOTH the entry signal and the reversal exit together
-- (tied by direct request). NULL means "use the compiled defaults" (25/75). See
-- BotConfig.schema_has_regime_overrides / StochBot._stoch_band_controls.
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS override_stoch_band_lo DOUBLE PRECISION;
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS override_stoch_band_hi DOUBLE PRECISION;
