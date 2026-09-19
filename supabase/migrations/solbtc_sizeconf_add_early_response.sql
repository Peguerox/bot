-- Adds the entry_request_q column for the "early response" strategy upgrade (2026-09-18):
-- tracks q at the original SOL-entry request (not the fill), persisted through the hold, used by
-- the new early-response exit rule. Existing rows get a safe null default so the live worker can
-- resume from its current saved state without a reset.

alter table solbtc_sizeconf_state
  add column if not exists entry_request_q double precision;
