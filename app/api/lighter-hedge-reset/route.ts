import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Preserves every trade row for research. The shared cutoff clears the displayed history;
// realized PnL rolls into seed_usd so equity carries through. Both legs must already be OFF
// and flat, with no close pending. Requires lighter_hedge_reset_cutoff.sql on both tables.
export async function POST() {
  try {
    return await resetHedge();
  } catch {
    return NextResponse.json({ error: "Could not confirm the reset. Refresh the dashboard and check both legs before trying again." }, { status: 500 });
  }
}

async function resetHedge() {
  const sb = getSupabaseAdmin();

  const columns = "side, enabled, close_requested, seed_usd, realized_pnl_usd, history_reset_at";
  const states = await Promise.all([
    sb.from("lighter_btc_optimal_state").select(columns).eq("id", 1).single(),
    sb.from("lighter_stoch_dca_btc_state").select(columns).eq("id", 1).single(),
  ]);

  if (states.some((r) => r.error || !r.data)) {
    return NextResponse.json({ error: "Could not read both hedge states. Nothing was reset. Check that the reset database update has been applied." }, { status: 500 });
  }
  const [longState, shortState] = states.map((r) => r.data!);
  if ([longState, shortState].some((s) => s.side !== null || s.enabled !== false || s.close_requested !== false)) {
    return NextResponse.json(
      { error: "Reset requires BOTH legs to be OFF and flat, with no close pending. Use Close Both and wait for it to finish first." },
      { status: 409 }
    );
  }

  if ([longState, shortState].some((s) => !Number.isFinite(s.seed_usd) || !Number.isFinite(s.realized_pnl_usd)
      || !Number.isFinite(s.seed_usd + s.realized_pnl_usd))) {
    return NextResponse.json({ error: "Could not read both hedge balances. Nothing was reset." }, { status: 500 });
  }
  const longSeed = longState.seed_usd + longState.realized_pnl_usd;
  const shortSeed = shortState.seed_usd + shortState.realized_pnl_usd;
  const historyResetAt = new Date().toISOString();
  // PostgreSQL's float JSON/text output rounds the last few digits. Exact equality
  // can miss the unchanged row. Allow only machine-rounding error (under $4e-14
  // at a $20 balance), while rejecting meaningful concurrent balance changes.
  const tolerance = (value: number) => 8 * Number.EPSILON * Math.max(1, Math.abs(value));

  const resetFields = {
    realized_pnl_usd: 0,
    history_reset_at: historyResetAt,
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

  // Match the state we read: a concurrent balance change or re-enable must not be overwritten.
  // These are separate updates; report a partial result rather than pretending both succeeded.
  const results = await Promise.allSettled([
    sb.from("lighter_btc_optimal_state").update({ seed_usd: longSeed, ...resetFields })
      .eq("id", 1).is("side", null).eq("enabled", false).eq("close_requested", false)
      .gte("seed_usd", longState.seed_usd - tolerance(longState.seed_usd))
      .lte("seed_usd", longState.seed_usd + tolerance(longState.seed_usd))
      .gte("realized_pnl_usd", longState.realized_pnl_usd - tolerance(longState.realized_pnl_usd))
      .lte("realized_pnl_usd", longState.realized_pnl_usd + tolerance(longState.realized_pnl_usd))
      .select("seed_usd, realized_pnl_usd, history_reset_at").single(),
    sb.from("lighter_stoch_dca_btc_state").update({ seed_usd: shortSeed, ...resetFields })
      .eq("id", 1).is("side", null).eq("enabled", false).eq("close_requested", false)
      .gte("seed_usd", shortState.seed_usd - tolerance(shortState.seed_usd))
      .lte("seed_usd", shortState.seed_usd + tolerance(shortState.seed_usd))
      .gte("realized_pnl_usd", shortState.realized_pnl_usd - tolerance(shortState.realized_pnl_usd))
      .lte("realized_pnl_usd", shortState.realized_pnl_usd + tolerance(shortState.realized_pnl_usd))
      .select("seed_usd, realized_pnl_usd, history_reset_at").single(),
  ]);

  const seeds = [longSeed, shortSeed];
  if (results.some((r, i) => r.status !== "fulfilled" || r.value.error
      || r.value.data?.seed_usd !== seeds[i] || r.value.data?.realized_pnl_usd !== 0
      || Date.parse(r.value.data?.history_reset_at ?? "") !== Date.parse(historyResetAt))) {
    return NextResponse.json({ error: "Could not confirm the reset on both hedge legs. One leg may have reset. No trades were deleted. Refresh the dashboard and check both legs before trying again." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, longSeed, shortSeed, historyResetAt });
}
