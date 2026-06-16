// Read-only: recent lag bot trades + price log around the latest losers
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { getSupabaseAdmin } from "../lib/supabase-admin";

(async () => {
  const sb = getSupabaseAdmin();

  const { data: trades } = await sb
    .from("xlm_live_positions")
    .select("symbol, entry_time, exit_time, entry_price, exit_price, pnl, result, z_score, status")
    .order("entry_time", { ascending: false })
    .limit(10);

  console.log("\n── LAST 10 POSITIONS ──");
  for (const t of trades ?? []) {
    console.log(
      `${t.entry_time?.slice(0, 19)}  ${t.symbol}  entry ${t.entry_price}  exit ${t.exit_price ?? "-"}  ` +
      `pnl ${t.pnl != null ? (t.pnl >= 0 ? "+" : "") + t.pnl.toFixed(4) : "-"}  ${t.result ?? t.status}  z=${t.z_score}`
    );
  }

  const { data: latest, error: logErr } = await sb
    .from("btc_price_log")
    .select("*")
    .order("logged_at", { ascending: false })
    .limit(3);
  console.log("\n── PRICE LOG latest rows ──");
  console.log(logErr ?? latest);

  // price log around the most recent closed loser
  const loser = (trades ?? []).find(t => t.status === "closed" && (t.pnl ?? 0) < 0);
  if (loser) {
    const from = new Date(new Date(loser.entry_time).getTime() - 5 * 60000).toISOString();
    const to = new Date(new Date(loser.exit_time ?? loser.entry_time).getTime() + 10 * 60000).toISOString();
    const { data: log } = await sb
      .from("btc_price_log")
      .select("logged_at, us_price, gl_price, spread_pct")
      .gte("logged_at", from)
      .lte("logged_at", to)
      .order("logged_at", { ascending: true });

    console.log(`\n── PRICE LOG around loser (${loser.entry_time?.slice(0, 19)} → ${loser.exit_time?.slice(0, 19)}) ──`);
    console.log("time                 US          Global      spread%");
    for (const r of log ?? []) {
      console.log(
        `${r.logged_at.slice(0, 19)}  ${Number(r.us_price).toFixed(2).padStart(10)}  ${Number(r.gl_price).toFixed(2).padStart(10)}  ${(r.spread_pct * 100).toFixed(3).padStart(7)}%`
      );
    }
  } else {
    console.log("\nNo recent closed loser found in last 10.");
  }
  console.log();
})();
