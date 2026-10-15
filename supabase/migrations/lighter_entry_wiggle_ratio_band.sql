-- Entry wiggle/vol ratio gate (2026-10-15, direct request): a new optional entry filter
-- recommended by an external backtest audit on real tick execution -- only enter when
-- compute_volume_wiggle_ratio() sits inside [min, max). Compiled off everywhere
-- (BotConfig.entry_wiggle_ratio_enabled defaults False) and nothing is turned on by this
-- migration -- these are just the columns the live override_* controls (and the dashboard
-- panel) read/write. Added to BOTH Worker 1 and Worker 4 so the exact same strategy can be
-- compared side by side with different settings -- Worker 1 can be left alone as the control
-- while Worker 4 (or either one) gets the filter turned on manually, whenever ready.

alter table public.lighter_btc_initial_state
  add column if not exists override_entry_wiggle_ratio_enabled boolean,
  add column if not exists override_entry_wiggle_ratio_min double precision,
  add column if not exists override_entry_wiggle_ratio_max double precision;

alter table public.lighter_btc_worker4_state
  add column if not exists override_entry_wiggle_ratio_enabled boolean,
  add column if not exists override_entry_wiggle_ratio_min double precision,
  add column if not exists override_entry_wiggle_ratio_max double precision;
