-- Trade-flow paper trade follow-up (2026-10-12, same day): adds a stop-loss (originally
-- deliberately omitted, added back after watching a real paper position sit at -0.31%
-- unrealized with nothing to catch it) and a non-destructive Reset cutoff, same pattern as
-- every other reset in this file.

alter table public.lighter_btc_initial_state
  add column if not exists override_trade_flow_paper_sl_pct double precision,
  add column if not exists trade_flow_paper_history_reset_at timestamptz;

alter table public.lighter_btc_worker4_state
  add column if not exists override_trade_flow_paper_sl_pct double precision,
  add column if not exists trade_flow_paper_history_reset_at timestamptz;
