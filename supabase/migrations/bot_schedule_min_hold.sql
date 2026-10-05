-- 2026-10-05, direct request: "we need to put a dwelling characteristic for the rules so it
-- needs to stay there for so amount of minutes in order to apply the rule." The schedule's top
-- match was flipping across rule boundaries every 1-2 minutes against real volatile volume/wiggle
-- readings, each flip opening/closing a hedge cycle and repeatedly leaving one leg briefly
-- unhedged. This is a single hold time for the WHOLE rule set (not per rule): a newly-matched
-- rule only takes effect once it has been the continuous top match for this many minutes. 0
-- (default) is the old instant-switch behaviour. See StochBot._apply_schedule_rules.
ALTER TABLE public.bot_schedule_rules
  ADD COLUMN IF NOT EXISTS min_hold_minutes DOUBLE PRECISION NOT NULL DEFAULT 0;
