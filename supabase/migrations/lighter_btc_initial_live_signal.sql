-- Live raw signal readout (2026-09-28): the current stochastic K value and its direction
-- (long/short/neutral), regardless of which signal mode is active -- what the paper bot is
-- looking at right now.

alter table lighter_btc_initial_state
  add column if not exists live_k double precision,
  add column if not exists live_signal text;
