-- Real order-book price history for Lighter BTC, recorded by whichever of the 3 workers is
-- alive at each moment. Purpose: let a backtest replay real tick-by-tick bid/ask instead of
-- 1-min candle high/low, which a same-window comparison against real trades (2026-09-22)
-- showed diverges significantly from what actually happens live.
--
-- All 3 workers write here independently (redundant on purpose) -- whichever bot restarts,
-- the other two keep the recording continuous with no gap. Same market, so it doesn't matter
-- which bot's row is used for a given second at read time.
create table if not exists lighter_btc_price_ticks (
  id         bigserial primary key,
  ts         timestamptz not null default now(),
  best_bid   double precision not null,
  best_ask   double precision not null,
  source     text not null  -- which worker wrote this row (worker1/worker2/worker3)
);
create index if not exists lighter_btc_price_ticks_ts_idx on lighter_btc_price_ticks (ts);

-- Writes always come from the bots (service role, bypasses RLS by default); this policy is
-- only for read access, matching the pattern used on market_ticks.
alter table lighter_btc_price_ticks enable row level security;
create policy "public read" on lighter_btc_price_ticks for select using (true);
