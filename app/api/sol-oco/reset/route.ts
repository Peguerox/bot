import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Clears tracked position/order state back to flat — for when the real Binance Global
// account was manually adjusted outside the bot, leaving the bot's tracked state out of
// sync with reality. Does not touch trade history or realized PnL/win counters.
export async function POST() {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("sol_oco_state").select("enabled").eq("id", 1).single();
  if (data?.enabled) {
    return NextResponse.json({ ok: false, error: "Pause the bot before resetting." }, { status: 400 });
  }
  await sb.from("sol_oco_state").update({
    mode:              "USD",
    sol_quantity:      null,
    entry_price:       null,
    entry_time:        null,
    buy_order_id:      null,
    oco_order_list_id: null,
    oco_tp_order_id:   null,
    oco_sl_order_id:   null,
  }).eq("id", 1);
  return NextResponse.json({ ok: true });
}
