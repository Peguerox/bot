import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export async function POST() {
  const sb = getSupabaseAdmin();

  // Mark position closed immediately so UI updates
  await sb.from("live_positions")
    .update({ status: "closed", result: "CANCELLED", exit_time: new Date().toISOString() })
    .in("status", ["open", "chasing"]);

  // Signal the bot to sell all ATOM on its next run (within 1 min)
  const { data } = await sb.from("live_settings").select("id").single();
  if (data) await sb.from("live_settings").update({ pending_sell: true }).eq("id", data.id);

  return NextResponse.json({ ok: true });
}
