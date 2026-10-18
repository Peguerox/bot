-- Paper-only LIT/USDC grid bot (2026-10-18, direct request). No real money, no exchange
-- credentials -- it only reads Lighter's public LIT/USDC candle feed and simulates fills.
-- Runs as a second, isolated async task inside Worker 4's existing Render process
-- (server/lighter_stoch_dca_btc_worker4.py), not its own service.

create table if not exists public.lighter_lit_grid_state (
  id integer primary key default 1,
  enabled boolean not null default false,
  spacing_pct numeric not null default 0.125,
  levels_up integer not null default 15,
  levels_down integer not null default 15,
  capital_usd numeric not null default 10000,
  current_capital_usd numeric not null default 10000,
  compounding_enabled boolean not null default false,
  order_type text not null default 'limit' check (order_type in ('limit', 'market')),
  order_size_lit numeric,
  live_price numeric,
  live_level integer,
  open_positions_json jsonb not null default '{"buys": [], "sells": []}'::jsonb,
  history_reset_at timestamptz,
  lock_owner text,
  lock_heartbeat timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.lighter_lit_grid_state (id) values (1) on conflict (id) do nothing;

create table if not exists public.lighter_lit_grid_trades (
  id bigserial primary key,
  opened_at timestamptz not null,
  closed_at timestamptz not null default now(),
  side text not null, -- 'buy_then_sell' or 'sell_then_buy'
  entry_price numeric not null,
  exit_price numeric not null,
  qty_lit numeric not null,
  pnl_usd numeric not null,
  order_type text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.lighter_lit_grid_runs (
  id bigserial primary key,
  ran_at timestamptz not null default now(),
  action text not null,
  detail jsonb
);

alter publication supabase_realtime add table public.lighter_lit_grid_state;
alter publication supabase_realtime add table public.lighter_lit_grid_trades;
alter publication supabase_realtime add table public.lighter_lit_grid_runs;

alter table public.lighter_lit_grid_state  enable row level security;
alter table public.lighter_lit_grid_trades enable row level security;
alter table public.lighter_lit_grid_runs   enable row level security;

create policy "anon_read" on public.lighter_lit_grid_state  for select to anon using (true);
create policy "anon_read" on public.lighter_lit_grid_trades for select to anon using (true);
create policy "anon_read" on public.lighter_lit_grid_runs   for select to anon using (true);
