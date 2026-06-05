import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  // All live positions
  const { data: pos } = await sb
    .from("live_positions")
    .select("*")
    .order("entry_time", { ascending: false })
    .limit(10);

  console.log("=== Live Positions ===");
  for (const p of pos ?? []) {
    console.log(JSON.stringify(p, null, 2));
  }

  // Recent live runs (last 30)
  const { data: runs } = await sb
    .from("live_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(30);

  console.log("\n=== Recent Live Runs (newest first) ===");
  for (const r of runs ?? []) {
    const actions = r.actions ?? [];
    const summary = actions.map((a: any) => a.action).join(", ");
    console.log(`${r.created_at}  →  ${summary}`);
    // Show full detail for non-WATCH actions
    if (!actions.every((a: any) => a.action === "WATCH")) {
      for (const a of actions) {
        if (a.action !== "WATCH") console.log("  ", JSON.stringify(a));
      }
    }
  }
}
main().catch(console.error);
