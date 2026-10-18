-- Persist the level tracker across restarts (2026-10-18, Opus audit finding #4). Render
-- restarts every service on every push, which reset the bot's in-memory _last_level while
-- open_positions_json (the actual position stack) survived in the DB -- reintroducing the
-- non-adjacent-pair bug through a different path than the one already fixed. internal_spacing_pct
-- lets the worker detect a spacing change (in a live run or across a restart) and re-arm fresh
-- instead of reinterpreting a stale level index under a new spacing (finding #5).

alter table public.lighter_lit_grid_state
  add column if not exists internal_last_level integer,
  add column if not exists internal_spacing_pct numeric;
