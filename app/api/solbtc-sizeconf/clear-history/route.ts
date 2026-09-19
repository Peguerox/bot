import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Paper only, no real orders -- no position to sell before clearing, unlike the real-money bots.
export async function POST() {
  const sb = getSupabaseAdmin();
  const { data: state } = await sb.from("solbtc_sizeconf_state").select("enabled").eq("id", 1).single();
  if (state?.enabled) {
    return NextResponse.json({ ok: false, error: "Pause the bot before clearing history." }, { status: 409 });
  }

  await sb.from("solbtc_sizeconf_trades").delete().gt("id", 0);
  await sb.from("solbtc_sizeconf_runs").delete().gt("id", 0);
  await sb.from("solbtc_sizeconf_state").update({
    side: "BTC", pending: null, queued_ts: null, last_fill_ts: -1e18, pending_request_q: null,
    btc_balance: 1, sol_qty: 0,
    u: 0, w: 0, ut: 0, wt: 0, last_tiny_ts: -1e18,
    last_log_price: null, q_lag_prev: 0, resp_num: 0, resp_den: 0, resp_buf: [],
    active: false, minute_buf: [], window_mv: 0, window_sg: 0, window_ct: 0, prev_minute_close: null,
    er30: 1.0, log_equity: 0, peak_log_equity: 0, tightened: false,
    peak_since_entry: null, entry_price: null, entry_fill_ts: null, entry_reached_10bps: false,
    entry_request_q: null,
    last_closed_minute: null, current_minute_count: 0, current_minute_last_price: null,
    entry_btc: null, realized_pnl_btc: 0, total_trades: 0, total_wins: 0, last_tick_at: null,
  }).eq("id", 1);
  return NextResponse.json({ ok: true });
}
