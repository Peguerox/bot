-- Trade-flow ratio paper trade (2026-10-12): continuous paper-only shadow of the trade-flow
-- hypothesis validated earlier as a manual forward test, now running every tick inside Worker 1
-- and Worker 4. Never touches real money -- these columns only persist the in-flight paper
-- position across restarts, and the trade log records completed paper trades for the dashboard.

alter table public.lighter_btc_initial_state
  add column if not exists trade_flow_paper_side text,
  add column if not exists trade_flow_paper_entry_price double precision,
  add column if not exists trade_flow_paper_entry_time bigint,
  add column if not exists trade_flow_paper_peak_pct double precision,
  add column if not exists override_trade_flow_paper_enabled boolean,
  add column if not exists override_trade_flow_paper_long_threshold double precision,
  add column if not exists override_trade_flow_paper_short_threshold double precision,
  add column if not exists override_trade_flow_paper_tp_pct double precision,
  add column if not exists override_trade_flow_paper_trigger_pct double precision,
  add column if not exists override_trade_flow_paper_trail_pct double precision;

alter table public.lighter_btc_worker4_state
  add column if not exists trade_flow_paper_side text,
  add column if not exists trade_flow_paper_entry_price double precision,
  add column if not exists trade_flow_paper_entry_time bigint,
  add column if not exists trade_flow_paper_peak_pct double precision,
  add column if not exists override_trade_flow_paper_enabled boolean,
  add column if not exists override_trade_flow_paper_long_threshold double precision,
  add column if not exists override_trade_flow_paper_short_threshold double precision,
  add column if not exists override_trade_flow_paper_tp_pct double precision,
  add column if not exists override_trade_flow_paper_trigger_pct double precision,
  add column if not exists override_trade_flow_paper_trail_pct double precision;

-- Shared trade log across both bots, same worker_id-tagged pattern as lighter_btc_rsi_paper_trades.
create table if not exists public.lighter_btc_trade_flow_paper_trades (
  id bigint generated always as identity primary key,
  worker_id text not null,
  side text not null,
  entry_price double precision not null,
  exit_price double precision not null,
  pnl_pct double precision not null,
  reason text not null,
  entry_ratio double precision,
  opened_at timestamptz not null,
  closed_at timestamptz not null default now()
);

alter publication supabase_realtime add table public.lighter_btc_trade_flow_paper_trades;

alter table public.lighter_btc_trade_flow_paper_trades enable row level security;

create policy "anon_read" on public.lighter_btc_trade_flow_paper_trades for select to anon using (true);
