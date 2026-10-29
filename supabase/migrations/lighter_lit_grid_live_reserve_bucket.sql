-- Crash reserve = Drawdown (cover-drop) bucket option (2026-10-29): what reserve deploys released
-- from the bucket into the buying money. Both LIT bots.
alter table public.lighter_lit_grid_live_worker3_state add column if not exists reserve_released_usd double precision not null default 0;
alter table public.lighter_lit_grid_live_mirror_state add column if not exists reserve_released_usd double precision not null default 0;
