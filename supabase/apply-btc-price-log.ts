import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

(async () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "btc-price-log.sql"), "utf8");
  const statements = sql.split(";").map(s => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    const { error } = await sb.rpc("exec_sql" as any, { query: stmt });
    if (error) {
      // Try direct query via postgres extension
      console.log("rpc failed, trying direct:", stmt.slice(0, 60));
    } else {
      console.log("OK:", stmt.slice(0, 60));
    }
  }
  console.log("Done");
})();
