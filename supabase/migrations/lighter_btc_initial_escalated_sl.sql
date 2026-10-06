-- 2026-10-06, direct request after real trade-data analysis of Worker 1's SL: "we have the
-- following... 0.05 we check volume and timing, then 0.1 we check volume again, then 0.12 hard
-- cap... build it, i have lost 2 times since i put SL." Live on/off toggle for the 3-tier
-- escalated SL (see StochBot/BotConfig.escalated_sl_enabled's docstring in stoch_bot_core.py for
-- the full design) -- when on, it replaces the plain SL entirely.
ALTER TABLE public.lighter_btc_initial_state
  ADD COLUMN IF NOT EXISTS override_escalated_sl_enabled BOOLEAN;
