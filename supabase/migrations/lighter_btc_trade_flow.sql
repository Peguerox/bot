-- Trade-flow logger (2026-09-26): records actual executed trades (size, price, aggressor side)
-- from Lighter's public recentTrades endpoint -- distinct from lighter_btc_price_ticks, which
-- only logs best bid/ask quote snapshots, never executed trades or order-flow direction. Built
-- to eventually compare real order flow around moments the stochastic signal was right vs wrong
-- (e.g. SL losses) -- that endpoint is live-only with no historical backfill, so this starts
-- collecting from now forward; past trades can't be reconstructed.
--
-- is_maker_ask=true means the resting order was an ask (sell) -> the taker/aggressor bought.
-- is_maker_ask=false means the resting order was a bid (buy) -> the taker/aggressor sold.

create table if not exists lighter_btc_trade_flow (
  id bigint generated always as identity primary key,
  trade_id bigint not null unique,
  ts timestamptz not null,
  price double precision not null,
  size double precision not null,
  usd_amount double precision not null,
  is_maker_ask boolean not null,
  source text not null
);

create index if not exists lighter_btc_trade_flow_ts_idx on lighter_btc_trade_flow (ts);

alter publication supabase_realtime add table public.lighter_btc_trade_flow;

alter table public.lighter_btc_trade_flow enable row level security;

create policy "anon_read" on public.lighter_btc_trade_flow for select to anon using (true);
