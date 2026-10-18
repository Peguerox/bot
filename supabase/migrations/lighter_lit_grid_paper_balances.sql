-- Real balance accounting for the LIT grid paper bot (2026-10-18, direct request after a
-- Bitsgap screenshot comparison). Bitsgap tracks Investment (fixed) / Bot profit (realized
-- round-trips only) / Total PNL (investment vs. real current account value, including whatever
-- is sitting unsold in the base asset) as three separate numbers. The original schema only had
-- current_capital_usd, a single abstract running total not tied to real fills -- order size was
-- recomputed from the full original capital every tick regardless of how much had already been
-- spent, and sells could open with no LIT actually held. This adds real tracked balances; the
-- worker now constrains every fill by what's actually available.

alter table public.lighter_lit_grid_state
  add column if not exists usdc_balance numeric not null default 10000,
  add column if not exists lit_balance numeric not null default 0,
  add column if not exists bot_profit_usd numeric not null default 0;

-- Backfill: start fresh, 100% cash (Long spot grid default -- same as Bitsgap's default
-- direction), using whatever capital_usd is already configured.
update public.lighter_lit_grid_state
set usdc_balance = capital_usd,
    lit_balance = 0,
    bot_profit_usd = 0
where id = 1;
