-- SOL/BTC "participation" hybrid strategy (fast CUSUM + slow trend + price confirmation,
-- mode-switching controller) -- PAPER, Worker 1. Verified against the exact C++ research engine
-- (reproduced 2026-09-16, matched published results to 6 decimal places) before this table was
-- created. Simulated cost 0.02%/side deducted from paper balance on every swap (deliberately more
-- conservative than the measured real Bitfinex spread of ~0.01555%/side -- see docs).
create table if not exists public.solbtc_participation_state (
  id integer primary key default 1,
  enabled boolean not null default false,

  -- actual paper position
  side text not null default 'BTC',        -- 'BTC' | 'SOL'
  btc_balance numeric not null default 1,  -- physical paper balance, BTC terms
  sol_qty numeric not null default 0,
  pending text,                             -- null | 'BTC' | 'SOL' -- queued actual fill (next open)

  -- virtual/paper CUSUM scoring position (separate from actual)
  virtual_side text not null default 'BTC', -- 'BTC' | 'SOL'
  virtual_pending text,                     -- null | 'BTC' | 'SOL'

  -- fast CUSUM state
  base text not null default 'BTC',         -- 'BTC' | 'SOL', virtual regime
  v numeric not null default 0,             -- fast volatility EWMA
  s_up numeric not null default 0,
  s_down numeric not null default 0,

  -- paper score state
  d numeric not null default 0,
  score_v numeric not null default 0,
  m numeric not null default 0,
  score_t numeric not null default 0,
  orientation integer not null default 1,   -- +1 | -1

  -- slow trend + price confirmation state
  fast_ewma numeric,                        -- null until seeded from first close
  slow_ewma numeric,
  trend_variance numeric not null default 0,
  trend integer not null default 0,         -- 0 | 1
  price_ok integer not null default 0,      -- 0 | 1
  fast_mode integer not null default 0,     -- 0 | 1

  last_log_price numeric,                   -- for computing r_t each new candle
  last_candle_ts bigint,                    -- last processed closed 1m candle (epoch ms)

  realized_pnl_btc numeric not null default 0,
  total_trades integer not null default 0,
  total_wins integer not null default 0,

  lock_owner text,
  lock_heartbeat timestamptz
);
insert into public.solbtc_participation_state (id) values (1) on conflict (id) do nothing;

create table if not exists public.solbtc_participation_trades (
  id bigserial primary key,
  side_after text,           -- 'BTC' | 'SOL'
  fill_price numeric,
  btc_before numeric,
  sol_before numeric,
  btc_after numeric,
  sol_after numeric,
  pnl_btc numeric,
  fill_time timestamptz not null default now()
);

create table if not exists public.solbtc_participation_runs (
  id bigserial primary key,
  run_at timestamptz not null default now(),
  data jsonb
);

alter publication supabase_realtime add table solbtc_participation_state;
alter publication supabase_realtime add table solbtc_participation_trades;
alter publication supabase_realtime add table solbtc_participation_runs;

alter table public.solbtc_participation_state  enable row level security;
alter table public.solbtc_participation_trades enable row level security;
alter table public.solbtc_participation_runs   enable row level security;

create policy "anon_read" on public.solbtc_participation_state  for select to anon using (true);
create policy "anon_read" on public.solbtc_participation_trades for select to anon using (true);
create policy "anon_read" on public.solbtc_participation_runs   for select to anon using (true);
