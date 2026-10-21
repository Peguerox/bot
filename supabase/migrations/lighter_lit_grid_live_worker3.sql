-- Worker 3 twin of the real-money LIT/USDC grid bot (2026-10-21, direct request): a second live
-- instance of the same bot, on Worker 3's own Lighter sub-account (WORKER3_LIGHTER_* env vars),
-- running alongside Worker 4's existing instance on the same Render service, at a DIFFERENT
-- spacing, to compare real results. Entirely separate tables from Worker 4's -- never shared,
-- never cross-read -- same "real capital kept entirely distinct" principle as the original
-- schema. Column-for-column match of lighter_lit_grid_live_{state,orders,runs} as they stand
-- today (2026-10-21), after every follow-up migration applied to Worker 4's tables since
-- 2026-10-18 (anchor, dynamic drawdown, profit buckets, rest cap, order_kind, etc.) --
-- pulled directly from the live schema, not replayed from each incremental migration file.

create table if not exists public.lighter_lit_grid_live_worker3_state (
  id int primary key default 1,
  enabled boolean not null default false,
  spacing_pct numeric not null default 0.125,
  levels_up int not null default 15,
  levels_down int not null default 15,
  capital_usd numeric not null default 500,
  drawdown_pct numeric not null default 10,
  order_size_lit numeric,
  live_price numeric,
  usdc_balance numeric,
  lit_balance numeric,
  flatten_requested boolean not null default false,
  history_reset_at timestamptz,
  lock_owner text,
  lock_heartbeat timestamptz,
  updated_at timestamptz not null default now(),
  internal_spacing_pct numeric,
  max_open_buys int default 1,
  lifetime_buy_count int not null default 0,
  profit_mode text not null default 'rest',
  profit_bucket_rest_usd numeric not null default 0,
  profit_bucket_cover_drop_usd numeric not null default 0,
  profit_bucket_compound_usd numeric not null default 0,
  grid_anchor_price double precision,
  drawdown_coverage_pct double precision,
  dynamic_dd_enabled boolean not null default false,
  dynamic_dd_high double precision,
  dynamic_dd_tier double precision,
  rest_cap_usd double precision,
  rest_overflow_to text,
  rest_withdrawn_usd double precision not null default 0,
  constraint single_row check (id = 1)
);
insert into public.lighter_lit_grid_live_worker3_state (id) values (1) on conflict (id) do nothing;

create table if not exists public.lighter_lit_grid_live_worker3_orders (
  id bigserial primary key,
  level int not null,
  side text not null check (side in ('buy', 'sell')),
  client_order_index bigint not null,
  exchange_order_id bigint,
  status text not null default 'pending'
    check (status in ('pending', 'open', 'filled', 'cancelled', 'rejected')),
  limit_price numeric not null,
  size numeric not null,
  filled_price numeric,
  filled_qty numeric,
  error text,
  placed_at timestamptz not null default now(),
  filled_at timestamptz,
  created_at timestamptz not null default now(),
  closes_level int,
  funded_from_bucket_usd numeric not null default 0,
  filled_quote numeric,
  realized_profit_usd numeric,
  bucket_principal_return_usd numeric not null default 0,
  profit_bucket_destination text,
  profit_credited boolean not null default false,
  order_kind text
);
create index if not exists lighter_lit_grid_live_worker3_orders_status_idx
  on public.lighter_lit_grid_live_worker3_orders (status);
create index if not exists lighter_lit_grid_live_worker3_orders_client_order_index_idx
  on public.lighter_lit_grid_live_worker3_orders (client_order_index);
create index if not exists lighter_lit_grid_live_worker3_orders_level_idx
  on public.lighter_lit_grid_live_worker3_orders (level);

create table if not exists public.lighter_lit_grid_live_worker3_runs (
  id bigserial primary key,
  ran_at timestamptz not null default now(),
  action text not null,
  detail jsonb
);
create index if not exists lighter_lit_grid_live_worker3_runs_ran_at_idx
  on public.lighter_lit_grid_live_worker3_runs (ran_at desc);

alter table public.lighter_lit_grid_live_worker3_state enable row level security;
alter table public.lighter_lit_grid_live_worker3_orders enable row level security;
alter table public.lighter_lit_grid_live_worker3_runs enable row level security;

create policy "anon_read" on public.lighter_lit_grid_live_worker3_state for select to anon using (true);
create policy "anon_read" on public.lighter_lit_grid_live_worker3_orders for select to anon using (true);
create policy "anon_read" on public.lighter_lit_grid_live_worker3_runs for select to anon using (true);

alter publication supabase_realtime add table public.lighter_lit_grid_live_worker3_state;
alter publication supabase_realtime add table public.lighter_lit_grid_live_worker3_orders;
