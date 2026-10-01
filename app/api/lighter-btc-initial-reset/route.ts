import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Worker 1 only (lighter_btc_initial_state) -- deliberately NOT a shared multi-table route like
// lighter-hedge-reset, since lighter_stoch_dca_btc_state/lighter_btc_optimal_state are currently
// owned by the hedge dual-leg process, not Worker 1; mixing them into one generic endpoint risks
// resetting the wrong bot. Also deliberately NOT destructive, unlike the hedge reset: Worker 1's
// reset has always kept every trade row forever (audit trail) and just hidden everything before
// a cutoff -- this route is that same non-destructive pattern, just moved out of a hardcoded
// frontend constant (WORKER1_RESET_AT, bumped by hand on every prior reset) into the DB so the
// button can set it itself. Refuses while a position is open, same as the hedge reset.
export async function POST() {
  const sb = getSupabaseAdmin();

  const { data: state } = await sb
    .from("lighter_btc_initial_state")
    .select("side, seed_usd, realized_pnl_usd")
    .eq("id", 1)
    .single();

  if (state?.side != null) {
    return NextResponse.json(
      { error: "Refusing to reset -- a position is still open." },
      { status: 409 }
    );
  }

  const newSeed = (state?.seed_usd ?? 0) + (state?.realized_pnl_usd ?? 0);
  const nowIso = new Date().toISOString();

  await sb
    .from("lighter_btc_initial_state")
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

  return NextResponse.json({ ok: true, seed: newSeed, historyResetAt: nowIso });
}
