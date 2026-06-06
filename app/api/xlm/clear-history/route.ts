import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export async function POST() {
  const errors: string[] = [];

  const { error: posErr } = await getSupabaseAdmin()
    .from("xlm_live_positions")
    .delete()
    .eq("status", "closed");

  if (posErr) errors.push(`positions: ${posErr.message}`);

  const { error: runsErr } = await getSupabaseAdmin()
    .from("xlm_live_runs")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");

  if (runsErr) errors.push(`runs: ${runsErr.message}`);

  const { data: st } = await getSupabaseAdmin().from("xlm_live_settings").select("id").single();
  if (st) {
    await getSupabaseAdmin()
      .from("xlm_live_settings")
      .update({ baseline_usdt: 0, usdt_balance: 0 })
      .eq("id", st.id);
  }

  return NextResponse.json({ ok: errors.length === 0, errors });
}
