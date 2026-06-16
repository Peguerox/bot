import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const statements = [
  `CREATE TABLE IF NOT EXISTS surfer_state (
    id              INTEGER PRIMARY KEY DEFAULT 1,
    enabled         BOOLEAN NOT NULL DEFAULT false,
    mode            TEXT NOT NULL DEFAULT 'BTC',
    status          TEXT NOT NULL DEFAULT 'idle',
    armed_for_sol   BOOLEAN NOT NULL DEFAULT false,
    armed_for_btc   BOOLEAN NOT NULL DEFAULT false,
    last_candle_ts  BIGINT NOT NULL DEFAULT 0,
    sol_quantity    DECIMAL(18,8),
    entry_price     DECIMAL(18,8),
    entry_btc       DECIMAL(18,8),
    entry_time      TIMESTAMPTZ,
    chase_order_id  BIGINT,
    chase_price     DECIMAL(18,8)
  )`,
  `INSERT INTO surfer_state (id) VALUES (1) ON CONFLICT DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS surfer_trades (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol        TEXT NOT NULL DEFAULT 'SOLBTC',
    buy_price     DECIMAL(18,8),
    sell_price    DECIMAL(18,8),
    sol_quantity  DECIMAL(18,8),
    btc_in        DECIMAL(18,8),
    btc_out       DECIMAL(18,8),
    pnl_btc       DECIMAL(18,8),
    pnl_pct       DECIMAL(10,6),
    entry_time    TIMESTAMPTZ,
    exit_time     TIMESTAMPTZ DEFAULT now(),
    result        TEXT DEFAULT 'SELL'
  )`,
  `CREATE TABLE IF NOT EXISTS surfer_runs (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_at  TIMESTAMPTZ DEFAULT now(),
    data    JSONB
  )`,
];

(async () => {
  for (const stmt of statements) {
    const { error } = await (sb as any).rpc("exec_sql", { query: stmt });
    if (error) {
      console.error("FAILED:", stmt.slice(0, 80));
      console.error(error.message);
    } else {
      console.log("OK:", stmt.slice(0, 80).replace(/\s+/g, " "));
    }
  }
  console.log("\nDone. Verify with: select * from surfer_state;");
})();
