import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Paper only, no real orders -- no position to sell before clearing, unlike the real-money bots.
export async function POST() {
  const sb = getSupabaseAdmin();
  const { data: state } = await sb.from("solbtc_participation_state").select("enabled").eq("id", 1).single();
  if (state?.enabled) {
    return NextResponse.json({ ok: false, error: "Pause the bot before clearing history." }, { status: 409 });
  }

  await sb.from("solbtc_participation_trades").delete().gt("id", 0);
  await sb.from("solbtc_participation_runs").delete().gt("id", 0);
  await sb.from("solbtc_participation_state").update({
    side: "BTC", btc_balance: 1, sol_qty: 0, pending: null,
    virtual_side: "BTC", virtual_pending: null, base: "BTC",
    v: 0, s_up: 0, s_down: 0, d: 0, score_v: 0, m: 0, score_t: 0, orientation: 1,
    fast_ewma: null, slow_ewma: null, trend_variance: 0, trend: 0, price_ok: 0, fast_mode: 0,
    last_log_price: null, last_candle_ts: null,
    realized_pnl_btc: 0, total_trades: 0, total_wins: 0,
  }).eq("id", 1);
  return NextResponse.json({ ok: true });
}
