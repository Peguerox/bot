// Authenticated Bitfinex REST client (HMAC-SHA384 signing) — real order submission and account
// reads. Separate from lib/bitfinex.ts (public-data-only, no key needed).
import crypto from "crypto";

function signedHeaders(path: string, body: object): Record<string, string> {
  const apiKey = process.env.BITFINEX_API_KEY!;
  const apiSecret = process.env.BITFINEX_API_SECRET!;
  const nonce = (Date.now() * 1000).toString();
  const bodyStr = JSON.stringify(body);
  const signaturePayload = `/api/v2/${path}${nonce}${bodyStr}`;
  const signature = crypto.createHmac("sha384", apiSecret).update(signaturePayload).digest("hex");
  return {
    "Content-Type": "application/json",
    "bfx-nonce": nonce,
    "bfx-apikey": apiKey,
    "bfx-signature": signature,
  };
}

async function bitfinexAuthPost(path: string, body: object = {}): Promise<any> {
  const res = await fetch(`https://api.bitfinex.com/v2/${path}`, {
    method: "POST",
    headers: signedHeaders(path, body),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Bitfinex auth ${path} error: ${res.status}`);
  return res.json();
}

export type OrderFill = { orderId: number; execPrice: number; execAmount: number; fee: number };

// Submits an EXCHANGE MARKET order and polls trade history for the fill. Throws if no fill
// appears within the timeout — market orders on a liquid pair like tSOLUSD should fill in well
// under a second, so a few retries at 500ms is generous, not tight.
export async function submitMarketOrder(symbol: string, amount: number): Promise<OrderFill> {
  const submitRes = await bitfinexAuthPost("auth/w/order/submit", {
    type: "EXCHANGE MARKET", symbol, amount: amount.toString(),
  });
  if (submitRes[6] !== "SUCCESS") throw new Error(`Order submit failed: ${JSON.stringify(submitRes)}`);
  const orderId: number = submitRes[4][0][0];

  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((r) => setTimeout(r, 500));
    const trades = await bitfinexAuthPost(`auth/r/trades/${symbol}/hist`, { limit: 10 });
    const matches = trades.filter((t: any[]) => t[3] === orderId);
    if (matches.length > 0) {
      const totalAmount = matches.reduce((s: number, t: any[]) => s + t[4], 0);
      const totalFee = matches.reduce((s: number, t: any[]) => s + t[9], 0);
      const weightedPrice = matches.reduce((s: number, t: any[]) => s + t[4] * t[5], 0) / totalAmount;
      return { orderId, execPrice: weightedPrice, execAmount: totalAmount, fee: totalFee };
    }
  }
  throw new Error(`Order ${orderId} submitted but no fill found after 5s — check Bitfinex manually`);
}

export async function getWalletBalance(currency: string): Promise<number> {
  const wallets = await bitfinexAuthPost("auth/r/wallets");
  const wallet = wallets.find((w: any[]) => w[0] === "exchange" && w[1] === currency);
  return wallet ? wallet[2] : 0;
}
