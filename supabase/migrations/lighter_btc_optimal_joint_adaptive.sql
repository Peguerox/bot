-- Worker 2 moving to its own joint-adaptive formula (2026-09-28, new formula, separately
-- derived from Worker 3's -- own reference vol 0.060%, own exponents, and an asymmetric SL
-- bound capped at exactly its own base value 0.11% so SL can only tighten in quiet markets,
-- never balloon past base in busy ones). Needs the same three column groups Worker 3 already
-- has for this, which Worker 2 never got (it was plain fixed-band stochastic until now):
--   * position_tp_pct / position_sl_pct -- frozen-at-entry TP/SL (the "regime-switch era"
--     columns Worker 1 and Worker 3 both have already).
--   * joint_adaptive_last / position_blank_seconds -- live formula reading for the dashboard,
--     and the frozen blanking value for whichever position is open.
--   * position_stoch_checkpoint / paper_joint_checkpoint -- restart survival for the
--     stochastic-turn protection state AND the paper shadow's frozen TP/SL/blanking (self-lock's
--     paper shadow needs its frozen bands to survive a restart even though Worker 2 didn't have
--     any of this before).

alter table lighter_btc_optimal_state
  add column if not exists position_tp_pct double precision,
  add column if not exists position_sl_pct double precision,
  add column if not exists joint_adaptive_last jsonb,
  add column if not exists position_blank_seconds double precision,
  add column if not exists position_stoch_checkpoint jsonb,
  add column if not exists paper_joint_checkpoint jsonb;
