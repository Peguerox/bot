-- 2026-10-06, direct request after backtesting it against real Worker 1 trades: "lets do 30
-- seconds... leave it open so we can change it manually later if 30 seconds does not work."
-- Live-tunable dwell for the plain SL specifically (does NOT apply to the escalated SL tiers,
-- which keep their own instant/conditional contract). 0 = instant, unchanged from before this
-- existed. See StochBot/BotConfig.sl_dwell_seconds's docstring in stoch_bot_core.py.
ALTER TABLE public.lighter_btc_initial_state
  ADD COLUMN IF NOT EXISTS override_sl_dwell_seconds DOUBLE PRECISION;
