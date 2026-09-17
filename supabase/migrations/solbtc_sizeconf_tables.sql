-- SOL/BTC "size confirmation" live paper bot -- Worker 1's new strategy (2026-09-17), replacing
-- the archived Participation bot (see docs/archive/README_shelved_participation_bot.md).
-- Built from the checklist in _TEMPLATE_new_bot_tables.sql: publication + RLS + anon_read policy
-- included from the start this time, not as a follow-up fix.

create table if not exists public.solbtc_sizeconf_state (
  id integer primary key default 1,
  enabled boolean not null default false,

  side text not null default 'BTC',        -- 'BTC' | 'SOL'
  pending text,                             -- 'BTC' | 'SOL' | null
  queued_ts double precision,               -- seconds, request time of the pending swap
  last_fill_ts double precision not null default -1e18,

  btc_balance double precision not null default 1,
  sol_qty double precision not null default 0,

  u double precision not null default 0,
  w double precision not null default 0,
  ut double precision not null default 0,
  wt double precision not null default 0,
  last_tiny_ts double precision not null default -1e18,

  last_log_price double precision,
  q_lag_prev double precision not null default 0,
  resp_num double precision not null default 0,
  resp_den double precision not null default 0,
  resp_buf jsonb not null default '[]'::jsonb,   -- rolling <=300s window of {ts,num,den}

  active boolean not null default false,
  minute_buf jsonb not null default '[]'::jsonb, -- rolling <=30 completed minutes of {movementBps,count}
  window_mv double precision not null default 0,
  window_ct double precision not null default 0,
  prev_minute_close double precision,
  last_closed_minute bigint,                -- minute index (epoch ms / 60000) already fed to closeMinute()
  current_minute_count integer not null default 0,
  current_minute_last_price double precision,

  entry_btc double precision,               -- BTC value at moment of entering SOL, for realized PnL on return leg
  realized_pnl_btc double precision not null default 0,
  total_trades integer not null default 0,
  total_wins integer not null default 0,

  last_tick_at timestamptz,          -- real-time freshness signal: last trade tick seen over the WS

  lock_owner text,
  lock_heartbeat timestamptz
);
insert into public.solbtc_sizeconf_state (id) values (1) on conflict (id) do nothing;

create table if not exists public.solbtc_sizeconf_trades (
  id bigserial primary key,
  fill_time timestamptz not null default now(),
  side_after text not null,
  fill_price double precision not null,
  btc_before double precision not null,
  sol_before double precision not null,
  btc_after double precision not null,
  sol_after double precision not null,
  pnl_btc double precision
);

create table if not exists public.solbtc_sizeconf_runs (
  id bigserial primary key,
  run_at timestamptz not null default now(),
  data jsonb
);

alter publication supabase_realtime add table public.solbtc_sizeconf_state;
alter publication supabase_realtime add table public.solbtc_sizeconf_trades;
alter publication supabase_realtime add table public.solbtc_sizeconf_runs;

alter table public.solbtc_sizeconf_state  enable row level security;
alter table public.solbtc_sizeconf_trades enable row level security;
alter table public.solbtc_sizeconf_runs   enable row level security;

create policy "anon_read" on public.solbtc_sizeconf_state  for select to anon using (true);
create policy "anon_read" on public.solbtc_sizeconf_trades for select to anon using (true);
create policy "anon_read" on public.solbtc_sizeconf_runs   for select to anon using (true);
