-- State for the real-money Lighter SOL "OCO" bot (VWAP 15m mean-reversion, TP 1.5%/SL 0.03%,
-- reverse-on-signal, real OCO bracket exits on Lighter). Single-row state table, matches the
-- convention used by the other live bots (solbtc_sizeconf_state, sol_hypertrade equivalent).
create table if not exists lighter_oco_state (
  id int primary key default 1,
  side text,                          -- 'long' | 'short' | null (flat)
  entry_price double precision,
  base_amount_sol double precision,
  seed_usd double precision not null default 20,
  realized_pnl_usd double precision not null default 0,
  last_processed_candle_ts bigint,    -- guards against double-processing the same completed candle
  collateral_before_entry double precision, -- real account collateral snapshot right before the current entry, used to compute real realized PnL on exit (collateral delta, not a price estimate)
  updated_at timestamptz not null default now()
);
insert into lighter_oco_state (id) values (1) on conflict (id) do nothing;

create table if not exists lighter_oco_trades (
  id bigserial primary key,
  side text not null,
  entry_price double precision not null,
  exit_price double precision not null,
  base_amount_sol double precision not null,
  pnl_usd double precision not null,
  reason text not null,               -- 'TP' | 'SL' | 'REVERSAL'
  opened_at timestamptz not null,
  closed_at timestamptz not null default now()
);

create table if not exists lighter_oco_runs (
  id bigserial primary key,
  ran_at timestamptz not null default now(),
  action text not null,
  detail jsonb
);
