import crypto from "crypto";

const BASE = "https://api.binance.us/api/v3";

// ── Signed request helpers (live bot order placement) ─────────────────────────

function sign(payload: string): string {
  return crypto
    .createHmac("sha256", process.env.BINANCE_API_SECRET!)
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
      "X-MBX-APIKEY": process.env.BINANCE_API_KEY!,
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
    headers: { "X-MBX-APIKEY": process.env.BINANCE_API_KEY! },
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
    headers: { "X-MBX-APIKEY": process.env.BINANCE_API_KEY! },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Binance GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Order functions ───────────────────────────────────────────────────────────

export async function placeLimitBuy(symbol: string, qty: number, price: number): Promise<OrderResponse> {
  return signedPost("/order", {
    symbol,
    side:        "BUY",
    type:        "LIMIT",
    timeInForce: "GTC",
    quantity:    qty.toFixed(2),
    price:       price.toFixed(4),
  });
}

export async function placeLimitSell(symbol: string, qty: number, price: number): Promise<OrderResponse> {
  return signedPost("/order", {
    symbol,
    side:        "SELL",
    type:        "LIMIT",
    timeInForce: "GTC",
    quantity:    qty.toFixed(2),
    price:       price.toFixed(4),
  });
}

// TP = limit sell above market; SL = stop-limit sell below market
export async function placeOCO(
  symbol: string, qty: number,
  tpPrice: number, slStopPrice: number, slLimitPrice: number
): Promise<OCOResponse> {
  return signedPost("/order/oco", {
    symbol,
    side:                  "SELL",
    quantity:              qty.toFixed(2),
    price:                 tpPrice.toFixed(4),
    stopPrice:             slStopPrice.toFixed(4),
    stopLimitPrice:        slLimitPrice.toFixed(4),
    stopLimitTimeInForce:  "GTC",
  });
}

export async function cancelOrder(symbol: string, orderId: number) {
  return signedDelete("/order", { symbol, orderId });
}

export async function cancelOCO(symbol: string, orderListId: number) {
  return signedDelete("/orderList", { symbol, orderListId });
}

export async function getOrder(symbol: string, orderId: number): Promise<OrderResponse> {
  return signedGet("/order", { symbol, orderId });
}

// Cancel ALL open orders for a symbol at once
export async function cancelAllOrders(symbol: string) {
  return signedDelete("/openOrders", { symbol });
}

export async function getFreeBalance(asset: string): Promise<number> {
  const account = await signedGet("/account", {});
  const balance = account.balances.find((b: { asset: string }) => b.asset === asset);
  return balance ? parseFloat(balance.free) : 0;
}

// ── Public endpoints ──────────────────────────────────────────────────────────

export async function getKlines(symbol: string, interval: string, limit: number) {
  const url = `${BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, {
    headers: { "X-MBX-APIKEY": process.env.BINANCE_API_KEY! },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
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

export async function getPrice(symbol: string): Promise<number> {
  const res = await fetch(`${BASE}/ticker/price?symbol=${symbol}`, {
    cache: "no-store",
  });
  const data = await res.json();
  return parseFloat(data.price);
}
