-- RSI paper test (2026-09-26): Worker 1 shadow-tests "Confirmed Stochastic RSI" alongside its
-- real trading. Never touches real money -- these columns only persist the in-flight paper
-- position across restarts, and the trade log records completed paper trades for analysis.

alter table lighter_btc_initial_state
  add column if not exists rsi_paper_side text,
  add column if not exists rsi_paper_entry_price double precision,
  add column if not exists rsi_paper_entry_time bigint;

create table if not exists lighter_btc_rsi_paper_trades (
  id bigint generated always as identity primary key,
  worker_id text not null,
  side text not null,
  entry_price double precision not null,
  exit_price double precision not null,
  pnl_pct double precision not null,
  reason text not null,
  opened_at timestamptz not null,
  closed_at timestamptz not null default now()
);
