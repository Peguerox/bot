-- Second follow-up to lighter_lit_grid_live_schema.sql, after a second independent audit found
-- the previous round's sell-target fix had a real, high-frequency bug (level_of() on a rounded
-- real cost can flip to the wrong bin -- fill prices sit exactly ON a bin boundary by
-- construction, so 4-decimal rounding has roughly 50% odds of landing in the bin below, every
-- time). See server/lit_grid_live.py's module docstring for the full writeup.

-- Explicit level a SELL is closing, set directly from the real buy's level at placement time --
-- never recomputed later via level_of() on a (rounded) price, which is what broke pairing.
alter table public.lighter_lit_grid_live_orders
  add column if not exists closes_level int;

-- A cancel request's SDK ack is not proof of final exchange state (a race with a fill is
-- possible) -- this is an intermediate status; reconciliation resolves it to the real terminal
-- outcome (filled, filled via partial-before-cancel, or genuinely cancelled).
alter table public.lighter_lit_grid_live_orders
  drop constraint if exists lighter_lit_grid_live_orders_status_check;
alter table public.lighter_lit_grid_live_orders
  add constraint lighter_lit_grid_live_orders_status_check
  check (status in ('pending', 'open', 'cancel_requested', 'filled', 'cancelled', 'rejected'));

-- Persistent, restart-surviving one-shot counter for max_open_buys -- the previous version was a
-- concurrent/point-in-time cap (open resting buys + held levels), which resets the moment a full
-- buy-sell cycle completes, so enabling the bot did not actually limit it to one order total.
alter table public.lighter_lit_grid_live_state
  add column if not exists lifetime_buy_count int not null default 0;
