-- Records the actual live bid/ask half-spread applied to each fill, replacing the flat 0.02%
-- assumption. Nullable because a handful of very-early fills (before the book WS snapshot
-- arrives) fall back to the flat COST constant -- those rows are left null so it's visible in
-- the data which fills used a real measured spread vs the fallback.
alter table public.solbtc_sizeconf_trades add column if not exists cost_pct double precision;
