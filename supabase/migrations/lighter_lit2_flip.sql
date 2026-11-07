-- LIT flip martingale #2 (owner, 2026-11-07): Worker 1's account trades LIT (market 120) with STOP-LIMIT flips, racing Worker 2
-- (same settings, stop-market flips). Same layout as lighter_lit_flip_*. Starts OFF.
create table if not exists public.lighter_lit2_flip_state (
  id int primary key,
  enabled boolean not null default false,
  close_requested boolean not null default false,
  lock_owner text, lock_heartbeat timestamptz,
  flip_mode text not null default 'native',
  seq_id bigint, seq_side int, seq_qty double precision, seq_entry double precision,
  seq_level int, seq_ladder jsonb, seq_start_equity double precision,
  equity double precision, live_price double precision, live_signal int, live_pos double precision,
  sequences int not null default 0, wins int not null default 0, busts int not null default 0,
  realized_usd double precision not null default 0,
  updated_at timestamptz default now(),
  live_range_pos double precision, live_range_hi double precision, live_range_lo double precision, live_upnl double precision,
  override_params jsonb, seq_params jsonb, live_params jsonb,
  history_reset_at timestamptz, rate_excluded_hours numeric default 0
);
insert into public.lighter_lit2_flip_state (id, history_reset_at) values (1, now()) on conflict (id) do nothing;

create table if not exists public.lighter_lit2_flip_trades (
  id bigserial primary key,
  seq_id bigint, level int, side int, qty double precision, entry double precision, exit_price double precision,
  result text, pnl_usd double precision, at timestamptz not null default now()
);
create table if not exists public.lighter_lit2_flip_runs (
  id bigserial primary key, ran_at timestamptz not null default now(), action text, detail jsonb
);
create index if not exists lighter_lit2_flip_runs_ran_at_idx on public.lighter_lit2_flip_runs (ran_at desc);

alter table public.lighter_lit2_flip_state enable row level security;
alter table public.lighter_lit2_flip_trades enable row level security;
alter table public.lighter_lit2_flip_runs enable row level security;
create policy "anon_read" on public.lighter_lit2_flip_state for select to anon using (true);
create policy "anon_read" on public.lighter_lit2_flip_trades for select to anon using (true);
create policy "anon_read" on public.lighter_lit2_flip_runs for select to anon using (true);
