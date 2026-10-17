-- Peak window (2026-10-17, direct request: "build the peak rule with a panel where we can
-- modify the rules and on/off toggle"). Only enter in [start, end) hours after a confirmed
-- volume*wiggle "product" peak -- see BotConfig.peak_window_enabled's docstring in
-- stoch_bot_core.py for the research background and the exact causal peak-detection algorithm.
-- Compiled off everywhere; nothing is turned on by this migration. Added to Worker 1 and
-- Worker 4 only (not the hedge) -- same reasoning as the entry_wiggle_ratio migration: this was
-- researched specifically on Worker 1's real trades.

alter table public.lighter_btc_initial_state
  add column if not exists override_peak_window_enabled boolean,
  add column if not exists override_peak_window_floor double precision,
  add column if not exists override_peak_window_confirm_minutes double precision,
  add column if not exists override_peak_window_min_separation_hours double precision,
  add column if not exists override_peak_window_start_hours double precision,
  add column if not exists override_peak_window_end_hours double precision,
  add column if not exists peak_window_last_confirmed_t double precision,
  add column if not exists peak_window_last_confirmed_v double precision,
  add column if not exists live_peak_product double precision,
  add column if not exists live_peak_hours_since double precision,
  add column if not exists live_peak_window_active boolean;

alter table public.lighter_btc_worker4_state
  add column if not exists override_peak_window_enabled boolean,
  add column if not exists override_peak_window_floor double precision,
  add column if not exists override_peak_window_confirm_minutes double precision,
  add column if not exists override_peak_window_min_separation_hours double precision,
  add column if not exists override_peak_window_start_hours double precision,
  add column if not exists override_peak_window_end_hours double precision,
  add column if not exists peak_window_last_confirmed_t double precision,
  add column if not exists peak_window_last_confirmed_v double precision,
  add column if not exists live_peak_product double precision,
  add column if not exists live_peak_hours_since double precision,
  add column if not exists live_peak_window_active boolean;
