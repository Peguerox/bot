import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getFreeBalance, getPrice } from "@/lib/binance";

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

  // Fetch real balances from Binance so the dashboard shows correct values immediately
  let totalUsdt = 0;
  let xlmPrice  = 0;
  try { totalUsdt = await getFreeBalance("USDT"); } catch {}
  try { xlmPrice  = await getPrice("XLMUSDT");    } catch {}

  const { data: st } = await sb.from("xlm_live_settings").select("id").single();
  if (st) {
    await sb.from("xlm_live_settings")
      .update({
        baseline_usdt: 0,
        usdt_balance:  25,
        pending_sell:  false,
        total_usdt:    totalUsdt,
      })
      .eq("id", st.id);
  }

  // Write a synthetic run log so the dashboard shows the current XLM price right away
  if (xlmPrice > 0) {
    await sb.from("xlm_live_runs").insert({
      run_at: new Date().toISOString(),
      data:   { actions: [{ action: "WATCH", xlmGLRet: "0.0000", price: xlmPrice }] },
    });
  }

  return NextResponse.json({ ok: errors.length === 0, errors, totalUsdt, xlmPrice });
}
