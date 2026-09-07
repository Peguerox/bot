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

// FIX 2026-09-03: fetch() had no timeout — a hung request (network blip, Bitfinex slow to
// respond) would never resolve or reject, leaving the live bot's orderInFlight flag stuck true
// forever and freezing all further price reaction indefinitely. Found after two real positions
// sat unmanaged with zero ticks recorded, while the paper bot (never calls this function, no
// real orders) never showed the same issue on the identical WS feed. A bounded timeout ensures
// a hang fails fast and lets the existing error handling (logs ERROR, resets orderInFlight) run
// instead of hanging silently forever.
async function bitfinexAuthPost(path: string, body: object = {}): Promise<any> {
  const res = await fetch(`https://api.bitfinex.com/v2/${path}`, {
    method: "POST",
    headers: signedHeaders(path, body),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // FIX 2026-09-04: error used to just say "error: 500" with no reason, which made it
    // impossible for callers to tell "insufficient balance" apart from any other failure —
    // needed for the shared-wallet retry logic in submitMarketOrderSafe below.
    const text = await res.text().catch(() => "");
    throw new Error(`Bitfinex auth ${path} error: ${res.status} ${text}`);
  }
  return res.json();
}

export type OrderFill = { orderId: number; execPrice: number; execAmount: number; fee: number };

// Polls trade history for an order that ALREADY EXISTS (known orderId) and aggregates every
// matching partial fill into one weighted-average result. Submits nothing -- safe to call after
// a WS order times out with a known orderId, to find out what actually happened without risking
// a double-execution from submitting a brand new order on top of one that may have partially or
// fully filled already.
export async function lookupOrderFill(symbol: string, orderId: number, attempts = 10, delayMs = 500): Promise<OrderFill> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise((r) => setTimeout(r, delayMs));
    const trades = await bitfinexAuthPost(`auth/r/trades/${symbol}/hist`, { limit: 25 });
    const matches = trades.filter((t: any[]) => t[3] === orderId);
    if (matches.length > 0) {
      const totalAmount = matches.reduce((s: number, t: any[]) => s + t[4], 0);
      const totalFee = matches.reduce((s: number, t: any[]) => s + t[9], 0);
      const weightedPrice = matches.reduce((s: number, t: any[]) => s + t[4] * t[5], 0) / totalAmount;
      return { orderId, execPrice: weightedPrice, execAmount: totalAmount, fee: totalFee };
    }
  }
  throw new Error(`Order ${orderId} has no fills found after ${(attempts * delayMs / 1000).toFixed(1)}s — check Bitfinex manually`);
}

// Submits an EXCHANGE MARKET order and polls trade history for the fill. Throws if no fill
// appears within the timeout — market orders on a liquid pair like tSOLUSD should fill in well
// under a second, so a few retries at 500ms is generous, not tight.
export async function submitMarketOrder(symbol: string, amount: number): Promise<OrderFill> {
  const submitRes = await bitfinexAuthPost("auth/w/order/submit", {
    type: "EXCHANGE MARKET", symbol, amount: amount.toString(),
  });
  if (submitRes[6] !== "SUCCESS") throw new Error(`Order submit failed: ${JSON.stringify(submitRes)}`);
  const orderId: number = submitRes[4][0][0];
  return lookupOrderFill(symbol, orderId);
}

export async function getWalletBalance(currency: string): Promise<number> {
  const wallets = await bitfinexAuthPost("auth/r/wallets");
  const wallet = wallets.find((w: any[]) => w[0] === "exchange" && w[1] === currency);
  return wallet ? wallet[2] : 0;
}

// SHARED-WALLET FIX 2026-09-04: multiple live bots can trade the same asset on the same real
// account concurrently (intentional). Each bot's own internal quantity tracking can drift from
// the real combined wallet balance because of normal fill-precision behavior on Bitfinex's side
// -- not a bug in either bot individually, just an unavoidable consequence of two independent
// trackers sharing one real pool. This caused a real incident: a sell kept failing with
// "not enough exchange balance" every 15s for 2+ minutes, retrying with the same wrong number
// forever. Fix: keep the hot path exactly as fast as before (no balance check on every trade --
// that would add real latency for no benefit in the ~99% of trades with no drift). Only on an
// actual "insufficient balance" failure, re-check the real balance and retry ONCE with the
// corrected amount -- self-heals in under a second instead of looping on stale data.
export async function submitMarketOrderSafe(
  symbol: string,
  amount: number,
  balanceCurrency: string,
  priceForConversion?: number, // required for buys (amount is in base currency, balance is in quote currency)
): Promise<OrderFill> {
  try {
    return await submitMarketOrder(symbol, amount);
  } catch (err) {
    const msg = String(err);
    if (!/insufficient|not enough exchange balance/i.test(msg)) throw err;

    console.error(`submitMarketOrder failed (${msg}) — re-checking real ${balanceCurrency} balance and retrying once...`);
    const realBalance = await getWalletBalance(balanceCurrency);

    let cappedAmount: number;
    if (amount > 0) {
      if (!priceForConversion) throw new Error("priceForConversion required for buy-side retry");
      cappedAmount = Math.min(amount, realBalance / priceForConversion);
    } else {
      cappedAmount = -Math.min(Math.abs(amount), realBalance);
    }

    if (Math.abs(cappedAmount) < 1e-8) {
      throw new Error(`No real ${balanceCurrency} balance available to retry (real balance: ${realBalance})`);
    }
    console.error(`Retrying with corrected amount: requested ${amount}, using ${cappedAmount} (real balance ${realBalance} ${balanceCurrency})`);
    return await submitMarketOrder(symbol, cappedAmount);
  }
}
