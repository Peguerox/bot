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
