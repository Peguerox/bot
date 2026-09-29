-- Dashboard readout for the low-volatility entry gate (2026-09-29): the live vol_pct reading
-- the gate is checking against min_vol_pct_to_trade, persisted every 10s so the panel can show
-- current volatility and whether it's currently above or below the trading floor.

alter table lighter_btc_optimal_state
  add column if not exists min_vol_pct_last double precision;
