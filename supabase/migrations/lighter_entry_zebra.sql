-- Record the zebra (candle-size/alternation) index at every trade's entry, same as
-- entry_dispersion/entry_balance_index/entry_k already are (2026-10-13, direct request:
-- "make sure we record the zebra values for the trades... I think the hedge bot will benefit
-- from this info since we need big candles with lots of variation for hedge to work").
-- Previously only ever a live readout (live_zebra_index, overwritten every tick), never
-- persisted per trade -- answering "did zebra matter" always meant reconstructing it from raw
-- candle history after the fact. Covers every table with schema_has_entry_features=True:
-- Worker 1, Worker 4, and both hedge legs.

alter table public.lighter_btc_initial_trades
  add column if not exists entry_zebra double precision;

alter table public.lighter_btc_worker4_trades
  add column if not exists entry_zebra double precision;

alter table public.lighter_btc_optimal_trades
  add column if not exists entry_zebra double precision;

alter table public.lighter_stoch_dca_btc_trades
  add column if not exists entry_zebra double precision;
