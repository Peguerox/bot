-- Dashboard readout for the entry-confirmation book filter (2026-09-29): the live confirmation
-- ratio for whatever direction live_signal currently reads, persisted every 10s so the panel
-- can show what the bot is looking at right now, same as live_k already does.

alter table lighter_btc_optimal_state
  add column if not exists entry_confirmation_last double precision;
