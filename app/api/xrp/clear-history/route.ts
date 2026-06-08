import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export async function POST() {
  const sb = getSupabaseAdmin();
  const errors: string[] = [];

  await sb.from("xrp_live_positions")
    .update({ status: "closed", result: "CLEARED", exit_time: new Date().toISOString() })
    .in("status", ["pending_entry", "open", "chasing"]);

  const { error: posErr } = await sb.from("xrp_live_positions")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");

  if (posErr) errors.push(`positions: ${posErr.message}`);

  const { error: runsErr } = await sb.from("xrp_live_runs")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");

  if (runsErr) errors.push(`runs: ${runsErr.message}`);

  const { data: st } = await sb.from("xrp_live_settings").select("id").single();
  if (st) {
    await sb.from("xrp_live_settings")
      .update({ baseline_usdt: 0, usdt_balance: 0, pending_sell: true })
      .eq("id", st.id);
  }

  return NextResponse.json({ ok: errors.length === 0, errors });
}
