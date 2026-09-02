CREATE TABLE IF NOT EXISTS sol_vwap_live_state (
  id                 integer PRIMARY KEY DEFAULT 1,
  enabled            boolean NOT NULL DEFAULT false,
  mode               text NOT NULL DEFAULT 'USD',
  sol_quantity       numeric,
  entry_price        numeric,
  entry_time         timestamptz,
  usd_balance        numeric NOT NULL DEFAULT 0,
  buy_order_id       bigint,
  oco_order_list_id  bigint,
  oco_tp_order_id    bigint,
  oco_sl_order_id    bigint,
  exit_order_id      bigint,
  chase_attempts     integer NOT NULL DEFAULT 0,
  last_candle_ts     bigint NOT NULL DEFAULT 0,
  realized_pnl_usd   numeric NOT NULL DEFAULT 0,
  total_trades       integer NOT NULL DEFAULT 0,
  total_wins         integer NOT NULL DEFAULT 0
);
INSERT INTO sol_vwap_live_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS sol_vwap_live_trades (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_price   numeric NOT NULL,
  exit_price    numeric NOT NULL,
  sol_quantity  numeric NOT NULL,
  usd_in        numeric NOT NULL,
  usd_out       numeric NOT NULL,
  pnl_usd       numeric NOT NULL,
  pnl_pct       numeric NOT NULL,
  exit_reason   text NOT NULL,
  entry_time    timestamptz NOT NULL,
  exit_time     timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS sol_vwap_live_runs (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_at  timestamptz NOT NULL,
  data    jsonb
);

ALTER PUBLICATION supabase_realtime ADD TABLE sol_vwap_live_state;
ALTER PUBLICATION supabase_realtime ADD TABLE sol_vwap_live_trades;
ALTER PUBLICATION supabase_realtime ADD TABLE sol_vwap_live_runs;

alter table public.sol_vwap_live_state  enable row level security;
alter table public.sol_vwap_live_trades enable row level security;
alter table public.sol_vwap_live_runs   enable row level security;

create policy "anon_read" on public.sol_vwap_live_state  for select to anon using (true);
create policy "anon_read" on public.sol_vwap_live_trades for select to anon using (true);
create policy "anon_read" on public.sol_vwap_live_runs   for select to anon using (true);
