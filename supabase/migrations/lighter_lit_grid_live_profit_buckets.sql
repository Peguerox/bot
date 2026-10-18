-- Profit allocation feature (2026-10-18, direct request): realized profit goes into exactly one
-- of three durable buckets, selected by profit_mode. Switching modes only changes where NEWLY
-- realized profit gets credited -- money already in a bucket stays there for its own purpose.
alter table public.lighter_lit_grid_live_state
  add column if not exists profit_mode text not null default 'rest',
  add column if not exists profit_bucket_rest_usd numeric not null default 0,
  add column if not exists profit_bucket_cover_drop_usd numeric not null default 0,
  add column if not exists profit_bucket_compound_usd numeric not null default 0;

alter table public.lighter_lit_grid_live_state
  drop constraint if exists lighter_lit_grid_live_state_profit_mode_check;
alter table public.lighter_lit_grid_live_state
  add constraint lighter_lit_grid_live_state_profit_mode_check
  check (profit_mode in ('rest', 'cover_drop', 'compound'));
