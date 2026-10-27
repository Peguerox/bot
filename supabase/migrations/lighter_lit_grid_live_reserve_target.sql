-- Crash reserve deploy cap (2026-10-27): the curve's cash at its last top; a deploy only refills
-- the curve up to it, any extra reserve waits for the next leg down.
alter table public.lighter_lit_grid_live_mirror_state add column if not exists reserve_target_cash_usd double precision;
alter table public.lighter_lit_grid_live_worker3_state add column if not exists reserve_target_cash_usd double precision;
