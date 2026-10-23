-- Dashboard fields (2026-10-23), written by the worker, read by the LIT grid panel:
--   compound_resize -- when the orders were last resized from compound profit (every +0.2% of the
--                      Investment) and the compound figure at that moment (the next step's base).
--   near_book       -- is the buy right below price / the nearest allowed sell on the book; the
--                      time a gap started (the panel alarms after alert_after_s).
-- The worker writes these on their own, so the bot keeps trading even before this runs.
alter table public.lighter_lit_grid_live_state
  add column if not exists compound_resize jsonb,
  add column if not exists near_book jsonb;

alter table public.lighter_lit_grid_live_worker3_state
  add column if not exists compound_resize jsonb,
  add column if not exists near_book jsonb;
