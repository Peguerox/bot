import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { checkLitGridLiveAuth } from "@/lib/lit-grid-live-auth";

// REAL MONEY. Worker 3 twin of /api/lighter-lit-grid-live/clear-history (2026-10-21) -- same
// route and same refusal rules, pointed at the lighter_lit_grid_live_worker3_* tables.
const LIT_DUST_TOLERANCE = 0.05;
const TABLE_STATE = "lighter_lit_grid_live_worker3_state";
const TABLE_ORDERS = "lighter_lit_grid_live_worker3_orders";
const TABLE_RUNS = "lighter_lit_grid_live_worker3_runs";

export async function POST(req: NextRequest) {
  const authError = checkLitGridLiveAuth(req);
  if (authError) return authError;

  const sb = getSupabaseAdmin();
  const { data: state, error: readError } = await sb
    .from(TABLE_STATE)
    .select("enabled, lit_balance")
    .eq("id", 1)
    .single();
  if (readError) {
    return NextResponse.json({ error: readError.message }, { status: 500 });
  }
  if (state?.enabled) {
    return NextResponse.json({ error: "Disable the bot before clearing history." }, { status: 409 });
  }
  const lastKnownLit = Number(state?.lit_balance ?? 0);
  if (Math.abs(lastKnownLit) > LIT_DUST_TOLERANCE) {
    return NextResponse.json({
      error: `Last known real LIT balance is ${lastKnownLit.toFixed(4)}, not flat. Flatten first.`,
    }, { status: 409 });
  }

  await sb.from(TABLE_ORDERS).delete().gt("id", 0);
  await sb.from(TABLE_RUNS).delete().gt("id", 0);
  const { error: writeError } = await sb.from(TABLE_STATE).update({
    lifetime_buy_count: 0,
    order_size_lit: null,
    internal_spacing_pct: null,
    live_price: null,
    history_reset_at: new Date().toISOString(),
  }).eq("id", 1);
  if (writeError) {
    return NextResponse.json({ error: writeError.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
