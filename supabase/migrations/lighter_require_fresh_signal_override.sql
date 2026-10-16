-- Require-fresh-signal toggle (2026-10-16, direct request: "can you make needs fresh signal a
-- toggle" -- for Worker 1, Worker 4, and both hedge legs). Previously compiled-only
-- (BotConfig.require_fresh_signal: True on Worker 1/4, False on the hedge) -- this column lets
-- it be flipped live from the dashboard without a redeploy, same pattern as every other
-- override_* column. NULL (the default after this migration) means "keep the compiled value" --
-- nothing changes until the dashboard toggle is actually used.

alter table public.lighter_btc_initial_state
  add column if not exists override_require_fresh_signal boolean;

alter table public.lighter_btc_worker4_state
  add column if not exists override_require_fresh_signal boolean;

alter table public.lighter_btc_optimal_state
  add column if not exists override_require_fresh_signal boolean;

alter table public.lighter_stoch_dca_btc_state
  add column if not exists override_require_fresh_signal boolean;
