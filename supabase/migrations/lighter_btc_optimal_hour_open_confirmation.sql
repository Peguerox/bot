-- Worker 2 (2026-09-25): persists awaiting_open_confirmation for dashboard display only.
-- In-memory flag stays the actual source of truth (re-arms on every restart by design), this
-- column just mirrors it so the dashboard can show why real trading looks idle even when
-- self-lock itself isn't locked.

ALTER TABLE lighter_btc_optimal_state
  ADD COLUMN IF NOT EXISTS awaiting_open_confirmation boolean NOT NULL DEFAULT false;
