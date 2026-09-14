-- SOL double-crossover controller (Worker 1 replacement). Paper-only. Continuous variable-exposure
-- strategy (0-53% of equity in SOL), not a DCA grid -- no positions/levels/tp_target, just
-- cash/SOL split plus the running EMA state the signal is computed from. Seeded at $1000 (not
-- $500) to stay above the real Bitfinex minimum-order cliff found during research -- see
-- docs/adaptive_exposure_family.md.
create table if not exists sol_double_crossover_state (
  id integer primary key default 1,
  enabled boolean not null default false,
  cash numeric not null default 1000,
  sol_qty numeric not null default 0,
  avg_cost numeric,
  pending_target numeric,
  pending_since timestamptz,
  ema_360 numeric,
  ema_4320 numeric,
  ema_1440 numeric,
  ema_10080 numeric,
  r_bar numeric,
  seeded boolean not null default false,
  last_minute_ts timestamptz,
  realized_pnl_usd numeric not null default 0,
  total_trades integer not null default 0,
  total_wins integer not null default 0,
  lock_owner text,
  lock_heartbeat timestamptz
);

insert into sol_double_crossover_state (id, enabled)
values (1, false)
on conflict (id) do nothing;

create table if not exists sol_double_crossover_trades (
  id bigserial primary key,
  side text not null,
  price numeric not null,
  qty numeric not null,
  usd_amount numeric not null,
  pnl_usd numeric,
  trade_time timestamptz not null
);

create table if not exists sol_double_crossover_runs (
  id bigserial primary key,
  run_at timestamptz not null,
  data jsonb not null
);

create index if not exists idx_sol_double_crossover_runs_run_at on sol_double_crossover_runs (run_at desc);
create index if not exists idx_sol_double_crossover_trades_trade_time on sol_double_crossover_trades (trade_time desc);

alter table public.sol_double_crossover_state  enable row level security;
alter table public.sol_double_crossover_trades enable row level security;
alter table public.sol_double_crossover_runs   enable row level security;

create policy "anon_read" on public.sol_double_crossover_state  for select to anon using (true);
create policy "anon_read" on public.sol_double_crossover_trades for select to anon using (true);
create policy "anon_read" on public.sol_double_crossover_runs   for select to anon using (true);
