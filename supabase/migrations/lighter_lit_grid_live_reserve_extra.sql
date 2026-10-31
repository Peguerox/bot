-- "Add to reserve $" (owner, 2026-10-31): deposited USDC counted as crash reserve. Applied by the owner.
alter table public.lighter_lit_grid_live_worker3_state add column if not exists reserve_extra_usd double precision not null default 0;
alter table public.lighter_lit_grid_live_mirror_state add column if not exists reserve_extra_usd double precision not null default 0;
