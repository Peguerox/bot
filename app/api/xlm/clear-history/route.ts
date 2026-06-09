import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getPrice } from "@/lib/binance";

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

  const { data: st } = await sb.from("xlm_live_settings").select("id").single();
  if (st) {
    await sb.from("xlm_live_settings")
      .update({
        baseline_usdt: 0,
        usdt_balance:  25,
        pending_sell:  false,
        // total_usdt intentionally NOT reset — keep last known value so dashboard shows it.
        // The bot updates it on its first run automatically.
      })
      .eq("id", st.id);
  }

  // Write a synthetic log so the XLM price shows on the dashboard immediately
  let xlmPrice = 0;
  try { xlmPrice = await getPrice("XLMUSDT"); } catch {}
  if (xlmPrice > 0) {
    await sb.from("xlm_live_runs").insert({
      run_at: new Date().toISOString(),
      data:   { actions: [{ action: "WATCH", xlmGLRet: "0.0000", price: xlmPrice }] },
    });
  }

  return NextResponse.json({ ok: errors.length === 0, errors, xlmPrice });
}
