import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getFreeBalance, placeLimitSellSolUsdt, cancelAllOrders } from "@/lib/binance";

export async function POST() {
  const sb = getSupabaseAdmin();

  try {
    try { await cancelAllOrders("SOLUSDT"); } catch {}

    const solFree = await getFreeBalance("SOL");
    const solQty  = Math.floor(solFree * 100) / 100;

    let orderId: number | null = null;
    if (solQty >= 0.01) {
      const priceRes = await fetch("https://api.binance.us/api/v3/ticker/price?symbol=SOLUSDT");
      const { price } = await priceRes.json();
      const livePrice = parseFloat(price);
      const order = await placeLimitSellSolUsdt("SOLUSDT", solQty, livePrice);
      orderId = order.orderId;

      await sb.from("surfer_usdt_state").update({
        status:         "chasing_sell",
        armed_for_sol:  false,
        chase_order_id: orderId,
        chase_price:    Math.round(livePrice * 100) / 100,
      }).eq("id", 1);
    } else {
      await sb.from("surfer_usdt_state").update({
        mode:           "USDT",
        status:         "idle",
        armed_for_sol:  false,
        sol_quantity:   null,
        entry_price:    null,
        entry_usdt:     null,
        entry_time:     null,
        chase_order_id: null,
        chase_price:    null,
      }).eq("id", 1);
    }

    return NextResponse.json({ ok: true, solQty, orderId });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
