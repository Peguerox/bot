import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export async function POST(req: NextRequest) {
  const { id } = await req.json();
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("tv_bot_state").select("capital").eq("id", id).single();
  const capital = data?.capital ?? 1000;
  await Promise.all([
    sb.from("tv_bot_state").update({
      enabled: false, pos: "flat", usdt: capital, sol_qty: 0,
      entry_price: 0, entry_signal: "NEUTRAL",
      round_trips: 0, wins: 0, peak: capital, max_dd: 0,
      status: "idle", order_id: null, order_price: null,
    }).eq("id", id),
    sb.from("tv_bot_trades").delete().eq("bot_id", id),
    sb.from("tv_bot_runs").delete().eq("bot_id", id),
  ]);
  return NextResponse.json({ ok: true });
}
