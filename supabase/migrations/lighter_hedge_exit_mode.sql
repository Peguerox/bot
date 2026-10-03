-- Worker 2 (hedge) exit-mode switch: trail vs fixed TP -- 2026-10-03.
-- Run in the Supabase SQL Editor.
-- Direct request after WORKER_2_HANDOFF.md research ("a panel where i can change between trail
-- and TP so i can test multiple strategies"). override_exit_mode is 'trail' (default/current
-- behavior) or 'tp' (the research-recommended controlled comparison: literal TP at
-- override_tp_pct, profit-lock trail suppressed). SL is never touched by this switch -- it's
-- the one protection that always stays active either way. See StochBot._exit_params's docstring.
-- Both legs read their own row independently, so both tables need both columns.
ALTER TABLE public.lighter_btc_optimal_state ADD COLUMN IF NOT EXISTS override_exit_mode TEXT;
ALTER TABLE public.lighter_btc_optimal_state ADD COLUMN IF NOT EXISTS override_tp_pct DOUBLE PRECISION;

ALTER TABLE public.lighter_stoch_dca_btc_state ADD COLUMN IF NOT EXISTS override_exit_mode TEXT;
ALTER TABLE public.lighter_stoch_dca_btc_state ADD COLUMN IF NOT EXISTS override_tp_pct DOUBLE PRECISION;
