import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { checkLitGridLiveAuth } from "@/lib/lit-grid-live-auth";

// REAL MONEY emergency control. Worker 3 twin of /api/lighter-lit-grid-live/flatten (2026-10-21)
// -- same route, pointed at lighter_lit_grid_live_worker3_state. Never touches the exchange
// directly; only sets flatten_requested=true, which server/lighter_lit_grid_dual_twin.py's
// Worker 3 instance (lit_grid_live.py's flatten_all()) picks up on its own next tick.
const TABLE = "lighter_lit_grid_live_worker3_state";

export async function POST(req: NextRequest) {
  const authError = checkLitGridLiveAuth(req);
  if (authError) return authError;
  const { error } = await getSupabaseAdmin()
    .from(TABLE)
    .update({ flatten_requested: true })
    .eq("id", 1);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
