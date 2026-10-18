import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Paper-only -- no real position to flatten first, so this is the simple template
// (sol-hypertrade-paper/clear-history without the real-sell step): refuse while running,
// otherwise delete trade/run history and reset the running state back to the configured seed.
export async function POST() {
  const sb = getSupabaseAdmin();
  const { data: state } = await sb.from("lighter_lit_grid_state").select("enabled, capital_usd").eq("id", 1).single();

  if (state?.enabled) {
    return NextResponse.json({ error: "Pause the grid bot before clearing history." }, { status: 409 });
  }

  await sb.from("lighter_lit_grid_trades").delete().gt("id", 0);
  await sb.from("lighter_lit_grid_runs").delete().gt("id", 0);
  await sb.from("lighter_lit_grid_state").update({
    current_capital_usd: state?.capital_usd ?? 10000,
    open_positions_json: { buys: [], sells: [] },
    live_level: null,
    order_size_lit: null,
    history_reset_at: new Date().toISOString(),
  }).eq("id", 1);

  return NextResponse.json({ ok: true });
}
