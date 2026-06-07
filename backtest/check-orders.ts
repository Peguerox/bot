import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE   = "https://api.binance.us/api/v3";
const KEY    = process.env.BINANCE_API_KEY!;
const SECRET = process.env.BINANCE_API_SECRET!;

function sign(payload: string) {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
}

async function signedGet(path: string, params: Record<string, string | number> = {}) {
  const qs = new URLSearchParams(Object.entries({ ...params, timestamp: Date.now() }).map(([k, v]) => [k, String(v)]));
  qs.append("signature", sign(qs.toString()));
  const res = await fetch(`${BASE}${path}?${qs}`, { headers: { "X-MBX-APIKEY": KEY }, cache: "no-store" });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

(async () => {
  console.log("=== Open Orders for XLMUSDT ===");
  const orders = await signedGet("/openOrders", { symbol: "XLMUSDT" });
  console.log("Status:", orders.status, "ok:", orders.ok);
  if (orders.ok) {
    const parsed = JSON.parse(orders.body);
    console.log("Count:", parsed.length);
    for (const o of parsed) {
      console.log(`  orderId=${o.orderId} type=${o.type} side=${o.side} price=${o.price} stopPrice=${o.stopPrice} qty=${o.origQty} status=${o.status} listId=${o.orderListId}`);
    }
  } else {
    console.log("Error:", orders.body);
  }

  console.log("\n=== XLM + USDT Balances ===");
  const acct = await signedGet("/account");
  if (acct.ok) {
    const parsed = JSON.parse(acct.body);
    for (const b of parsed.balances) {
      if (["XLM", "USDT", "BNB"].includes(b.asset)) {
        console.log(`  ${b.asset}: free=${b.free} locked=${b.locked}`);
      }
    }
  } else {
    console.log("Error:", acct.body);
  }

  console.log("\n=== Open OCO Order Lists ===");
  const ocos = await signedGet("/openOrderList");
  console.log("Status:", ocos.status, "ok:", ocos.ok);
  if (ocos.ok) {
    const parsed = JSON.parse(ocos.body);
    console.log("Count:", parsed.length);
    for (const o of parsed) {
      console.log(`  orderListId=${o.orderListId} symbol=${o.symbol} status=${o.listStatusType}`);
    }
  } else {
    console.log("Error:", ocos.body);
  }
})();
