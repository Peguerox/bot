-- Restart-survival checkpoint for the stochastic-turn protection (2026-09-28, added after
-- external review): the armed/extreme-K state and paper's frozen joint-adaptive TP/SL/blanking
-- were originally in-process only, which meant a restart mid-position silently dropped
-- protection -- a real risk given Render restarts every service on every push. Both columns are
-- bound to an entry-time identity key inside the JSON so a stale checkpoint from an
-- already-closed position never gets misapplied to a different one.

alter table lighter_stoch_dca_btc_state
  add column if not exists position_stoch_checkpoint jsonb,
  add column if not exists paper_joint_checkpoint jsonb;
