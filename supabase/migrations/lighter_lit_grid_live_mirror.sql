-- Mirror bot (2026-10-27, owner's request): fresh capital on Worker 4's emptied sub-account, same
-- code as Worker 3, mirror curve (peak -10%) + crash reserve at 0.25%. New tables copied from
-- Worker 3's (Worker 4's old lighter_lit_grid_live_* ledger stays as history). Also adds the
-- mirror/reserve columns to Worker 3 (off there; the panel shows the controls for both).

-- 1. New columns (both bots)
alter table public.lighter_lit_grid_live_worker3_state
  add column if not exists curve_peak_pct double precision not null default 0,
  add column if not exists reserve_enabled boolean not null default false,
  add column if not exists reserve_share_pct double precision not null default 100,
  add column if not exists reserve_deploy_pct double precision not null default 30,
  add column if not exists reserve_profit_base_usd double precision,
  add column if not exists reserve_deploys int not null default 0,
  add column if not exists reserve_last_deploy_at timestamptz;

-- 2. Mirror tables, same columns and defaults as Worker 3's, each with its own id sequence
create table if not exists public.lighter_lit_grid_live_mirror_state
  (like public.lighter_lit_grid_live_worker3_state including defaults including constraints);
alter table public.lighter_lit_grid_live_mirror_state drop constraint if exists lighter_lit_grid_live_mirror_state_pkey;
alter table public.lighter_lit_grid_live_mirror_state add primary key (id);

create table if not exists public.lighter_lit_grid_live_mirror_orders
  (like public.lighter_lit_grid_live_worker3_orders including defaults including constraints);
create sequence if not exists public.lighter_lit_grid_live_mirror_orders_id_seq
  owned by public.lighter_lit_grid_live_mirror_orders.id;
alter table public.lighter_lit_grid_live_mirror_orders
  alter column id set default nextval('public.lighter_lit_grid_live_mirror_orders_id_seq'),
  add primary key (id);
create index if not exists lighter_lit_grid_live_mirror_orders_status_idx
  on public.lighter_lit_grid_live_mirror_orders (status);
create index if not exists lighter_lit_grid_live_mirror_orders_client_order_index_idx
  on public.lighter_lit_grid_live_mirror_orders (client_order_index);
create index if not exists lighter_lit_grid_live_mirror_orders_level_idx
  on public.lighter_lit_grid_live_mirror_orders (level);

create table if not exists public.lighter_lit_grid_live_mirror_runs
  (like public.lighter_lit_grid_live_worker3_runs including defaults);
create sequence if not exists public.lighter_lit_grid_live_mirror_runs_id_seq
  owned by public.lighter_lit_grid_live_mirror_runs.id;
alter table public.lighter_lit_grid_live_mirror_runs
  alter column id set default nextval('public.lighter_lit_grid_live_mirror_runs_id_seq'),
  add primary key (id);
create index if not exists lighter_lit_grid_live_mirror_runs_ran_at_idx
  on public.lighter_lit_grid_live_mirror_runs (ran_at desc);

-- 3. The one state row: OFF, $0 investment until money is deposited, 0.25%, compound,
--    curve n=10 with its peak at -10%, crash reserve on (100% of profit, deploy at -30%).
insert into public.lighter_lit_grid_live_mirror_state
  (id, enabled, spacing_pct, levels_up, levels_down, capital_usd, profit_mode, engine_v2_enabled,
   curve_enabled, curve_n, curve_floor_lit, curve_peak_pct,
   reserve_enabled, reserve_share_pct, reserve_deploy_pct)
values (1, false, 0.25, 10, 10, 1, 'compound', true,
        true, 10, 1, 10,
        true, 100, 30)
on conflict (id) do nothing;

-- 4. Dashboard read access + live updates
alter table public.lighter_lit_grid_live_mirror_state enable row level security;
alter table public.lighter_lit_grid_live_mirror_orders enable row level security;
alter table public.lighter_lit_grid_live_mirror_runs enable row level security;
create policy "anon_read" on public.lighter_lit_grid_live_mirror_state for select to anon using (true);
create policy "anon_read" on public.lighter_lit_grid_live_mirror_orders for select to anon using (true);
create policy "anon_read" on public.lighter_lit_grid_live_mirror_runs for select to anon using (true);
alter publication supabase_realtime add table public.lighter_lit_grid_live_mirror_state;
alter publication supabase_realtime add table public.lighter_lit_grid_live_mirror_orders;
