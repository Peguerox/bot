import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export async function POST() {
  const sb = getSupabaseAdmin();
  await sb.from("sol_vwap_live_trades").delete().gt("id", 0);
  await sb.from("sol_vwap_live_runs").delete().gt("id", 0);
  await sb.from("sol_vwap_live_state").update({ realized_pnl_usd: 0, total_trades: 0, total_wins: 0 }).eq("id", 1);
  return NextResponse.json({ ok: true });
}
