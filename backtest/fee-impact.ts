/**
 * Calculates net paper bot PnL after 0.02% taker fees (both ways) + avg spread.
 * Run: npx ts-node --transpile-only backtest/fee-impact.ts
 */
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ALLOCATION   = 1000;  // $1000 per pair in paper bot
const FEE_RATE     = 0.0002; // 0.02% taker each way
const SPREAD_PCT   = 0.0005; // 0.05% average spread (one way, paid on entry)

async function main() {
  const { data: trades, error } = await sb
    .from("positions")
    .select("pnl, result, pair")
    .eq("status", "closed")
    .order("exit_time", { ascending: true });

  if (error || !trades) { console.error(error); return; }

  const total = trades.length;
  const rawPnL = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);

  // Fee per trade: 0.02% entry + 0.02% exit = 0.04% of ALLOCATION
  // Spread per trade: 0.05% of ALLOCATION (paid on entry, slippage)
  const feePerTrade    = ALLOCATION * FEE_RATE * 2;
  const spreadPerTrade = ALLOCATION * SPREAD_PCT;
  const costPerTrade   = feePerTrade + spreadPerTrade;
  const totalCost      = costPerTrade * total;
  const netPnL         = rawPnL - totalCost;

  const decided  = trades.filter(t => t.result !== "EXPIRE" && t.result !== "MISSED");
  const wins     = decided.filter(t => t.pnl > 0);
  const losses   = decided.filter(t => t.pnl <= 0);

  // Break down by result
  const byResult: Record<string, { count: number; rawPnL: number }> = {};
  for (const t of trades) {
    const r = t.result ?? "?";
    if (!byResult[r]) byResult[r] = { count: 0, rawPnL: 0 };
    byResult[r].count++;
    byResult[r].rawPnL += t.pnl ?? 0;
  }

  console.log("=== Paper Bot Fee Impact ===\n");
  console.log(`Total trades      : ${total}`);
  console.log(`  Decided (TP/SL/CHASE): ${decided.length}  |  Wins: ${wins.length}  |  Losses: ${losses.length}`);
  console.log(`  Win rate        : ${(wins.length / decided.length * 100).toFixed(1)}%`);
  console.log(`\nRaw PnL           : $${rawPnL.toFixed(2)}`);
  console.log(`\nCost per trade:`);
  console.log(`  Fees  (0.04%)   : $${feePerTrade.toFixed(4)}`);
  console.log(`  Spread (0.05%)  : $${spreadPerTrade.toFixed(4)}`);
  console.log(`  Total           : $${costPerTrade.toFixed(4)}`);
  console.log(`\nTotal cost (${total} trades): $${totalCost.toFixed(2)}`);
  console.log(`  Fees only       : $${(feePerTrade * total).toFixed(2)}`);
  console.log(`  Spread only     : $${(spreadPerTrade * total).toFixed(2)}`);
  console.log(`\nNet PnL           : $${netPnL.toFixed(2)}`);
  console.log(`Starting balance  : $2,000.00`);
  console.log(`Net balance       : $${(2000 + netPnL).toFixed(2)}`);
  console.log(`Return            : ${(netPnL / 2000 * 100).toFixed(1)}%`);

  console.log("\n--- By result (raw) ---");
  for (const [result, { count, rawPnL: rp }] of Object.entries(byResult).sort((a, b) => b[1].rawPnL - a[1].rawPnL)) {
    const netR = rp - costPerTrade * count;
    console.log(`  ${result.padEnd(12)}: ${String(count).padStart(4)} trades  raw $${rp.toFixed(2).padStart(8)}  net $${netR.toFixed(2).padStart(8)}`);
  }
}

main().catch(console.error);
