-- Adds state columns for the "protection" strategy upgrade (2026-09-18):
-- drawdown-gated asymmetric threshold tightening, ER30 trail exit, 20s SOL-request expiry,
-- and the failed-entry forced exit. Existing rows get safe defaults so the live worker can
-- resume from its current saved state without a reset.

alter table solbtc_sizeconf_state
  add column if not exists window_sg double precision not null default 0,
  add column if not exists er30 double precision not null default 1.0,
  add column if not exists log_equity double precision not null default 0,
  add column if not exists peak_log_equity double precision not null default 0,
  add column if not exists tightened boolean not null default false,
  add column if not exists peak_since_entry double precision,
  add column if not exists entry_price double precision,
  add column if not exists entry_fill_ts double precision,
  add column if not exists entry_reached_10bps boolean not null default false,
  add column if not exists pending_request_q double precision;
