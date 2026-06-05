import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  const { data: runs } = await sb
    .from("faking_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(5);

  console.log("=== Last 5 Faking Bot Runs ===");
  for (const r of runs ?? []) {
    const actions = r.actions ?? [];
    const summary = actions.map((a: any) => a.action).join(", ");
    console.log(`${r.created_at}  →  ${summary}`);
  }

  const { data: pos } = await sb
    .from("faking_positions")
    .select("*")
    .order("entry_time", { ascending: false })
    .limit(3);

  console.log("\n=== Faking Positions ===");
  if (!pos?.length) console.log("None yet.");
  for (const p of pos ?? []) {
    console.log(JSON.stringify(p, null, 2));
  }
}
main().catch(console.error);
