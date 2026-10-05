-- 2026-10-05, same-day revision: "put the timer in seconds not minutes." Renames the column
-- bot_schedule_min_hold.sql just added; the value is now interpreted as raw seconds (no *60 in
-- StochBot._apply_schedule_rules). Still defaults to 0 = old instant-switch behaviour. Safe to
-- run even though the row's current value is 0 either way (no real data loss risk).
ALTER TABLE public.bot_schedule_rules
  RENAME COLUMN min_hold_minutes TO min_hold_seconds;
