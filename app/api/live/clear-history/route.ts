import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export async function POST() {
  const errors: string[] = [];

  const { error: posErr } = await getSupabaseAdmin()
    .from("live_positions")
    .delete()
    .eq("status", "closed");

  if (posErr) errors.push(`positions: ${posErr.message}`);

  const { error: runsErr } = await getSupabaseAdmin()
    .from("live_runs")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000"); // delete all

  if (runsErr) errors.push(`runs: ${runsErr.message}`);

  return NextResponse.json({ ok: errors.length === 0, errors });
}
