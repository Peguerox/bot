import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export async function POST() {
  const sb = getSupabaseAdmin();
  await sb.from("surfer_usdt_trades").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await sb.from("surfer_usdt_runs").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await sb.from("surfer_usdt_state").update({ realized_pnl_usdt: 0, total_trades: 0, total_wins: 0 }).eq("id", 1);
  return NextResponse.json({ ok: true });
}
