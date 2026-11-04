import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { checkLitGridLiveAuth } from "@/lib/lit-grid-live-auth";

// REAL MONEY emergency control for the NEAR flip martingale (Worker 1): sets close_requested; the bot cancels its orders,
// closes the position at market, then turns itself OFF. Never talks to the exchange directly.
const TABLE = "lighter_near_flip_state";

export async function POST(req: NextRequest) {
  const authError = checkLitGridLiveAuth(req);
  if (authError) return authError;
  const { error } = await getSupabaseAdmin().from(TABLE).update({ close_requested: true }).eq("id", 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
