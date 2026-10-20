-- Rest bucket cap + overflow destination + recorded withdrawals (2026-10-20).
alter table public.lighter_lit_grid_live_state
  add column if not exists rest_cap_usd double precision,
  add column if not exists rest_overflow_to text,
  add column if not exists rest_withdrawn_usd double precision not null default 0;
