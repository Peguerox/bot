-- Tables for the "initial" and "optimal" Lighter BTC Stoch5 bot variants, run side by side with
-- Worker 3 (the current-settings variant, already using lighter_stoch_dca_btc_*) for a real,
-- simultaneous A/B/C comparison at $100 each.

create table if not exists lighter_btc_initial_state (
  id int primary key default 1,
  side text,
  legs jsonb not null default '[]',
  first_entry_price double precision,
  first_entry_time bigint,
  dca_level int not null default 0,
  last_dca_minute bigint,
  seed_usd double precision not null default 100,
  realized_pnl_usd double precision not null default 0,
  last_processed_candle_ts bigint,
  collateral_before_entry double precision,
  updated_at timestamptz not null default now()
);
insert into lighter_btc_initial_state (id) values (1) on conflict (id) do nothing;

create table if not exists lighter_btc_initial_trades (
  id bigserial primary key,
  side text not null,
  avg_entry_price double precision not null,
  exit_price double precision not null,
  base_amount_btc double precision not null,
  pnl_usd double precision not null,
  reason text not null,
  legs_used int not null,
  opened_at timestamptz not null,
  closed_at timestamptz not null default now()
);

create table if not exists lighter_btc_initial_runs (
  id bigserial primary key,
  ran_at timestamptz not null default now(),
  action text not null,
  detail jsonb
);

create table if not exists lighter_btc_optimal_state (
  id int primary key default 1,
  side text,
  legs jsonb not null default '[]',
  first_entry_price double precision,
  first_entry_time bigint,
  dca_level int not null default 0,
  last_dca_minute bigint,
  seed_usd double precision not null default 100,
  realized_pnl_usd double precision not null default 0,
  last_processed_candle_ts bigint,
  collateral_before_entry double precision,
  updated_at timestamptz not null default now()
);
insert into lighter_btc_optimal_state (id) values (1) on conflict (id) do nothing;

create table if not exists lighter_btc_optimal_trades (
  id bigserial primary key,
  side text not null,
  avg_entry_price double precision not null,
  exit_price double precision not null,
  base_amount_btc double precision not null,
  pnl_usd double precision not null,
  reason text not null,
  legs_used int not null,
  opened_at timestamptz not null,
  closed_at timestamptz not null default now()
);

create table if not exists lighter_btc_optimal_runs (
  id bigserial primary key,
  ran_at timestamptz not null default now(),
  action text not null,
  detail jsonb
);

alter publication supabase_realtime add table public.lighter_btc_initial_state;
alter publication supabase_realtime add table public.lighter_btc_initial_trades;
alter publication supabase_realtime add table public.lighter_btc_initial_runs;
alter publication supabase_realtime add table public.lighter_btc_optimal_state;
alter publication supabase_realtime add table public.lighter_btc_optimal_trades;
alter publication supabase_realtime add table public.lighter_btc_optimal_runs;

alter table public.lighter_btc_initial_state  enable row level security;
alter table public.lighter_btc_initial_trades enable row level security;
alter table public.lighter_btc_initial_runs   enable row level security;
alter table public.lighter_btc_optimal_state  enable row level security;
alter table public.lighter_btc_optimal_trades enable row level security;
alter table public.lighter_btc_optimal_runs   enable row level security;

create policy "anon_read" on public.lighter_btc_initial_state  for select to anon using (true);
create policy "anon_read" on public.lighter_btc_initial_trades for select to anon using (true);
create policy "anon_read" on public.lighter_btc_initial_runs   for select to anon using (true);
create policy "anon_read" on public.lighter_btc_optimal_state  for select to anon using (true);
create policy "anon_read" on public.lighter_btc_optimal_trades for select to anon using (true);
create policy "anon_read" on public.lighter_btc_optimal_runs   for select to anon using (true);
