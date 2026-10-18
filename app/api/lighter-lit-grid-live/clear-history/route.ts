import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { checkLitGridLiveAuth } from "@/lib/lit-grid-live-auth";

// REAL MONEY. Wipes the order ledger between test iterations (expect many restarts while this
// bot is still being audited/fixed) -- refuses while enabled, and refuses unless the last known
// real LIT balance (read by the Python worker, not this route -- no exchange credentials here)
// is at or near zero, so this can never silently discard the record of real inventory that's
// still actually held. Deletes lighter_lit_grid_live_orders/_runs, resets the lifetime buy
// counter and the cached order size/spacing so the next enable starts completely fresh.
const LIT_DUST_TOLERANCE = 0.05;

export async function POST(req: NextRequest) {
  const authError = checkLitGridLiveAuth(req);
  if (authError) return authError;

  const sb = getSupabaseAdmin();
  const { data: state, error: readError } = await sb
    .from("lighter_lit_grid_live_state")
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

  await sb.from("lighter_lit_grid_live_orders").delete().gt("id", 0);
  await sb.from("lighter_lit_grid_live_runs").delete().gt("id", 0);
  const { error: writeError } = await sb.from("lighter_lit_grid_live_state").update({
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
