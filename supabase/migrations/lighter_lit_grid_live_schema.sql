-- Real-money LIT/USDC grid bot (2026-10-18). Separate tables from the paper bot
-- (lighter_lit_grid_*) -- this is real capital on Worker 4's sub-account, kept entirely distinct.
--
-- lighter_lit_grid_live_orders is the core safety-net ledger the user asked for directly: one
-- row per REAL order ever placed, written before the order is even sent (status='pending'),
-- updated in place as its real status resolves. Never a new row per event -- a stable identity
-- from placement to resolution is what lets a restart ask "what's still pending?" and get a
-- real answer from the exchange, not a guess from memory.

create table if not exists public.lighter_lit_grid_live_state (
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
  constraint single_row check (id = 1)
);
insert into public.lighter_lit_grid_live_state (id) values (1) on conflict (id) do nothing;

create table if not exists public.lighter_lit_grid_live_orders (
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
  created_at timestamptz not null default now()
);
create index if not exists lighter_lit_grid_live_orders_status_idx
  on public.lighter_lit_grid_live_orders (status);
create index if not exists lighter_lit_grid_live_orders_client_order_index_idx
  on public.lighter_lit_grid_live_orders (client_order_index);
create index if not exists lighter_lit_grid_live_orders_level_idx
  on public.lighter_lit_grid_live_orders (level);

create table if not exists public.lighter_lit_grid_live_runs (
  id bigserial primary key,
  ran_at timestamptz not null default now(),
  action text not null,
  detail jsonb
);
create index if not exists lighter_lit_grid_live_runs_ran_at_idx
  on public.lighter_lit_grid_live_runs (ran_at desc);

alter table public.lighter_lit_grid_live_state enable row level security;
alter table public.lighter_lit_grid_live_orders enable row level security;
alter table public.lighter_lit_grid_live_runs enable row level security;

create policy "anon_read" on public.lighter_lit_grid_live_state for select to anon using (true);
create policy "anon_read" on public.lighter_lit_grid_live_orders for select to anon using (true);
create policy "anon_read" on public.lighter_lit_grid_live_runs for select to anon using (true);

alter publication supabase_realtime add table public.lighter_lit_grid_live_state;
alter publication supabase_realtime add table public.lighter_lit_grid_live_orders;
