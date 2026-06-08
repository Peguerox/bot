import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export async function POST() {
  const sb = getSupabaseAdmin();

  await sb.from("xrp_live_positions")
    .update({ status: "closed", result: "CANCELLED", exit_time: new Date().toISOString() })
    .in("status", ["pending_entry", "open", "chasing"]);

  const { data } = await sb.from("xrp_live_settings").select("id").single();
  if (data) await sb.from("xrp_live_settings").update({ pending_sell: true }).eq("id", data.id);

  return NextResponse.json({ ok: true });
}
