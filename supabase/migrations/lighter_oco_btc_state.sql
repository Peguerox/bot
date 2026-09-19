-- Separate state for the BTC variant of the OCO bot (kept distinct from the SOL tables so the
-- paused SOL bot's history/state isn't touched or confused with this one).
create table if not exists lighter_oco_btc_state (
  id int primary key default 1,
  side text,
  entry_price double precision,
  base_amount_btc double precision,
  seed_usd double precision not null default 20,
  realized_pnl_usd double precision not null default 0,
  last_processed_candle_ts bigint,
  collateral_before_entry double precision,
  updated_at timestamptz not null default now()
);
insert into lighter_oco_btc_state (id) values (1) on conflict (id) do nothing;

create table if not exists lighter_oco_btc_trades (
  id bigserial primary key,
  side text not null,
  entry_price double precision not null,
  exit_price double precision not null,
  base_amount_btc double precision not null,
  pnl_usd double precision not null,
  reason text not null,
  opened_at timestamptz not null,
  closed_at timestamptz not null default now()
);

create table if not exists lighter_oco_btc_runs (
  id bigserial primary key,
  ran_at timestamptz not null default now(),
  action text not null,
  detail jsonb
);
