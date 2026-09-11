import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export async function POST() {
  const sb = getSupabaseAdmin();
  await sb.from("sol_hypertrade_paper_trades").delete().gt("id", 0);
  await sb.from("sol_hypertrade_paper_runs").delete().gt("id", 0);
  await sb.from("sol_hypertrade_paper_state").update({
    positions: [], total_cost: 0, level: 0, last_entry_price: null, tp_target: null,
    cycle_start_time: null, realized_pnl_usd: 0, total_cycles: 0, total_wins: 0,
    max_level_ever: 0, max_cost_ever: 0,
  }).eq("id", 1);
  return NextResponse.json({ ok: true });
}
