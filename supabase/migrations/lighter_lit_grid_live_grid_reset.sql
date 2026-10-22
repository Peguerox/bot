-- Grid reset (2026-10-22): one cancel-all transaction, then a clean re-anchor from the ledger.
-- Set to true to request it; the worker clears it when the reset completes. See reset_grid()
-- in server/lit_grid_live.py.
alter table public.lighter_lit_grid_live_state
  add column if not exists grid_reset_requested boolean not null default false;

alter table public.lighter_lit_grid_live_worker3_state
  add column if not exists grid_reset_requested boolean not null default false;
