create table if not exists public.btc_price_log (
  id          bigint generated always as identity primary key,
  logged_at   timestamptz not null default now(),
  us_price    numeric     not null,
  gl_price    numeric,
  spread_pct  numeric,
  us_ask      numeric,   -- best ask on Binance.US (what a buy would actually pay)
  us_ask_qty  numeric,   -- qty at best ask (liquidity)
  us_bid      numeric,   -- best bid on Binance.US (what a sell would actually receive)
  us_bid_qty  numeric    -- qty at best bid (liquidity)
);

-- for an existing table:
-- alter table public.btc_price_log add column if not exists us_ask numeric, add column if not exists us_ask_qty numeric,
--   add column if not exists us_bid numeric, add column if not exists us_bid_qty numeric;

-- index for time-range queries used in backtests
create index if not exists btc_price_log_logged_at_idx on public.btc_price_log (logged_at desc);

-- allow anon reads so the dashboard can query it
alter table public.btc_price_log enable row level security;
create policy "anon_read" on public.btc_price_log for select to anon using (true);
create policy "service_insert" on public.btc_price_log for insert to service_role with check (true);
