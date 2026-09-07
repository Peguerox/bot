import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const sql = fs.readFileSync("supabase/migrations/market_ticks.sql", "utf8");
const statements = sql
  .split(";")
  .map(s => s.trim())
  .filter(s => s.length > 0 && !s.startsWith("--"));

(async () => {
  for (const stmt of statements) {
    const { error } = await (sb as any).rpc("exec_sql", { query: stmt });
    if (error) {
      console.error("FAILED:", stmt.slice(0, 80).replace(/\s+/g, " "));
      console.error(error.message);
    } else {
      console.log("OK:", stmt.slice(0, 80).replace(/\s+/g, " "));
    }
  }
  console.log("\nDone. Verify with: select * from market_ticks limit 1;");
})();
