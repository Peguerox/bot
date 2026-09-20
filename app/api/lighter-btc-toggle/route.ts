import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

const ALLOWED_TABLES = new Set([
  "lighter_stoch_dca_btc_state",
  "lighter_btc_initial_state",
  "lighter_btc_optimal_state",
]);

export async function POST(req: NextRequest) {
  const { table } = await req.json();
  if (!ALLOWED_TABLES.has(table)) {
    return NextResponse.json({ error: "invalid table" }, { status: 400 });
  }
  const sb = getSupabaseAdmin();
  const { data } = await sb.from(table).select("enabled").eq("id", 1).single();
  const newState = !data?.enabled;
  await sb.from(table).update({ enabled: newState }).eq("id", 1);
  return NextResponse.json({ enabled: newState });
}
