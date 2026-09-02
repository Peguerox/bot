import crypto from "crypto";

const BASE = "https://api.binance.com/api/v3";

function sign(payload: string): string {
  return crypto
    .createHmac("sha256", process.env.BINANCE_GLOBAL_SECRET!)
    .update(payload)
    .digest("hex");
}

async function signedPost(path: string, params: Record<string, string | number>) {
  const body = new URLSearchParams(
    Object.entries({ ...params, timestamp: Date.now() }).map(([k, v]) => [k, String(v)])
  );
  body.append("signature", sign(body.toString()));
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "X-MBX-APIKEY": process.env.BINANCE_GLOBAL_KEY!,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Binance POST ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function signedDelete(path: string, params: Record<string, string | number>) {
  const qs = new URLSearchParams(
    Object.entries({ ...params, timestamp: Date.now() }).map(([k, v]) => [k, String(v)])
  );
  qs.append("signature", sign(qs.toString()));
  const res = await fetch(`${BASE}${path}?${qs}`, {
    method: "DELETE",
    headers: { "X-MBX-APIKEY": process.env.BINANCE_GLOBAL_KEY! },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Binance DELETE ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function signedGet(path: string, params: Record<string, string | number>) {
  const qs = new URLSearchParams(
    Object.entries({ ...params, timestamp: Date.now() }).map(([k, v]) => [k, String(v)])
  );
  qs.append("signature", sign(qs.toString()));
  const res = await fetch(`${BASE}${path}?${qs}`, {
    headers: { "X-MBX-APIKEY": process.env.BINANCE_GLOBAL_KEY! },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Binance GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

export type OrderStatus = "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "EXPIRED";

export type OrderResponse = {
  orderId:             number;
  status:              OrderStatus;
  executedQty:         string;
  origQty:             string;
  price:               string;
  cummulativeQuoteQty: string;
};

export type OCOResponse = {
  orderListId:  number;
  orderReports: { orderId: number; type: string; side: string }[];
};

// XRP: price 4dp (tick 0.0001), qty 1dp (step 0.1), MIN_NOTIONAL 5 FDUSD
function xrpQty(q: number)   { return (Math.floor(q * 10) / 10).toFixed(1); }
function xrpPrice(p: number) { return p.toFixed(4); }

export async function placeLimitBuyXrp(symbol: string, qty: number, price: number): Promise<OrderResponse> {
  return signedPost("/order", {
    symbol,
    side:        "BUY",
    type:        "LIMIT",
    timeInForce: "GTC",
    quantity:    xrpQty(qty),
    price:       xrpPrice(price),
  });
}

export async function placeLimitSellXrp(symbol: string, qty: number, price: number): Promise<OrderResponse> {
  return signedPost("/order", {
    symbol,
    side:        "SELL",
    type:        "LIMIT",
    timeInForce: "GTC",
    quantity:    xrpQty(qty),
    price:       xrpPrice(price),
  });
}

export async function placeMarketSellXrp(symbol: string, qty: number): Promise<OrderResponse> {
  return signedPost("/order", {
    symbol,
    side:     "SELL",
    type:     "MARKET",
    quantity: xrpQty(qty),
  });
}

export async function placeOcoSellXrp(
  symbol: string, qty: number,
  tpPrice: number, slStopPrice: number, slLimitPrice: number,
): Promise<OCOResponse> {
  return signedPost("/order/oco", {
    symbol,
    side:                 "SELL",
    quantity:             xrpQty(qty),
    price:                xrpPrice(tpPrice),
    stopPrice:            xrpPrice(slStopPrice),
    stopLimitPrice:       xrpPrice(slLimitPrice),
    stopLimitTimeInForce: "GTC",
  });
}

export async function cancelOrderGlobal(symbol: string, orderId: number) {
  return signedDelete("/order", { symbol, orderId });
}

export async function cancelAllOrdersGlobal(symbol: string) {
  return signedDelete("/openOrders", { symbol });
}

export async function getOrderGlobal(symbol: string, orderId: number): Promise<OrderResponse> {
  return signedGet("/order", { symbol, orderId });
}

export async function getFreeBalanceGlobal(asset: string): Promise<number> {
  const account = await signedGet("/account", {});
  const balance = account.balances.find((b: { asset: string }) => b.asset === asset);
  return balance ? parseFloat(balance.free) : 0;
}

// Real incident 2026-09-01: bot PnL tracking used the order's cummulativeQuoteQty directly as
// "USD out" — but that's the GROSS proceeds before commission, not what actually lands in the
// account. Every SELL fill on these bots has come back as taker (0.1% fee), silently
// overstating every trade's real result by the fee amount. This fetches the actual fills for an
// order and nets out whatever commission was actually charged in the quote asset, so tracked
// PnL matches what really happened to the balance, not an idealized number.
export async function getNetSellProceeds(
  symbol: string, orderId: number, quoteAsset: string, grossQuoteQty: number,
): Promise<{ netProceeds: number; feeInQuoteAsset: number; feeInOtherAsset: number }> {
  const fills: { commission: string; commissionAsset: string }[] = await signedGet("/myTrades", { symbol, orderId });
  let feeInQuoteAsset = 0;
  let feeInOtherAsset = 0;
  for (const f of fills) {
    const amt = parseFloat(f.commission);
    if (f.commissionAsset === quoteAsset) feeInQuoteAsset += amt;
    else feeInOtherAsset += amt; // e.g. paid in BNB — doesn't reduce the quote-asset proceeds directly
  }
  return { netProceeds: grossQuoteQty - feeInQuoteAsset, feeInQuoteAsset, feeInOtherAsset };
}

export async function getKlinesGlobal(symbol: string, interval: string, limit: number) {
  const url = `${BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Binance global klines error: ${res.status}`);
  const raw = await res.json();
  return raw.map((c: string[]) => ({
    time:   Number(c[0]),
    open:   parseFloat(c[1]),
    high:   parseFloat(c[2]),
    low:    parseFloat(c[3]),
    close:  parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

export async function getPriceGlobal(symbol: string): Promise<number> {
  const res = await fetch(`${BASE}/ticker/price?symbol=${symbol}`, { cache: "no-store" });
  const data = await res.json();
  return parseFloat(data.price);
}

export async function getBookTickerGlobal(symbol: string): Promise<{ bid: number; ask: number; bidQty: number; askQty: number }> {
  const res = await fetch(`${BASE}/ticker/bookTicker?symbol=${symbol}`, { cache: "no-store" });
  const data = await res.json();
  const ask = parseFloat(data.askPrice);
  if (!res.ok || isNaN(ask)) throw new Error(`getBookTickerGlobal failed: ${JSON.stringify(data)}`);
  return { bid: parseFloat(data.bidPrice), ask, bidQty: parseFloat(data.bidQty), askQty: parseFloat(data.askQty) };
}

// SOLFDUSD: price 2dp (tick 0.01), qty 3dp (step 0.001), MIN_NOTIONAL 5 FDUSD
function solQty(q: number)   { return (Math.floor(q * 1000) / 1000).toFixed(3); }
function solPrice(p: number) { return p.toFixed(2); }

export async function placeLimitMakerBuySol(symbol: string, qty: number, price: number): Promise<OrderResponse> {
  return signedPost("/order", {
    symbol,
    side:     "BUY",
    type:     "LIMIT_MAKER",
    quantity: solQty(qty),
    price:    solPrice(price),
  });
}

// Structurally maker-only sell (Binance rejects outright rather than letting it cross the book).
// Used to chase a stuck stop down toward the market as an active resting order instead of a
// dormant trigger — see the "chase down as maker" phantom-stop handling in live-bot-sol-trail.ts.
export async function placeLimitMakerSellSol(symbol: string, qty: number, price: number): Promise<OrderResponse> {
  return signedPost("/order", {
    symbol,
    side:     "SELL",
    type:     "LIMIT_MAKER",
    quantity: solQty(qty),
    price:    solPrice(price),
  });
}

export async function placeStopLimitSellSol(
  symbol: string, qty: number, stopPrice: number, limitPrice: number,
): Promise<OrderResponse> {
  return signedPost("/order", {
    symbol,
    side:        "SELL",
    type:        "STOP_LOSS_LIMIT",
    timeInForce: "GTC",
    quantity:    solQty(qty),
    stopPrice:   solPrice(stopPrice),
    price:       solPrice(limitPrice),
  });
}

export async function placeMarketSellSol(symbol: string, qty: number): Promise<OrderResponse> {
  return signedPost("/order", {
    symbol,
    side:     "SELL",
    type:     "MARKET",
    quantity: solQty(qty),
  });
}

export async function placeOcoSellSol(
  symbol: string, qty: number,
  tpPrice: number, slStopPrice: number, slLimitPrice: number,
): Promise<OCOResponse> {
  return signedPost("/order/oco", {
    symbol,
    side:                 "SELL",
    quantity:             solQty(qty),
    price:                solPrice(tpPrice),
    stopPrice:            solPrice(slStopPrice),
    stopLimitPrice:       solPrice(slLimitPrice),
    stopLimitTimeInForce: "GTC",
  });
}
