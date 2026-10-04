-- Volume-jump guard on/off switch -- 2026-10-04. Run in the Supabase SQL Editor.
-- NULL/true means on (unchanged default behavior); false forces the guard off without losing
-- the configured ratio/pause. See StochBot._update_volume_jump_guard.
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS override_volume_jump_enabled BOOLEAN;
ALTER TABLE public.lighter_btc_optimal_state ADD COLUMN IF NOT EXISTS override_volume_jump_enabled BOOLEAN;
ALTER TABLE public.lighter_stoch_dca_btc_state ADD COLUMN IF NOT EXISTS override_volume_jump_enabled BOOLEAN;
