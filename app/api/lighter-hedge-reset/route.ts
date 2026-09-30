import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// One button, both legs. Wipes trade history, rolls any residual realized PnL into seed_usd
// (cumulative equity carries through the reset instead of vanishing), clears transient
// self-lock/checkpoint fields left over from earlier experiments, and leaves both legs
// disabled -- matches the manual reset flow done by hand throughout 2026-09-30 (built into a
// single button after that turned out to need too many individual steps). Refuses if either
// leg has an open position: a reset is for a clean flat slate, never meant to touch a live one.
export async function POST() {
  const sb = getSupabaseAdmin();

  const [{ data: longState }, { data: shortState }] = await Promise.all([
    sb.from("lighter_btc_optimal_state").select("side, seed_usd, realized_pnl_usd").eq("id", 1).single(),
    sb.from("lighter_stoch_dca_btc_state").select("side, seed_usd, realized_pnl_usd").eq("id", 1).single(),
  ]);

  if (longState?.side != null || shortState?.side != null) {
    return NextResponse.json(
      { error: "Refusing to reset -- one or both legs still have an open position." },
      { status: 409 }
    );
  }

  const longSeed = (longState?.seed_usd ?? 0) + (longState?.realized_pnl_usd ?? 0);
  const shortSeed = (shortState?.seed_usd ?? 0) + (shortState?.realized_pnl_usd ?? 0);

  const resetFields = {
    realized_pnl_usd: 0,
    close_requested: false,
    consecutive_entry_failures: 0,
    profit_lock_peak_pct: null,
    // Stale per-position bands left behind by the retired Worker 3 joint-adaptive strategy gave
    // the hedge SHORT leg a 0.0909% stop instead of its configured 0.03% (2026-09-30 audit). The
    // worker no longer reads these columns at all, but a reset should still leave the row honest.
    position_tp_pct: null,
    position_sl_pct: null,
    // Breakeven-floor baseline is per-cycle -- a reset always leaves both legs flat, so it must
    // not survive into the next cycle.
    cycle_partner_pnl_baseline: null,
    position_stoch_checkpoint: null,
    paper_joint_checkpoint: null,
    real_trading_locked: false,
    paper_side: null,
    paper_entry_price: null,
    paper_entry_time: null,
    paper_consecutive_tps: 0,
    enabled: false,
  };

  await Promise.all([
    sb.from("lighter_btc_optimal_trades").delete().gt("id", 0),
    sb.from("lighter_stoch_dca_btc_trades").delete().gt("id", 0),
    sb.from("lighter_btc_optimal_state").update({ seed_usd: longSeed, ...resetFields }).eq("id", 1),
    sb.from("lighter_stoch_dca_btc_state").update({ seed_usd: shortSeed, ...resetFields }).eq("id", 1),
  ]);

  return NextResponse.json({ ok: true, longSeed, shortSeed });
}
