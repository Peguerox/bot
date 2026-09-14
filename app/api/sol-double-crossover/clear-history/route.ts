import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { SEED_USD } from "@/lib/sol-double-crossover-config";

export async function POST() {
  const sb = getSupabaseAdmin();
  await sb.from("sol_double_crossover_trades").delete().gt("id", 0);
  await sb.from("sol_double_crossover_runs").delete().gt("id", 0);
  await sb.from("sol_double_crossover_state").update({
    cash: SEED_USD, sol_qty: 0, avg_cost: null, pending_target: null, pending_since: null,
    realized_pnl_usd: 0, total_trades: 0, total_wins: 0,
  }).eq("id", 1);
  return NextResponse.json({ ok: true });
}
