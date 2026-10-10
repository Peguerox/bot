import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Worker 1 + Worker 4 only (lighter_btc_initial_state / lighter_btc_worker4_state) -- explicitly
// NOT the hedge's tables (lighter_stoch_dca_btc_state/lighter_btc_optimal_state are owned by the
// hedge dual-leg process; mixing them into one endpoint risks resetting the wrong bot). Worker 4
// added 2026-10-10 (exact clone of Worker 1, same table shape, same reset semantics) -- table is
// now a request param instead of hardcoded, gated by the allowlist below.
//
// NON-DESTRUCTIVE, deliberately unlike the hedge reset: trade rows are NEVER deleted -- they are
// the research data (e.g. the 575-trade timing/dispersion audits). Reset only stamps
// history_reset_at, and the dashboard hides trades closed before it. Rolls residual PnL into
// seed_usd, clears transient fields, leaves the bot disabled, refuses while a position is open.
//
// 2026-10-01: the first version silently did nothing -- history_reset_at's migration
// (lighter_btc_initial_reset_cutoff.sql) had never been run, PostgREST rejected the whole update,
// and the route returned ok:true without checking the error. Every call is now checked.
const ALLOWED_TABLES = new Set(["lighter_btc_initial_state", "lighter_btc_worker4_state"]);

export async function POST(req: NextRequest) {
  const { table } = await req.json().catch(() => ({ table: "lighter_btc_initial_state" }));
  if (!ALLOWED_TABLES.has(table)) {
    return NextResponse.json({ error: "invalid table" }, { status: 400 });
  }
  const sb = getSupabaseAdmin();

  const { data: state, error: readError } = await sb
    .from(table)
    .select("side, seed_usd, realized_pnl_usd")
    .eq("id", 1)
    .single();

  if (readError) {
    return NextResponse.json({ error: `Reset failed reading state: ${readError.message}` }, { status: 500 });
  }

  if (state?.side != null) {
    return NextResponse.json(
      { error: "Refusing to reset -- a position is still open." },
      { status: 409 }
    );
  }

  const newSeed = (state?.seed_usd ?? 0) + (state?.realized_pnl_usd ?? 0);

  const nowIso = new Date().toISOString();

  const { error: updateError } = await sb
    .from(table)
    .update({
      seed_usd: newSeed,
      realized_pnl_usd: 0,
      history_reset_at: nowIso,
      consecutive_entry_failures: 0,
      position_tp_pct: null,
      position_sl_pct: null,
      session_breaker_paused: false,
      session_breaker_session_start: null,
      session_breaker_baseline_pnl: null,
      session_breaker_peak_pnl: null,
      session_breaker_paused_at: null,
      session_breaker_trip_direction: null,
      session_breaker_next_check_at: null,
      session_breaker_trip_range_pct: null,
      close_requested: false,
      real_trading_locked: false,
      paper_side: null,
      paper_entry_price: null,
      paper_entry_time: null,
      paper_consecutive_tps: 0,
      profit_lock_peak_pct: null,
      enabled: false,
    })
    .eq("id", 1);

  if (updateError) {
    return NextResponse.json({ error: `Reset failed updating state: ${updateError.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true, seed: newSeed, historyResetAt: nowIso });
}
