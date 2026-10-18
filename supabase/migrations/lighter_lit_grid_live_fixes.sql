-- Follow-up to lighter_lit_grid_live_schema.sql, after an external audit of the live grid bot
-- found several real bugs (2026-10-18, commit 49a64ef) before it ever traded. See
-- server/lit_grid_live.py's module docstring for the full list of fixes this supports.

-- Persists the spacing last seen, so a spacing change can be detected and trigger a clean
-- cancel-all before the next tick places anything under the new spacing (audit finding: a
-- spacing change used to silently reinterpret existing orders' stored levels under the new step).
alter table public.lighter_lit_grid_live_state
  add column if not exists internal_spacing_pct numeric;

-- Code-enforced cap on new buy placement, not just a manual-settings convention (audit finding:
-- "no isolated one-order live-test mode is implemented"). Defaults to 1 for the first real test;
-- raise it from the dashboard once that's verified.
alter table public.lighter_lit_grid_live_state
  add column if not exists max_open_buys int default 1;

-- Defense-in-depth against the timestamp-derived client_order_index colliding (audit finding:
-- no uniqueness enforced, repeats roughly every 5.79 days and could collide across workers).
-- A collision now fails the INSERT loudly instead of silently corrupting the ledger.
alter table public.lighter_lit_grid_live_orders
  add constraint lighter_lit_grid_live_orders_client_order_index_unique unique (client_order_index);
