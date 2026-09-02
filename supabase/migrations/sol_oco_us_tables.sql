CREATE TABLE IF NOT EXISTS sol_oco_us_state (
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
  sl_chase_attempts  integer NOT NULL DEFAULT 0,
  last_candle_ts     bigint NOT NULL DEFAULT 0,
  realized_pnl_usd   numeric NOT NULL DEFAULT 0,
  total_trades       integer NOT NULL DEFAULT 0,
  total_wins         integer NOT NULL DEFAULT 0
);
INSERT INTO sol_oco_us_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS sol_oco_us_trades (
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

CREATE TABLE IF NOT EXISTS sol_oco_us_runs (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_at  timestamptz NOT NULL,
  data    jsonb
);

ALTER PUBLICATION supabase_realtime ADD TABLE sol_oco_us_state;
ALTER PUBLICATION supabase_realtime ADD TABLE sol_oco_us_trades;
ALTER PUBLICATION supabase_realtime ADD TABLE sol_oco_us_runs;
