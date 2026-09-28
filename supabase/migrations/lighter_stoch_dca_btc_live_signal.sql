-- Live raw signal readout for Worker 3 -- see lighter_btc_initial_live_signal.sql's comment.

alter table lighter_stoch_dca_btc_state
  add column if not exists live_k double precision,
  add column if not exists live_signal text;
