-- Engine v2 (2026-10-22): desired-state order engine, behind a per-bot switch.
--   engine_v2_enabled  -- off by default; turns on the new order engine for that bot only.
--   grid_anchor_log    -- ln(anchor). Line prices are exp(grid_anchor_log + line*step), so a re-anchor
--                         can never overflow (the old anchor = price / exp(offset*step) refused to
--                         re-anchor past offset*step > 600, which could leave an empty book).
--   reanchor_journal   -- the line moves of an in-progress re-anchor, written before they are applied,
--                         so a restart halfway through finishes them instead of splitting a lot.
alter table public.lighter_lit_grid_live_state
  add column if not exists engine_v2_enabled boolean not null default false,
  add column if not exists grid_anchor_log double precision,
  add column if not exists reanchor_journal jsonb;

alter table public.lighter_lit_grid_live_worker3_state
  add column if not exists engine_v2_enabled boolean not null default false,
  add column if not exists grid_anchor_log double precision,
  add column if not exists reanchor_journal jsonb;
