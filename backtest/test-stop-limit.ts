/**
 * Places a STOP_LOSS_LIMIT sell order way below market then immediately cancels it.
 * Confirms the order type and price format are accepted by Binance.US.
 *
 * Run: npx ts-node --transpile-only backtest/test-stop-limit.ts
 */

import { getPrice, placeStopLimitSell, cancelOrder } from "../lib/binance";

const SYMBOL = "ATOMUSDT";

function roundPrice(p: number) { return Math.round(p * 1000) / 1000; }

async function main() {
  const price = await getPrice(SYMBOL);
  console.log(`Current ATOM price: $${price}`);

  // Place stop well below market so it never triggers
  const stopPrice  = roundPrice(price * 0.85);   // 15% below market
  const limitPrice = roundPrice(stopPrice - 0.001);
  const qty        = 0.57; // ~$1 worth

  console.log(`Placing STOP_LOSS_LIMIT: stop=$${stopPrice}  limit=$${limitPrice}  qty=${qty}`);

  try {
    const order = await placeStopLimitSell(SYMBOL, qty, stopPrice, limitPrice);
    console.log(`✓ Order placed! orderId=${order.orderId}  status=${order.status}`);

    // Cancel immediately
    await cancelOrder(SYMBOL, order.orderId);
    console.log(`✓ Order cancelled cleanly — STOP_LOSS_LIMIT works!`);
  } catch (err) {
    console.error(`✗ FAILED:`, err);
  }
}

main().catch(console.error);
