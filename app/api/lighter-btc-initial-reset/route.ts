import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Worker 1 only (lighter_btc_initial_state) -- deliberately NOT a shared multi-table route, since
// lighter_stoch_dca_btc_state/lighter_btc_optimal_state are owned by the hedge dual-leg process;
// mixing them into one endpoint risks resetting the wrong bot.
//
// 2026-10-01, direct request: same behaviour as the hedge reset (lighter-hedge-reset) -- wipes
// the trade history, rolls residual PnL into seed_usd, clears transient fields, leaves the bot
// disabled. The previous version never worked: it wrote history_reset_at, a column whose
// migration was never run, so PostgREST rejected the whole update and the route still returned
// ok:true because it never checked the error. Every write is now checked. Refuses while a
// position is open.
export async function POST() {
  const sb = getSupabaseAdmin();

  const { data: state, error: readError } = await sb
    .from("lighter_btc_initial_state")
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

  const { error: deleteError } = await sb.from("lighter_btc_initial_trades").delete().gt("id", 0);
  if (deleteError) {
    return NextResponse.json({ error: `Reset failed deleting trades: ${deleteError.message}` }, { status: 500 });
  }

  const { error: updateError } = await sb
    .from("lighter_btc_initial_state")
    .update({
      seed_usd: newSeed,
      realized_pnl_usd: 0,
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

  return NextResponse.json({ ok: true, seed: newSeed });
}
