-- Entry wiggle/vol ratio gate, Worker 4 only (2026-10-15, direct request): a new optional
-- entry filter recommended by an external backtest audit on real tick execution -- only enter
-- when compute_volume_wiggle_ratio() sits inside [min, max). Compiled off everywhere
-- (BotConfig.entry_wiggle_ratio_enabled defaults False) and these columns are added to Worker 4
-- ONLY, deliberately not Worker 1 -- Worker 1 stays on the user's own hand-tuned settings as a
-- control while this gets tried on Worker 4. Nothing is turned on by this migration: set
-- override_entry_wiggle_ratio_enabled = true (plus _min/_max) manually in Supabase whenever
-- ready to actually flip it live.

alter table public.lighter_btc_worker4_state
  add column if not exists override_entry_wiggle_ratio_enabled boolean,
  add column if not exists override_entry_wiggle_ratio_min double precision,
  add column if not exists override_entry_wiggle_ratio_max double precision;
