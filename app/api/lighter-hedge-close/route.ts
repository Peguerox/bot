import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// One strategy, two legs, one close. 2026-09-30: the hedge pivot replaced Worker 2's
// CompactStochBtcPanel (which owned the only "Close Position" button) and marked Worker 3's panel
// dormant, so neither leg had a close control any more -- while lighter-hedge-reset refuses to run
// with a position open. That left no way out of an open cycle from the dashboard at all: couldn't
// close, couldn't reset. This is the missing half.
//
// Like lighter-btc-close-position, this never touches the exchange. It only sets close_requested;
// the running worker picks the flag up on its next tick and closes through its own tested
// close_all() path (Lighter's signing SDK is Python-only, so there is no safe way to place an
// order from a Next.js route without copying private keys into a second runtime). The worker
// retries with backoff until close_all confirms flat, then clears the flag and sets enabled=false
// -- so after this completes, both legs are flat and disabled and Reset will accept them.
export async function POST() {
  const sb = getSupabaseAdmin();

  const [{ data: longState }, { data: shortState }] = await Promise.all([
    sb.from("lighter_btc_optimal_state").select("side").eq("id", 1).single(),
    sb.from("lighter_stoch_dca_btc_state").select("side").eq("id", 1).single(),
  ]);

  if (longState?.side == null && shortState?.side == null) {
    return NextResponse.json(
      { error: "Nothing to close -- both legs are already flat." },
      { status: 409 }
    );
  }

  // Set on BOTH legs regardless of which one currently shows a position: the flag is a no-op on an
  // already-flat leg (the worker just clears it and disables that leg), and reading "flat" here is
  // only ever a snapshot -- a leg could enter between the read above and the write below, and this
  // way that entry still gets closed instead of being silently left open.
  const results = await Promise.all([
    sb.from("lighter_btc_optimal_state").update({ close_requested: true }).eq("id", 1),
    sb.from("lighter_stoch_dca_btc_state").update({ close_requested: true }).eq("id", 1),
  ]);

  const failed = results.find((r) => r.error);
  if (failed?.error) {
    return NextResponse.json({ error: failed.error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    requested: { long: longState?.side ?? null, short: shortState?.side ?? null },
  });
}
