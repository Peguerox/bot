import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export async function POST() {
  const sb = getSupabaseAdmin();

  await sb.from("surfer_trades").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await sb.from("surfer_runs").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await sb.from("surfer_state").update({ realized_pnl_btc: 0, total_trades: 0, total_wins: 0 }).eq("id", 1);

  return NextResponse.json({ ok: true });
}
