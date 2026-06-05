/**
 * Test OCO order placement — prints exchange filters and attempts a real OCO.
 * Run: npx ts-node --transpile-only backtest/test-oco.ts
 */

import crypto from "crypto";

const BASE    = "https://api.binance.us/api/v3";
const KEY     = process.env.BINANCE_API_KEY!;
const SECRET  = process.env.BINANCE_API_SECRET!;
const SYMBOL  = "ATOMUSDT";

function sign(payload: string) {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
}

async function signedPost(path: string, params: Record<string, string | number>) {
  const body = new URLSearchParams(
    Object.entries({ ...params, timestamp: Date.now() }).map(([k, v]) => [k, String(v)])
  );
  body.append("signature", sign(body.toString()));
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "X-MBX-APIKEY": KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    cache: "no-store",
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

async function get(path: string, params: Record<string, string | number> = {}) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const res = await fetch(`${BASE}${path}${qs.toString() ? "?" + qs : ""}`, {
    headers: { "X-MBX-APIKEY": KEY },
    cache: "no-store",
  });
  return res.json();
}

function roundPrice(p: number) { return Math.round(p * 10000) / 10000; }
function floorQty(q: number)   { return Math.floor(q * 100) / 100; }

async function main() {
  // 1. Exchange filters for ATOMUSDT
  console.log("\n=== ATOMUSDT Exchange Filters ===");
  const info    = await get("/exchangeInfo", { symbol: SYMBOL });
  const symInfo = info.symbols?.[0];
  if (symInfo) {
    for (const f of symInfo.filters) {
      console.log(" ", f.filterType, JSON.stringify(f));
    }
  }

  // 2. Current price
  const ticker  = await get("/ticker/price", { symbol: SYMBOL });
  const price   = parseFloat(ticker.price);
  console.log(`\nCurrent ATOM price: ${price}`);

  // 3. Simulate fill price — pretend we filled at current price
  const fillPrice = price;
  const qty       = floorQty(200 / fillPrice);
  const tp        = roundPrice(fillPrice * 1.008);
  const sl        = roundPrice(fillPrice * 0.997);
  const slLimit   = roundPrice(sl - 0.0001);

  console.log(`\nSimulated OCO params:`);
  console.log(`  qty      = ${qty.toFixed(2)}`);
  console.log(`  tp price = ${tp.toFixed(4)}  (must be > ${price})`);
  console.log(`  sl stop  = ${sl.toFixed(4)}  (must be < ${price})`);
  console.log(`  sl limit = ${slLimit.toFixed(4)}  (must be <= sl stop)`);

  // 4. Attempt the OCO
  console.log(`\n=== Attempting OCO on /order/oco ===`);
  const r1 = await signedPost("/order/oco", {
    symbol:               SYMBOL,
    side:                 "SELL",
    quantity:             qty.toFixed(2),
    price:                tp.toFixed(4),
    stopPrice:            sl.toFixed(4),
    stopLimitPrice:       slLimit.toFixed(4),
    stopLimitTimeInForce: "GTC",
  });
  console.log(`  Status: ${r1.status}  ok: ${r1.ok}`);
  console.log(`  Response: ${r1.body}`);

  // 5. Also try the newer /orderList/oco endpoint if the first fails
  if (!r1.ok) {
    console.log(`\n=== Trying newer /orderList/oco endpoint ===`);
    const r2 = await signedPost("/orderList/oco", {
      symbol:               SYMBOL,
      side:                 "SELL",
      quantity:             qty.toFixed(2),
      aboveType:            "LIMIT_MAKER",
      abovePrice:           tp.toFixed(4),
      belowType:            "STOP_LOSS_LIMIT",
      belowStopPrice:       sl.toFixed(4),
      belowPrice:           slLimit.toFixed(4),
      belowTimeInForce:     "GTC",
    });
    console.log(`  Status: ${r2.status}  ok: ${r2.ok}`);
    console.log(`  Response: ${r2.body}`);
  }
}

main().catch(console.error);
