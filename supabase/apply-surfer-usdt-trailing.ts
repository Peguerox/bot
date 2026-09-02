import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

(async () => {
  const stmt = `ALTER TABLE surfer_usdt_state ADD COLUMN IF NOT EXISTS best_pct DECIMAL(10,4) NOT NULL DEFAULT 0`;
  const { error } = await (sb as any).rpc("exec_sql", { query: stmt });
  if (error) {
    console.error("FAILED:", error.message);
    process.exit(1);
  }
  console.log("OK: best_pct column added to surfer_usdt_state");
})();
