import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getPrice } from "@/lib/binance";

export async function POST() {
  const sb = getSupabaseAdmin();
  const errors: string[] = [];

  await sb.from("btc_live_positions")
    .update({ status: "closed", result: "CLEARED", exit_time: new Date().toISOString() })
    .in("status", ["pending_entry", "open", "chasing"]);

  const { error: posErr } = await sb.from("btc_live_positions")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");
  if (posErr) errors.push(`positions: ${posErr.message}`);

  const { error: runsErr } = await sb.from("btc_live_runs")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");
  if (runsErr) errors.push(`runs: ${runsErr.message}`);

  const { data: st } = await sb.from("btc_live_settings").select("id").single();
  if (st) {
    await sb.from("btc_live_settings")
      .update({
        baseline_usdt: 0,
        usdt_balance:  25,
        pending_sell:  false,
      })
      .eq("id", st.id);
  }

  let btcPrice = 0;
  try { btcPrice = await getPrice("BTCUSDT"); } catch {}
  if (btcPrice > 0) {
    await sb.from("btc_live_runs").insert({
      run_at: new Date().toISOString(),
      data:   { actions: [{ action: "WATCH", xlmGLRet: "0.0000", price: btcPrice }] },
    });
  }

  return NextResponse.json({ ok: errors.length === 0, errors, btcPrice });
}
