-- Gate-dependent spacing growth (2026-10-21, direct request): spacing widens to
-- base x (1, 2, 3, 4) across the four dynamic-drawdown tiers, instead of staying flat all the
-- way down. Default OFF everywhere -- existing live behavior (Worker 4) is unchanged until this
-- is explicitly turned on from the dashboard. Applies to both the live table (Worker 4) and
-- Worker 3's twin table.
alter table public.lighter_lit_grid_live_state
  add column if not exists gate_spacing_growth_enabled boolean not null default false;

alter table public.lighter_lit_grid_live_worker3_state
  add column if not exists gate_spacing_growth_enabled boolean not null default false;
