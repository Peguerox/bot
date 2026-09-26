-- Removes the tight-TP self-lock paper test (2026-09-26) -- tested live for under an hour,
-- user's own read: "I was completely wrong. This bot is not generating any money." Reverses
-- lighter_stoch_dca_btc_tight_tp_paper_test.sql. Paper-only, no real money involved.

drop table if exists lighter_btc_tight_tp_paper_trades;

alter table lighter_stoch_dca_btc_state
  drop column if exists tight_paper_side,
  drop column if exists tight_paper_entry_price,
  drop column if exists tight_paper_entry_time,
  drop column if exists tight_paper_consecutive_tps,
  drop column if exists tight_real_locked,
  drop column if exists tight_sim_side,
  drop column if exists tight_sim_entry_price,
  drop column if exists tight_sim_entry_time;
