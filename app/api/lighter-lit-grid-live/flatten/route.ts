import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// REAL MONEY emergency control. Never touches the exchange directly (Lighter's signing SDK is
// Python-only, same reason as every other bot's close/flatten route) -- only sets
// flatten_requested=true. The running worker (server/lit_grid_live.py, flatten_all()) picks it
// up on its next tick: cancels every resting order, market-sells all held LIT back to USDC,
// clears the flag and disables. Same flag-based pattern as the hedge panel's Close Both.
export async function POST() {
  const { error } = await getSupabaseAdmin()
    .from("lighter_lit_grid_live_state")
    .update({ flatten_requested: true })
    .eq("id", 1);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
