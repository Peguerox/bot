-- Capital-corrected gate-spacing multiplier (2026-10-22, replaces the flat 1/2/3/4x table):
-- effective_spacing_pct() now reads a PERSISTED multiplier (gate_spacing_multiplier_value)
-- instead of recomputing one from a tier lookup, since the new formula needs live cash figures
-- only available where _dynamic_order_size already computes them. dynamic_dd_base_capital_usd
-- (K0) is the cash available the last time the bot was at the base dynamic-drawdown tier.
-- Both nullable, default null (unset = effective_spacing_pct falls back to the plain dashboard
-- spacing_pct, same safe/inert default as before this feature ever persisted anything).
alter table public.lighter_lit_grid_live_state
  add column if not exists dynamic_dd_base_capital_usd double precision,
  add column if not exists gate_spacing_multiplier_value double precision;

alter table public.lighter_lit_grid_live_worker3_state
  add column if not exists dynamic_dd_base_capital_usd double precision,
  add column if not exists gate_spacing_multiplier_value double precision;
