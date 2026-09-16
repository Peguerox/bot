-- New Bitfinex-native versions of the two Surfer bots (SOLBTC buffered rotation, SOLUSD
-- RSI/EMA/trailing), built alongside the existing Binance.US ones (surfer_state / surfer_usdt_state)
-- rather than replacing them in place -- the Binance.US bots keep running real money on their own
-- tables until this is tested and explicitly cut over. Both new bots start enabled=false.
--
-- Execution model is WS-native (like Worker 2 / Hypertrade), not limit-chase: Bitfinex market
-- orders over the authenticated WS resolve immediately, so there's no chase_order_id/chase_price/
-- "chasing_buy"/"chasing_sell" state machine needed here, unlike the Binance.US versions.

create table if not exists public.surfer_bfx_solbtc_state (
  id integer primary key default 1,
  enabled boolean not null default false,
  mode text not null default 'BTC',              -- 'BTC' | 'SOL'
  sol_quantity numeric,
  entry_price numeric,                            -- SOLBTC price at entry
  entry_btc numeric,
  entry_time timestamptz,
  anchor numeric,                                 -- R at entry (for M = R/anchor)
  peak numeric,                                   -- running max of R while in SOL
  last_candle_ts bigint,                          -- last processed closed 1m candle (ms)
  realized_pnl_btc numeric not null default 0,
  total_trades integer not null default 0,
  total_wins integer not null default 0,
  lock_owner text,
  lock_heartbeat timestamptz
);
insert into public.surfer_bfx_solbtc_state (id) values (1) on conflict (id) do nothing;

create table if not exists public.surfer_bfx_solbtc_trades (
  id bigserial primary key,
  buy_price numeric,
  sell_price numeric,
  sol_quantity numeric,
  btc_in numeric,
  btc_out numeric,
  pnl_btc numeric,
  pnl_pct numeric,
  entry_time timestamptz,
  exit_time timestamptz not null default now()
);

create table if not exists public.surfer_bfx_solbtc_runs (
  id bigserial primary key,
  run_at timestamptz not null default now(),
  data jsonb
);

create table if not exists public.surfer_bfx_solusd_state (
  id integer primary key default 1,
  enabled boolean not null default false,
  mode text not null default 'USD',               -- 'USD' | 'SOL'
  sol_quantity numeric,
  entry_price numeric,
  entry_usd numeric,
  entry_time timestamptz,
  armed_for_sol boolean not null default false,
  best_pct numeric not null default 0,
  last_candle_ts bigint,                           -- last processed closed 15m candle (ms)
  usd_balance numeric not null default 50,
  realized_pnl_usd numeric not null default 0,
  total_trades integer not null default 0,
  total_wins integer not null default 0,
  lock_owner text,
  lock_heartbeat timestamptz
);
insert into public.surfer_bfx_solusd_state (id) values (1) on conflict (id) do nothing;

create table if not exists public.surfer_bfx_solusd_trades (
  id bigserial primary key,
  entry_price numeric,
  exit_price numeric,
  sol_quantity numeric,
  usd_in numeric,
  usd_out numeric,
  pnl_usd numeric,
  pnl_pct numeric,
  entry_time timestamptz,
  exit_time timestamptz not null default now()
);

create table if not exists public.surfer_bfx_solusd_runs (
  id bigserial primary key,
  run_at timestamptz not null default now(),
  data jsonb
);
