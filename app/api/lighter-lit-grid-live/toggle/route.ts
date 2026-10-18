import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { checkLitGridLiveAuth } from "@/lib/lit-grid-live-auth";

// REAL MONEY. Flips enabled on lighter_lit_grid_live_state -- the running Python worker
// (server/lit_grid_live.py) reads this every tick; turning it on only lets NEW order placement
// happen, it never touches whatever is already resting on the exchange. Turning a real bot ON
// is explicitly the user's call, never automatic.
export async function POST(req: NextRequest) {
  const authError = checkLitGridLiveAuth(req);
  if (authError) return authError;
  const sb = getSupabaseAdmin();
  const { data: current, error: readError } = await sb
    .from("lighter_lit_grid_live_state")
    .select("enabled")
    .eq("id", 1)
    .single();
  if (readError) {
    return NextResponse.json({ error: readError.message }, { status: 500 });
  }
  const next = !current?.enabled;
  const { data: updated, error: writeError } = await sb
    .from("lighter_lit_grid_live_state")
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
