import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getPrice, getFreeBalance } from "@/lib/binance";

export async function POST() {
  const sb = getSupabaseAdmin();
  const errors: string[] = [];

  // Force-close any stuck open/pending positions, then delete all
  await sb.from("xlm_live_positions")
    .update({ status: "closed", result: "CLEARED", exit_time: new Date().toISOString() })
    .in("status", ["pending_entry", "open", "chasing"]);

  const { error: posErr } = await sb.from("xlm_live_positions")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");

  if (posErr) errors.push(`positions: ${posErr.message}`);

  const { error: runsErr } = await sb.from("xlm_live_runs")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");

  if (runsErr) errors.push(`runs: ${runsErr.message}`);

  const { data: st } = await sb.from("xlm_live_settings").select("id, total_usdt").single();

  // Try to fetch real USDT balance — works if BINANCE_API_KEY is not IP-restricted
  let totalUsdt: number | null = null;
  try { totalUsdt = await getFreeBalance("USDT"); } catch {}

  if (st) {
    await sb.from("xlm_live_settings")
      .update({
        baseline_usdt: 0,
        usdt_balance:  25,
        pending_sell:  false,
        // Update total_usdt if we got a fresh value, otherwise keep the stored value
        ...(totalUsdt !== null && totalUsdt > 0 ? { total_usdt: totalUsdt } : {}),
      })
      .eq("id", st.id);
  }

  // Write a synthetic log so BTC price shows on dashboard immediately
  let btcPrice = 0;
  try { btcPrice = await getPrice("BTCUSDT"); } catch {}
  if (btcPrice > 0) {
    await sb.from("xlm_live_runs").insert({
      run_at: new Date().toISOString(),
      data:   { actions: [{ action: "WATCH", xlmGLRet: "0.0000", price: btcPrice }] },
    });
  }

  return NextResponse.json({ ok: errors.length === 0, errors, btcPrice, totalUsdt });
}
