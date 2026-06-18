import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

(async () => {
  // Check surfer state
  const { data: state, error: e1 } = await sb
    .from("surfer_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (e1) { console.error("surfer_state error:", e1); }
  else { console.log("SURFER STATE:", JSON.stringify(state, null, 2)); }

  // Last 10 surfer runs
  const { data: runs, error: e2 } = await sb
    .from("surfer_runs")
    .select("*")
    .order("run_at", { ascending: false })
    .limit(10);
  if (e2) { console.error("surfer_runs error:", e2); }
  else {
    console.log("\nLAST 10 RUNS:");
    for (const r of (runs ?? []).reverse()) {
      const t = r.run_at?.slice(0, 19).replace("T", " ");
      console.log(`${t}  ${JSON.stringify(r.data)}`);
    }
  }
})();
