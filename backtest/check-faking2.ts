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
    .limit(100);

  // Find any errors
  const errors = (runs ?? []).filter((r: any) =>
    (r.actions ?? []).some((a: any) => a.action === "ERROR")
  );

  console.log(`Total runs: ${runs?.length}`);
  console.log(`Runs with ERROR: ${errors.length}`);
  if (errors.length > 0) {
    for (const e of errors) {
      console.log(e.created_at, JSON.stringify(e.actions));
    }
  } else {
    console.log("No errors found.");
  }

  // Action summary
  const counts: Record<string, number> = {};
  for (const r of runs ?? []) {
    for (const a of r.actions ?? []) {
      counts[a.action] = (counts[a.action] ?? 0) + 1;
    }
  }
  console.log("\nAction counts:", counts);
}
main().catch(console.error);
