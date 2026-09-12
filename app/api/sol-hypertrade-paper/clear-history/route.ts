import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { submitMarketOrderSafe } from "@/lib/bitfinex-auth";

const BFX_SYMBOL = "tSOLUSD";

// Worker 2 trades real money (since 2026-09-12) -- clearing history used to just wipe the DB's
// record of an open position without selling it first, which would orphan real SOL in the wallet
// (untracked, unmanaged, and the bot would immediately buy MORE from scratch on resume). Now
// sells any open real position before wiping, and refuses to clear at all if the worker is still
// running (defense in depth -- the dashboard button is already disabled while enabled, this
// guards direct API calls too).
export async function POST() {
  const sb = getSupabaseAdmin();
  const { data: state } = await sb.from("sol_hypertrade_paper_state").select("*").eq("id", 1).single();

  if (state?.enabled) {
    return NextResponse.json({ ok: false, error: "Pause the worker before clearing history." }, { status: 409 });
  }

  if (state && state.level > 0 && state.positions?.length > 0) {
    const qty = state.positions.reduce((s: number, p: { sol_qty: number }) => s + p.sol_qty, 0);
    try {
      const fill = await submitMarketOrderSafe(BFX_SYMBOL, -qty, "SOL");
      console.log(`clear-history: sold open real position before clearing -- qty=${qty} execPrice=${fill.execPrice}`);
    } catch (err) {
      console.error("clear-history: failed to sell open real position, refusing to clear:", err);
      return NextResponse.json({ ok: false, error: `Could not sell the open real position before clearing: ${String(err)}` }, { status: 500 });
    }
  }

  await sb.from("sol_hypertrade_paper_trades").delete().gt("id", 0);
  await sb.from("sol_hypertrade_paper_runs").delete().gt("id", 0);
  await sb.from("sol_hypertrade_paper_state").update({
    positions: [], total_cost: 0, level: 0, last_entry_price: null, tp_target: null,
    cycle_start_time: null, realized_pnl_usd: 0, total_cycles: 0, total_wins: 0,
    max_level_ever: 0, max_cost_ever: 0,
  }).eq("id", 1);
  return NextResponse.json({ ok: true });
}
