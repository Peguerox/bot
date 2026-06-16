import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

(async () => {
  // Closed trades are in xlm_live_positions with status=closed
  const { data: trades, error } = await sb
    .from("xlm_live_positions")
    .select("*")
    .eq("status", "closed")
    .order("exit_time", { ascending: false })
    .limit(40);

  if (error) { console.log("Error:", error.message); return; }
  if (!trades?.length) { console.log("No closed trades found"); return; }

  let wins = 0, losses = 0, totalPnl = 0;
  console.log("\nRecent closed trades (newest first):\n");
  console.log("  Time       Result  PnL        Entry       SL          TP          SL%      TP%      Signal%");
  console.log("  " + "─".repeat(96));

  for (const t of trades) {
    const slPct    = t.entry_price && t.sl ? ((t.entry_price - t.sl) / t.entry_price * 100).toFixed(3) : "?";
    const tpPct    = t.entry_price && t.tp ? ((t.tp - t.entry_price) / t.entry_price * 100).toFixed(3) : "?";
    const spreadPct = t.z_score ? (t.z_score * 100).toFixed(3) : "n/a";
    const sign     = (t.pnl ?? 0) >= 0 ? "+" : "";
    const time     = (t.exit_time ?? t.entry_time ?? "?").slice(11, 19);
    const res      = (t.result ?? "?").padEnd(6);

    console.log(
      `  ${time}  ${res}  ${sign}$${(t.pnl ?? 0).toFixed(4)}`.padEnd(33) +
      `  $${(t.entry_price ?? 0).toFixed(2)}`.padEnd(14) +
      `  $${(t.sl ?? 0).toFixed(2)}`.padEnd(14) +
      `  $${(t.tp ?? 0).toFixed(2)}`.padEnd(14) +
      `  -${slPct}%`.padEnd(10) +
      `  +${tpPct}%`.padEnd(10) +
      `  +${spreadPct}%`
    );
    if ((t.pnl ?? 0) >= 0) wins++; else losses++;
    totalPnl += t.pnl ?? 0;
  }

  const sign = totalPnl >= 0 ? "+" : "";
  console.log("  " + "─".repeat(96));
  console.log(`\n  Total: ${trades.length} trades  |  ${wins}W  ${losses}L  |  WR: ${(wins / trades.length * 100).toFixed(1)}%  |  PnL: ${sign}$${totalPnl.toFixed(4)}\n`);
})();
