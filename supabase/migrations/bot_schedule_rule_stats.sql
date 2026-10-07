-- Per-rule win-rate/earnings tracking on the Master Schedule panel (2026-10-07).
-- Lets the dashboard group trades by which schedule rule was governing at entry time, and
-- gives the "Reset" button a cutoff to reset stats without touching trade history.

alter table public.lighter_btc_initial_state add column if not exists active_governing_rule_id text;
alter table public.lighter_btc_optimal_state add column if not exists active_governing_rule_id text;
alter table public.lighter_stoch_dca_btc_state add column if not exists active_governing_rule_id text;

alter table public.bot_schedule_rules add column if not exists rule_stats_reset_at timestamptz;
