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
    usdc_balance: state?.capital_usd ?? 10000,
    lit_balance: 0,
    bot_profit_usd: 0,
    open_positions_json: { holdings: {} },
    live_level: null,
    order_size_lit: null,
    // Clearing internal_last_level marks the next enable as a genuine fresh start, so it
    // re-splits capital proportionally to levels_up/levels_down (usdc + an immediate LIT buy)
    // instead of resuming as if it were the same still-running position.
    internal_last_level: null,
    internal_spacing_pct: null,
    history_reset_at: new Date().toISOString(),
  }).eq("id", 1);

  return NextResponse.json({ ok: true });
}
