import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { checkLitGridLiveAuth } from "@/lib/lit-grid-live-auth";

// REAL MONEY emergency control. Never touches the exchange directly (Lighter's signing SDK is
// Python-only, same reason as every other bot's close/flatten route) -- only sets
// flatten_requested=true. The running worker (server/lit_grid_live.py, flatten_all()) picks it
// up on its next tick: cancels every resting order, market-sells all held LIT back to USDC,
// clears the flag and disables. Same flag-based pattern as the hedge panel's Close Both.
// Auth-gated too (2026-10-18, audit finding) -- an unauthorized Flatten is itself a real-money
// risk (a forced liquidation nobody asked for), not just enable/settings.
export async function POST(req: NextRequest) {
  const authError = checkLitGridLiveAuth(req);
  if (authError) return authError;
  const { error } = await getSupabaseAdmin()
    .from("lighter_lit_grid_live_state")
    .update({ flatten_requested: true })
    .eq("id", 1);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
