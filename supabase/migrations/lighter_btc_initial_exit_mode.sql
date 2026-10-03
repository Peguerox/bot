-- Worker 1 exit-mode switch: trail vs fixed TP -- 2026-10-03.
-- Run in the Supabase SQL Editor.
-- Same mechanism as lighter_hedge_exit_mode.sql, built for Worker 1 ("build the same thing for
-- worker 1"). override_exit_mode is 'trail' (default/current behavior) or 'tp' (literal TP at
-- override_tp_pct, profit-lock trail suppressed). SL is never touched by this switch. See
-- StochBot._exit_params's docstring.
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS override_exit_mode TEXT;
ALTER TABLE public.lighter_btc_initial_state ADD COLUMN IF NOT EXISTS override_tp_pct DOUBLE PRECISION;
