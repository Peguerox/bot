import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { checkLitGridLiveAuth } from "@/lib/lit-grid-live-auth";
import { investmentShortfallError } from "@/lib/lit-grid-live-balance";

// REAL MONEY. Mirror bot copy of /api/lighter-lit-grid-live/toggle (2026-10-21) -- same route,
// pointed at lighter_lit_grid_live_mirror_state instead of Worker 4's table. See
// server/lighter_lit_grid_dual_twin.py's docstring for the twin design. Turning this bot ON is
// explicitly the user's call, never automatic.
const TABLE = "lighter_lit_grid_live_mirror_state";

export async function POST(req: NextRequest) {
  const authError = checkLitGridLiveAuth(req);
  if (authError) return authError;
  const sb = getSupabaseAdmin();
  const { data: current, error: readError } = await sb
    .from(TABLE)
    .select("enabled,capital_usd")
    .eq("id", 1)
    .single();
  if (readError) {
    return NextResponse.json({ error: readError.message }, { status: 500 });
  }
  const next = !current?.enabled;
  if (next) {
    const shortfall = await investmentShortfallError(sb, Number(current?.capital_usd ?? 0), TABLE);
    if (shortfall) return NextResponse.json({ error: shortfall }, { status: 400 });
  }
  const { data: updated, error: writeError } = await sb
    .from(TABLE)
    .update({ enabled: next })
    .eq("id", 1)
    .select("enabled")
    .single();
  if (writeError) {
    return NextResponse.json({ error: writeError.message }, { status: 500 });
  }
  if (updated?.enabled !== next) {
    return NextResponse.json({ error: "Toggle did not take effect." }, { status: 500 });
  }
  return NextResponse.json({ enabled: next });
}
