-- State for the Stochastic5 + 1:2:4 DCA BTC bot (from Lighter_BTC_Hypertrading_DCA_Sweep.xlsx,
-- "Stochastic5 fresh + 1:2:4 DCA" -- the best baseline-cost candidate found, though the doc's own
-- stress test shows it fails under modest extra slippage. Real $20 test to measure that directly.
create table if not exists lighter_stoch_dca_btc_state (
  id int primary key default 1,
  side text,                          -- 'long' | 'short' | null (flat)
  legs jsonb not null default '[]',   -- [{price, usd_size}, ...] up to 3 legs
  first_entry_price double precision,
  first_entry_time bigint,            -- ms epoch, for the 30-min deadline and hard stop anchor
  dca_level int not null default 0,   -- 0 = only initial leg, 1 = one add, 2 = two adds (maxed)
  last_dca_minute bigint,             -- guards "at most one addition per minute"
  seed_usd double precision not null default 20,
  realized_pnl_usd double precision not null default 0,
  last_processed_candle_ts bigint,
  collateral_before_entry double precision,
  updated_at timestamptz not null default now()
);
insert into lighter_stoch_dca_btc_state (id) values (1) on conflict (id) do nothing;

create table if not exists lighter_stoch_dca_btc_trades (
  id bigserial primary key,
  side text not null,
  avg_entry_price double precision not null,
  exit_price double precision not null,
  base_amount_btc double precision not null,
  pnl_usd double precision not null,
  reason text not null,               -- 'TP' | 'SL' | 'TIME' | 'REVERSAL'
  legs_used int not null,
  opened_at timestamptz not null,
  closed_at timestamptz not null default now()
);

create table if not exists lighter_stoch_dca_btc_runs (
  id bigserial primary key,
  ran_at timestamptz not null default now(),
  action text not null,
  detail jsonb
);

alter publication supabase_realtime add table public.lighter_stoch_dca_btc_state;
alter publication supabase_realtime add table public.lighter_stoch_dca_btc_trades;
alter publication supabase_realtime add table public.lighter_stoch_dca_btc_runs;

alter table public.lighter_stoch_dca_btc_state  enable row level security;
alter table public.lighter_stoch_dca_btc_trades enable row level security;
alter table public.lighter_stoch_dca_btc_runs   enable row level security;

create policy "anon_read" on public.lighter_stoch_dca_btc_state  for select to anon using (true);
create policy "anon_read" on public.lighter_stoch_dca_btc_trades for select to anon using (true);
create policy "anon_read" on public.lighter_stoch_dca_btc_runs   for select to anon using (true);
