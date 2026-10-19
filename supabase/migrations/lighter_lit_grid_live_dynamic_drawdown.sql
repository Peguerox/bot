-- Dynamic drawdown toggle for the live LIT grid bot (2026-10-19).
alter table public.lighter_lit_grid_live_state
  add column if not exists dynamic_dd_enabled boolean not null default false,
  add column if not exists dynamic_dd_high double precision,
  add column if not exists dynamic_dd_tier double precision;
