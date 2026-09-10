import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export async function POST() {
  const sb = getSupabaseAdmin();
  await sb.from("sol_trail_bitfinex_trades").delete().gt("id", 0);
  await sb.from("sol_trail_bitfinex_runs").delete().gt("id", 0);
  await sb.from("sol_trail_bitfinex_state").update({
    realized_pnl_usd: 0, total_trades: 0, total_wins: 0, balance: 1000,
    mode: "USD", positions: [], total_cost: 0, dca_count: 0,
    entry_price: null, last_entry_price: null, max_price: null, tp_target: null, dca_triggered: false,
  }).eq("id", 1);
  return NextResponse.json({ ok: true });
}
