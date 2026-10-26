-- LIT grid sizing mode "Curve" (2026-10-25): size(p) = floor + (B - R)/W * ((p - F)/(P - F))^n
alter table public.lighter_lit_grid_live_worker3_state
  add column if not exists curve_enabled boolean not null default false,
  add column if not exists curve_n numeric not null default 10,
  add column if not exists curve_floor_lit numeric not null default 1,
  add column if not exists curve_top numeric,
  add column if not exists curve_cash_usd numeric,
  add column if not exists curve_profit_base_usd numeric,
  add column if not exists curve_state jsonb;
