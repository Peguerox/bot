import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// One strategy, two legs, one switch. The hedge bot is a single process (Worker 2's Render
// service) controlling both real sub-accounts at once -- there is no such thing as "just the
// long leg on" or "just the short leg on". This flips lighter_btc_optimal_state (long leg) and
// lighter_stoch_dca_btc_state (short leg) together, off the long leg's current value as the
// single source of truth.
export async function POST() {
  const sb = getSupabaseAdmin();
  const { data, error: readError } = await sb
    .from("lighter_btc_optimal_state")
    .select("enabled")
    .eq("id", 1)
    .single();
  if (readError || typeof data?.enabled !== "boolean") {
    return NextResponse.json({ error: "Could not read the hedge's ON/OFF state. No change was requested." }, { status: 500 });
  }
  const newState = !data.enabled;
  const results = await Promise.all([
    sb.from("lighter_btc_optimal_state").update({ enabled: newState }).eq("id", 1).select("enabled").single(),
    sb.from("lighter_stoch_dca_btc_state").update({ enabled: newState }).eq("id", 1).select("enabled").single(),
  ]);
  if (results.some((r) => r.error || r.data?.enabled !== newState)) {
    return NextResponse.json({ error: "Could not confirm the ON/OFF change on both hedge legs. One leg may have changed. Refresh the dashboard and check both legs before trying again." }, { status: 500 });
  }
  return NextResponse.json({ enabled: newState });
}
