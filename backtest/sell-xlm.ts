import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE   = "https://api.binance.us/api/v3";
const KEY    = process.env.BINANCE_API_KEY!;
const SECRET = process.env.BINANCE_API_SECRET!;

function sign(p: string) { return crypto.createHmac("sha256", SECRET).update(p).digest("hex"); }

async function signedGet(path: string, params: Record<string, string | number> = {}) {
  const qs = new URLSearchParams(Object.entries({ ...params, timestamp: Date.now() }).map(([k, v]) => [k, String(v)]));
  qs.append("signature", sign(qs.toString()));
  const res = await fetch(`${BASE}${path}?${qs}`, { headers: { "X-MBX-APIKEY": KEY }, cache: "no-store" });
  return res.json();
}

async function signedPost(path: string, params: Record<string, string | number>) {
  const body = new URLSearchParams(Object.entries({ ...params, timestamp: Date.now() }).map(([k, v]) => [k, String(v)]));
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

(async () => {
  const acct = await signedGet("/account");
  const xlmBal = acct.balances?.find((b: any) => b.asset === "XLM");
  const xlmFree = Math.floor(parseFloat(xlmBal?.free ?? "0"));
  const ticker = await fetch(`${BASE}/ticker/price?symbol=XLMUSDT`).then(r => r.json());
  const price = parseFloat(ticker.price);
  console.log(`XLM free: ${xlmFree}  price: $${price}  notional: $${(xlmFree * price).toFixed(2)}`);

  if (xlmFree < 1 || xlmFree * price < 1.0) {
    console.log("Nothing to sell (below MIN_NOTIONAL)");
    return;
  }

  const r = await signedPost("/order", {
    symbol:   "XLMUSDT",
    side:     "SELL",
    type:     "MARKET",
    quantity: xlmFree.toString(),
  });
  console.log(`Status: ${r.status}  ok: ${r.ok}`);
  const parsed = JSON.parse(r.body);
  if (r.ok) {
    const filled   = parseFloat(parsed.executedQty);
    const proceeds = parseFloat(parsed.cummulativeQuoteQty);
    console.log(`Sold ${filled} XLM for $${proceeds.toFixed(4)} USDT`);
  } else {
    console.log("Error:", r.body);
  }
})();
