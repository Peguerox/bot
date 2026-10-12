-- Trade-flow paper trade "swap" mode (2026-10-12, same day, direct request: "let's turn paper 2
-- into a swap bot"). Adds a mode switch on top of the existing threshold (TP/SL/trigger+trail)
-- behavior -- "threshold" (default, NULL) keeps the current behavior unchanged; "swap" is a
-- totally different, always-in-market rotation with no TP/SL at all.

alter table public.lighter_btc_initial_state
  add column if not exists override_trade_flow_paper_mode text;

alter table public.lighter_btc_worker4_state
  add column if not exists override_trade_flow_paper_mode text;
