-- SOL hypertrading paper bot (Worker 2 replacement). Paper-only -- no real orders, no real money --
-- but uses live WebSocket bid/ask from Bitfinex for realistic fills, with unlimited position
-- sizing so we can observe the real-world worst-case DCA depth against live execution.
create table if not exists sol_hypertrade_paper_state (
  id integer primary key default 1,
  enabled boolean not null default false,
  positions jsonb not null default '[]'::jsonb,
  total_cost numeric not null default 0,
  level integer not null default 0,
  last_entry_price numeric,
  tp_target numeric,
  cycle_start_time timestamptz,
  realized_pnl_usd numeric not null default 0,
  total_cycles integer not null default 0,
  total_wins integer not null default 0,
  max_level_ever integer not null default 0,
  max_cost_ever numeric not null default 0,
  lock_owner text,
  lock_heartbeat timestamptz
);

insert into sol_hypertrade_paper_state (id, enabled)
values (1, false)
on conflict (id) do nothing;

create table if not exists sol_hypertrade_paper_trades (
  id bigserial primary key,
  levels integer not null,
  total_cost numeric not null,
  proceeds numeric not null,
  pnl_usd numeric not null,
  pnl_pct numeric not null,
  entry_time timestamptz not null,
  exit_time timestamptz not null,
  bars_held_ms bigint not null
);

create table if not exists sol_hypertrade_paper_runs (
  id bigserial primary key,
  run_at timestamptz not null,
  data jsonb not null
);

create index if not exists idx_sol_hypertrade_paper_runs_run_at on sol_hypertrade_paper_runs (run_at desc);
create index if not exists idx_sol_hypertrade_paper_trades_exit_time on sol_hypertrade_paper_trades (exit_time desc);

alter table public.sol_hypertrade_paper_state  enable row level security;
alter table public.sol_hypertrade_paper_trades enable row level security;
alter table public.sol_hypertrade_paper_runs   enable row level security;

create policy "anon_read" on public.sol_hypertrade_paper_state  for select to anon using (true);
create policy "anon_read" on public.sol_hypertrade_paper_trades for select to anon using (true);
create policy "anon_read" on public.sol_hypertrade_paper_runs   for select to anon using (true);
