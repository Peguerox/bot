import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { checkLitGridLiveAuth } from "@/lib/lit-grid-live-auth";

// REAL MONEY. NEAR flip martingale (server/lit_flip_live.py with FLIP_COIN=NEAR, Worker 1's account). ON/OFF only stops or allows NEW
// sequences; an open position keeps its target and flip orders. Turning it ON is the owner's call.
const TABLE = "lighter_near_flip_state";

export async function POST(req: NextRequest) {
  const authError = checkLitGridLiveAuth(req);
  if (authError) return authError;
  const sb = getSupabaseAdmin();
  const { data: cur, error: readError } = await sb.from(TABLE).select("enabled").eq("id", 1).single();
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
  const next = !cur?.enabled;
  const { data: upd, error } = await sb.from(TABLE).update({ enabled: next }).eq("id", 1).select("enabled").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (upd?.enabled !== next) return NextResponse.json({ error: "Toggle did not take effect." }, { status: 500 });
  return NextResponse.json({ enabled: next });
}
