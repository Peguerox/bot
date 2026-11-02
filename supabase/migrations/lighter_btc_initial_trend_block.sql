-- Worker 1 "block against the 30-min trend" pill (owner, 2026-11-02). Starts OFF.
alter table public.lighter_btc_initial_state
  add column if not exists override_trend_block_enabled boolean,
  add column if not exists override_trend_block_er double precision,
  add column if not exists override_trend_block_minutes integer,
  add column if not exists live_trend_er double precision,
  add column if not exists live_trend_dir text;
