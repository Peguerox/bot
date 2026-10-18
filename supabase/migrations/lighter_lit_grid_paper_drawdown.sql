-- Separate the capital-sizing depth from the active tracking window (2026-10-18, direct
-- correction). levels_up/levels_down were being used for BOTH "how many levels stay actively
-- tracked" (a small number, 10-15) AND "how deep the capital reserve is sized against" (which
-- needs to be large, e.g. 286 levels for -30%) -- conflating them meant setting levels_down=15
-- crammed all the capital into a shallow ~1.9% depth. drawdown_pct now sizes the order alone;
-- the bot still only ever tracks levels_up/levels_down active levels, dynamically recreating the
-- next line as price moves -- it never actually builds out the whole drawdown_pct depth.

alter table public.lighter_lit_grid_state
  add column if not exists drawdown_pct numeric not null default 30;
