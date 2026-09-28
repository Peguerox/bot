-- Live raw signal readout for Worker 2 -- see lighter_btc_initial_live_signal.sql's comment.

alter table lighter_btc_optimal_state
  add column if not exists live_k double precision,
  add column if not exists live_signal text;
