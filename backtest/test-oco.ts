/**
 * Test XLM OCO order: TP +20%, SL -20% from live price.
 * Places and immediately cancels so no real trade happens.
 * Run: npx ts-node --transpile-only backtest/test-oco.ts
 */

import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE   = "https://api.binance.us/api/v3";
const KEY    = process.env.BINANCE_API_KEY!;
const SECRET = process.env.BINANCE_API_SECRET!;
const SYMBOL = "XLMUSDT";

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

async function signedDelete(path: string, params: Record<string, string | number>) {
  const qs = new URLSearchParams(
    Object.entries({ ...params, timestamp: Date.now() }).map(([k, v]) => [k, String(v)])
  );
  qs.append("signature", sign(qs.toString()));
  const res = await fetch(`${BASE}${path}?${qs}`, {
    method: "DELETE",
    headers: { "X-MBX-APIKEY": KEY },
    cache: "no-store",
  });
  return res.json();
}

async function get(path: string, params: Record<string, string | number> = {}) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const res = await fetch(`${BASE}${path}${qs.toString() ? "?" + qs : ""}`, {
    headers: { "X-MBX-APIKEY": KEY },
    cache: "no-store",
  });
  return res.json();
}

function roundPrice(p: number) { return Math.round(p * 100000) / 100000; }

async function main() {
  // Get live price and free XLM balance
  const [ticker, account] = await Promise.all([
    get("/ticker/price", { symbol: SYMBOL }),
    get("/account", { timestamp: Date.now(), recvWindow: 5000 }),
  ]);

  // account needs signature
  const qs = new URLSearchParams({ timestamp: String(Date.now()), recvWindow: "5000" });
  qs.append("signature", sign(qs.toString()));
  const acct = await fetch(`${BASE}/account?${qs}`, { headers: { "X-MBX-APIKEY": KEY }, cache: "no-store" }).then(r => r.json());
  const xlmBalance = acct.balances?.find((b: any) => b.asset === "XLM");
  const xlmFree = parseFloat(xlmBalance?.free ?? "0");

  const price = parseFloat(ticker.price);
  const qty   = Math.max(1, Math.floor(xlmFree)); // use 1 XLM minimum for the test
  const tp    = roundPrice(price * 1.20);   // +20%
  const sl    = roundPrice(price * 0.80);   // -20%
  const slL   = roundPrice(sl * 0.998);     // SL limit 0.2% below stop

  console.log(`\nXLM price : $${price}`);
  console.log(`XLM free  : ${xlmFree}  →  using qty ${qty} for test`);
  console.log(`TP (+20%) : $${tp}`);
  console.log(`SL (-20%) : $${sl}  (limit $${slL})`);

  if (xlmFree < 1) {
    console.log("\nWarning: no free XLM — OCO will likely fail with insufficient balance.");
    console.log("Buy at least 1 XLM on Binance.US first, then re-run.\n");
  }

  console.log(`\n--- Placing OCO on /order/oco ---`);
  const r = await signedPost("/order/oco", {
    symbol:               SYMBOL,
    side:                 "SELL",
    quantity:             qty.toString(),
    price:                tp.toFixed(5),
    stopPrice:            sl.toFixed(5),
    stopLimitPrice:       slL.toFixed(5),
    stopLimitTimeInForce: "GTC",
  });

  console.log(`Status : ${r.status}  ok: ${r.ok}`);

  if (r.ok) {
    const parsed = JSON.parse(r.body);
    console.log(`orderListId : ${parsed.orderListId}`);
    for (const report of parsed.orderReports ?? []) {
      console.log(`  orderId ${report.orderId}  type=${report.type}  price=${report.price}  stop=${report.stopPrice ?? "-"}`);
    }

    console.log(`\n--- Cancelling OCO (cleanup) ---`);
    const cancel = await signedDelete("/orderList", { symbol: SYMBOL, orderListId: parsed.orderListId });
    console.log("Cancel result:", JSON.stringify(cancel).slice(0, 120));
    console.log("\nOCO test PASSED ✓");
  } else {
    console.log(`Response: ${r.body}`);
    console.log("\nOCO test FAILED ✗ — check error above");
  }
}

main().catch(console.error);
