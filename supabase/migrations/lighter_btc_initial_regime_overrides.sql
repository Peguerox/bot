-- Worker 1 live signal controls -- 2026-10-02. Run in the Supabase SQL Editor.
-- Dashboard toggles for the stochastic regime, the zebra/color-balance band, and the flip
-- regime, plus a live override for the volume switch threshold itself. NULL on any of these
-- means "use the compiled-in default" -- see BotConfig.schema_has_regime_overrides and
-- StochBot._regime_controls.
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS override_stochastic_enabled BOOLEAN;
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS override_zebra_enabled BOOLEAN;
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS override_flip_enabled BOOLEAN;
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS override_volume_switch_threshold DOUBLE PRECISION;
