-- Sixth-pass profit-allocation accounting fixes (2026-10-18, fifth independent audit):
-- retry-safe profit/principal crediting and cover_drop's revolving principal return both need
-- new columns on the order ledger itself, recorded atomically with each fill.
alter table public.lighter_lit_grid_live_orders
  add column if not exists funded_from_bucket_usd numeric not null default 0,
  add column if not exists filled_quote numeric,
  add column if not exists realized_profit_usd numeric,
  add column if not exists bucket_principal_return_usd numeric not null default 0,
  add column if not exists profit_bucket_destination text,
  add column if not exists profit_credited boolean not null default false;
