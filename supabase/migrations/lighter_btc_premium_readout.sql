-- Perp premium / funding readout (2026-10-12, direct request after explaining what funding is:
-- "ok let's build the signal, put it in the wiggle panel"). live_premium is the one real signal
-- (mark-vs-index spread, a live read on crowd positioning); live_current_funding_rate rides
-- alongside purely as a $-meaningful reference number, not a second independent signal. Pushed
-- from Lighter's market_stats websocket channel -- see StochBot.run_premium_forever.

alter table public.lighter_btc_initial_state
  add column if not exists live_premium double precision,
  add column if not exists live_current_funding_rate double precision;

alter table public.lighter_btc_worker4_state
  add column if not exists live_premium double precision,
  add column if not exists live_current_funding_rate double precision;
