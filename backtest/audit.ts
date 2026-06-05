import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  // Faking bot positions with real USDT in/out
  const { data: faking } = await sb
    .from("faking_positions")
    .select("*")
    .order("entry_time", { ascending: true });

  console.log("=== Faking Bot: Real USDT Flow ===");
  let totalUsdtSpent = 0;
  let totalUsdtReceived = 0;
  for (const p of faking ?? []) {
    const spent    = p.entry_price * p.quantity;
    const received = p.exit_price ? p.exit_price * p.quantity : null;
    const realPnL  = received ? received - spent : null;
    totalUsdtSpent    += spent;
    totalUsdtReceived += received ?? 0;
    console.log(`${p.result ?? "OPEN"} | entry=${p.entry_price} exit=${p.exit_price ?? "?"} qty=${p.quantity}`);
    console.log(`  USDT spent: $${spent.toFixed(2)}  received: ${received ? "$"+received.toFixed(2) : "?"}  PnL: ${realPnL ? "$"+realPnL.toFixed(2) : "?"}`);
    console.log(`  DB pnl: $${p.pnl?.toFixed(2) ?? "?"}  entry_time: ${p.entry_time}`);
  }

  const closed = (faking ?? []).filter(p => p.pnl !== null);
  const dbTotal = closed.reduce((s, p) => s + p.pnl, 0);
  const realTotal = totalUsdtReceived - totalUsdtSpent;
  console.log(`\nDB total PnL  : $${dbTotal.toFixed(2)}`);
  console.log(`Real USDT diff: $${(totalUsdtReceived - closed.reduce((s,p) => s + p.entry_price * p.quantity, 0)).toFixed(2)}`);

  // Paper bot entries in same time window
  const firstFaking = faking?.[0]?.entry_time;
  const { data: paper } = await sb
    .from("positions")
    .select("pair, entry_time, entry_price, result, pnl")
    .gte("entry_time", firstFaking ?? "")
    .order("entry_time", { ascending: true })
    .limit(20);

  console.log("\n=== Paper Bot entries in same window ===");
  for (const p of paper ?? []) {
    console.log(`${p.pair} | entry=${p.entry_price} result=${p.result} pnl=${p.pnl?.toFixed(2)} time=${p.entry_time}`);
  }

  // Side by side ATOM entries
  console.log("\n=== ATOM entries: Paper vs Faking ===");
  const paperAtom  = (paper ?? []).filter(p => p.pair === "ATOM");
  const fakingAll  = faking ?? [];
  console.log("PAPER ATOM entries:", paperAtom.map(p => p.entry_time));
  console.log("FAKING entries:    ", fakingAll.map(p => p.entry_time));
}
main().catch(console.error);
