/**
 * 1. Market-buy ~$5 of XLM
 * 2. Place OCO (TP +20%, SL -20%) using the newly bought XLM
 * 3. Cancel the OCO immediately (no real trade held)
 */

import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE   = "https://api.binance.us/api/v3";
const KEY    = process.env.BINANCE_API_KEY!;
const SECRET = process.env.BINANCE_API_SECRET!;
const SYMBOL = "XLMUSDT";
const BUY_USDT = 5;

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

async function signedGet(path: string, params: Record<string, string | number> = {}) {
  const qs = new URLSearchParams(Object.entries({ ...params, timestamp: Date.now() }).map(([k, v]) => [k, String(v)]));
  qs.append("signature", sign(qs.toString()));
  const res = await fetch(`${BASE}${path}?${qs}`, { headers: { "X-MBX-APIKEY": KEY }, cache: "no-store" });
  return res.json();
}

function roundPrice(p: number) { return Math.round(p * 100000) / 100000; }

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  // Get live price
  const ticker = await fetch(`${BASE}/ticker/price?symbol=${SYMBOL}`).then(r => r.json());
  const price = parseFloat(ticker.price);
  const buyQty = Math.floor(BUY_USDT / price);
  console.log(`\nXLM price : $${price}`);
  console.log(`Buying    : ${buyQty} XLM (~$${(buyQty * price).toFixed(2)})\n`);

  // Step 1: Market buy
  console.log("--- Step 1: Market buy ---");
  const buyResult = await signedPost("/order", {
    symbol:   SYMBOL,
    side:     "BUY",
    type:     "MARKET",
    quantity: buyQty.toString(),
  });
  console.log(`Status: ${buyResult.status}  ok: ${buyResult.ok}`);
  if (!buyResult.ok) {
    console.log("Buy failed:", buyResult.body);
    return;
  }
  const buyOrder = JSON.parse(buyResult.body);
  const filledQty  = Math.floor(parseFloat(buyOrder.executedQty));
  const fillPrice  = parseFloat(buyOrder.cummulativeQuoteQty) / parseFloat(buyOrder.executedQty);
  console.log(`Filled: ${filledQty} XLM @ $${fillPrice.toFixed(5)}\n`);

  // Brief pause for balance to settle
  await sleep(1500);

  // Check free XLM balance
  const acct = await signedGet("/account");
  const xlmBal = acct.balances?.find((b: any) => b.asset === "XLM");
  const xlmFree = Math.floor(parseFloat(xlmBal?.free ?? "0"));
  console.log(`Free XLM after buy: ${xlmFree}\n`);

  const tp  = roundPrice(price * 1.20);
  const sl  = roundPrice(price * 0.80);
  const slL = roundPrice(sl * 0.998);
  console.log(`TP (+20%) : $${tp}`);
  console.log(`SL (-20%) : $${sl}  (limit $${slL})`);

  // Step 2: Place OCO
  console.log("\n--- Step 2: Place OCO ---");
  const ocoResult = await signedPost("/order/oco", {
    symbol:               SYMBOL,
    side:                 "SELL",
    quantity:             xlmFree.toString(),
    price:                tp.toFixed(5),
    stopPrice:            sl.toFixed(5),
    stopLimitPrice:       slL.toFixed(5),
    stopLimitTimeInForce: "GTC",
  });
  console.log(`Status: ${ocoResult.status}  ok: ${ocoResult.ok}`);

  if (!ocoResult.ok) {
    console.log("OCO failed:", ocoResult.body);
    console.log("\nOCO test FAILED ✗");
    return;
  }

  const oco = JSON.parse(ocoResult.body);
  console.log(`orderListId : ${oco.orderListId}`);
  for (const r of oco.orderReports ?? []) {
    console.log(`  orderId=${r.orderId}  type=${r.type}  price=${r.price}  stop=${r.stopPrice ?? "-"}`);
  }

  // Verify parsing matches what live-bot-xlm.ts does
  const slReport = oco.orderReports.find((r: any) => r.type === "STOP_LOSS_LIMIT" || r.type === "STOP_LOSS");
  const tpReport = oco.orderReports.find((r: any) => r !== slReport);
  console.log(`\nParsed slReport: orderId=${slReport?.orderId} type=${slReport?.type}`);
  console.log(`Parsed tpReport: orderId=${tpReport?.orderId} type=${tpReport?.type}`);

  if (!slReport || !tpReport) {
    console.log("\nPARSING BUG: slReport or tpReport is undefined!");
    return;
  }

  // Step 3: Cancel OCO immediately
  console.log("\n--- Step 3: Cancel OCO (cleanup) ---");
  const cancel = await signedDelete("/orderList", { symbol: SYMBOL, orderListId: oco.orderListId });
  console.log("Cancel result:", JSON.stringify(cancel).slice(0, 150));

  console.log("\nOCO test PASSED ✓ — parsing works, OCO is supported");
}

main().catch(console.error);
