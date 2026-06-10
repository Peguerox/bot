import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

(async () => {
  const { data: runs } = await sb
    .from("xlm_live_runs")
    .select("run_at, data")
    .order("run_at", { ascending: false })
    .limit(120);

  if (!runs?.length) { console.log("No runs"); return; }

  const counts: Record<string, number> = {};
  let signals = 0, fills = 0, cancels = 0, errors = 0;
  const spreads: number[] = [];

  for (const r of runs) {
    for (const a of (r.data as any)?.actions ?? []) {
      counts[a.action] = (counts[a.action] ?? 0) + 1;
      if (a.action === "LIMIT_BUY_PLACED" || a.action === "LIMIT_BUY_PLACED_30S") signals++;
      if (a.action === "ENTRY_FILLED") fills++;
      if (a.action === "CANCELED_DROP") cancels++;
      if (a.action === "ERROR") errors++;
      if (a.xlmGLRet != null) spreads.push(parseFloat(a.xlmGLRet) * 100);
    }
  }

  console.log(`\nLast ${runs.length} runs  (${runs[runs.length-1].run_at.slice(11,19)} → ${runs[0].run_at.slice(11,19)})\n`);
  console.log("Action counts:");
  for (const [k, v] of Object.entries(counts).sort((a,b) => b[1]-a[1]))
    console.log(`  ${k.padEnd(25)} ${v}`);
  console.log(`\nSignals fired:    ${signals}`);
  console.log(`Orders filled:    ${fills}`);
  console.log(`Canceled (drop):  ${cancels}`);
  console.log(`Errors:           ${errors}`);
  if (spreads.length) {
    const avg = spreads.reduce((a,b)=>a+b,0)/spreads.length;
    const min = Math.min(...spreads);
    const max = Math.max(...spreads);
    console.log(`\nSpread on WATCH logs (${spreads.length} samples):`);
    console.log(`  avg ${avg.toFixed(3)}%  min ${min.toFixed(3)}%  max ${max.toFixed(3)}%`);
    const positive = spreads.filter(s => s > 0).length;
    console.log(`  positive (global > US): ${positive}/${spreads.length} (${(positive/spreads.length*100).toFixed(0)}%)`);
  }
})();
