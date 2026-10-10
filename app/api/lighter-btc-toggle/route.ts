import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

const ALLOWED_TABLES = new Set([
  "lighter_stoch_dca_btc_state",
  "lighter_btc_initial_state",
  "lighter_btc_optimal_state",
  "lighter_btc_worker4_state",
]);

export async function POST(req: NextRequest) {
  const { table } = await req.json();
  if (!ALLOWED_TABLES.has(table)) {
    return NextResponse.json({ error: "invalid table" }, { status: 400 });
  }
  const sb = getSupabaseAdmin();
  const { data, error: readError } = await sb.from(table).select("enabled").eq("id", 1).single();
  if (readError || typeof data?.enabled !== "boolean") {
    return NextResponse.json({ error: "Could not read the bot's ON/OFF state. No change was requested." }, { status: 500 });
  }
  const newState = !data.enabled;
  const patch: Record<string, unknown> = { enabled: newState };
  // Cold start requires proof first: flipping OFF->ON re-locks real trading behind the
  // self-lock's normal 2-consecutive-paper-wins bar, same as a real SL would -- direct
  // request, to avoid landing on whatever the market is doing the instant a bot comes back
  // on, rather than assuming conditions are fine just because a human clicked ON.
  if (newState) {
    patch.real_trading_locked = true;
    patch.paper_consecutive_tps = 0;
  }
  const { data: updated, error: updateError } = await sb.from(table)
    .update(patch).eq("id", 1).select("enabled").single();
  if (updateError || updated?.enabled !== newState) {
    return NextResponse.json({ error: "Could not confirm the ON/OFF change. Refresh the dashboard to check the current state before trying again." }, { status: 500 });
  }
  return NextResponse.json({ enabled: newState, real_trading_locked: patch.real_trading_locked ?? null });
}
