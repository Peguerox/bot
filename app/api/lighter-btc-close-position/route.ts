import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

const ALLOWED_TABLES = new Set([
  "lighter_stoch_dca_btc_state",
  "lighter_btc_initial_state",
  "lighter_btc_optimal_state",
]);

// Sets close_requested -- the running worker (which holds the real exchange credentials)
// picks this up on its next tick and closes the real position itself via its own tested
// close_all() logic. This route never touches the exchange directly: Lighter's signing SDK
// is Python-only, so there is no safe way to place an order from this Next.js route without
// duplicating private keys into a second runtime.
export async function POST(req: NextRequest) {
  const { table } = await req.json();
  if (!ALLOWED_TABLES.has(table)) {
    return NextResponse.json({ error: "invalid table" }, { status: 400 });
  }
  const sb = getSupabaseAdmin();
  const { error } = await sb.from(table).update({ close_requested: true }).eq("id", 1);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
