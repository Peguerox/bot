/**
 * Pull recent live_runs from Supabase to see what the bot actually did.
 * Run: npx ts-node --transpile-only backtest/show-logs.ts
 */

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const { data, error } = await sb
    .from("live_runs")
    .select("run_at, data")
    .order("run_at", { ascending: false })
    .limit(60);

  if (error) { console.error(error); process.exit(1); }

  console.log(`\nLast ${data.length} live bot runs (newest first):\n`);
  for (const row of data) {
    const time    = new Date(row.run_at).toLocaleTimeString();
    const actions = (row.data as any)?.actions ?? [];
    const summary = actions.map((a: any) => a.action ?? JSON.stringify(a)).join(", ");
    console.log(`  ${time}  →  ${summary || "(no actions)"}`);
    for (const a of actions) {
      if (a.action === "ERROR") console.log(`            error: ${a.error}  stage: ${a.stage ?? "trading"}`);
    }
  }
  console.log();
}

main().catch(console.error);
