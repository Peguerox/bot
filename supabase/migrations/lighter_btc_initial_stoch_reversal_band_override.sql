-- Worker 1 live reversal-band override -- 2026-10-02. Run in the Supabase SQL Editor.
-- Independent of override_stoch_band_lo/hi (which now control the ENTRY band only) --
-- direct follow-up request: separate numbers for entry vs reversal, not one shared pair.
-- NULL means "use the compiled default" (25/75). See
-- BotConfig.schema_has_regime_overrides / StochBot._stoch_band_controls.
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS override_stoch_reversal_lo DOUBLE PRECISION;
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS override_stoch_reversal_hi DOUBLE PRECISION;
