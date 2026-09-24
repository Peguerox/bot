-- Dashboard "Close Position" button: a manual kill switch independent of the enabled toggle
-- (enabled only blocks new entries, it never closes an existing position). Setting this flag
-- makes the running worker close the real position on its next tick, regardless of enabled
-- state -- built after the 2026-09-23 WAF incident where two real positions sat unmanaged
-- with no fast manual-close path other than the exchange's own website.

ALTER TABLE lighter_btc_initial_state
  ADD COLUMN IF NOT EXISTS close_requested boolean NOT NULL DEFAULT false;

ALTER TABLE lighter_btc_optimal_state
  ADD COLUMN IF NOT EXISTS close_requested boolean NOT NULL DEFAULT false;

ALTER TABLE lighter_stoch_dca_btc_state
  ADD COLUMN IF NOT EXISTS close_requested boolean NOT NULL DEFAULT false;
