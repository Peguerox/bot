-- Adds the real-collateral-snapshot column used to compute exact realized PnL on every exit
-- (collateral delta, not a price-based estimate) -- lighter_oco_state.sql already ran, this adds
-- the one new column to the existing table.
alter table lighter_oco_state add column if not exists collateral_before_entry double precision;
