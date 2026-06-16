import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getFreeBalance, placeLimitSellSol, cancelAllOrders } from "@/lib/binance";

export async function POST() {
  const sb = getSupabaseAdmin();

  try {
    // Cancel any open chase order first
    try { await cancelAllOrders("SOLBTC"); } catch {}

    // Sell all free SOL at market via limit chase (bot will handle fill next run)
    const solFree = await getFreeBalance("SOL");
    const solQty  = Math.floor(solFree * 100) / 100;

    let orderId: number | null = null;
    if (solQty >= 0.01) {
      // Get current price to place limit sell
      const priceRes = await fetch("https://api.binance.us/api/v3/ticker/price?symbol=SOLBTC");
      const { price } = await priceRes.json();
      const livePrice = parseFloat(price);
      const order = await placeLimitSellSol("SOLBTC", solQty, livePrice);
      orderId = order.orderId;

      // Update surfer_state to chasing_sell so the bot manages the fill
      await sb.from("surfer_state").update({
        status:         "chasing_sell",
        armed_for_btc:  false,
        chase_order_id: orderId,
        chase_price:    Math.round(livePrice * 1e7) / 1e7,
      }).eq("id", 1);
    } else {
      // No SOL held — just reset to BTC mode
      await sb.from("surfer_state").update({
        mode:           "BTC",
        status:         "idle",
        armed_for_sol:  false,
        armed_for_btc:  false,
        sol_quantity:   null,
        entry_price:    null,
        entry_btc:      null,
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
