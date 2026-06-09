import crypto from "crypto";

const BASE    = "https://api.binance.us/api/v3";
const BASE_GL = "https://api.binance.com/api/v3";

const API_KEY    = process.env.BINANCE_API_KEY_EU ?? process.env.BINANCE_API_KEY ?? "";
const API_SECRET = process.env.BINANCE_API_SECRET_EU ?? process.env.BINANCE_API_SECRET ?? "";

// ── Signed request helpers (live bot order placement) ─────────────────────────

function sign(payload: string): string {
  return crypto
    .createHmac("sha256", API_SECRET)
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
      "X-MBX-APIKEY": API_KEY,
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
    headers: { "X-MBX-APIKEY": API_KEY },
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
    headers: { "X-MBX-APIKEY": API_KEY },
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
    price:       price.toFixed(3),
  });
}

export async function placeLimitSell(symbol: string, qty: number, price: number): Promise<OrderResponse> {
  return signedPost("/order", {
    symbol,
    side:        "SELL",
    type:        "LIMIT",
    timeInForce: "GTC",
    quantity:    qty.toFixed(2),
    price:       price.toFixed(3),
  });
}

export async function placeMarketBuy(symbol: string, qty: number): Promise<OrderResponse> {
  return signedPost("/order", {
    symbol,
    side:     "BUY",
    type:     "MARKET",
    quantity: qty.toFixed(2),
  });
}

export async function placeMarketSell(symbol: string, qty: number): Promise<OrderResponse> {
  return signedPost("/order", {
    symbol,
    side:     "SELL",
    type:     "MARKET",
    quantity: qty.toFixed(2),
  });
}

export async function placeMarketSellXlm(symbol: string, qty: number): Promise<OrderResponse> {
  return signedPost("/order", {
    symbol,
    side:     "SELL",
    type:     "MARKET",
    quantity: Math.floor(qty).toString(),
  });
}

export async function placeStopMarket(symbol: string, qty: number, stopPrice: number): Promise<OrderResponse> {
  return signedPost("/order", {
    symbol,
    side:      "SELL",
    type:      "STOP_LOSS",
    quantity:  qty.toFixed(2),
    stopPrice: stopPrice.toFixed(3),
  });
}

export async function placeStopLimitSell(
  symbol: string, qty: number,
  stopPrice: number, limitPrice: number,
): Promise<OrderResponse> {
  return signedPost("/order", {
    symbol,
    side:        "SELL",
    type:        "STOP_LOSS_LIMIT",
    timeInForce: "GTC",
    quantity:    qty.toFixed(2),
    stopPrice:   stopPrice.toFixed(3),
    price:       limitPrice.toFixed(3),
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
    price:                 tpPrice.toFixed(3),
    stopPrice:             slStopPrice.toFixed(3),
    stopLimitPrice:        slLimitPrice.toFixed(3),
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

// XLM-specific: qty as whole number, price at 5 decimal places
export async function placeLimitBuyXlm(symbol: string, qty: number, price: number): Promise<OrderResponse> {
  return signedPost("/order", {
    symbol,
    side:        "BUY",
    type:        "LIMIT",
    timeInForce: "GTC",
    quantity:    Math.floor(qty).toString(),
    price:       price.toFixed(5),
  });
}

export async function placeLimitSellXlm(symbol: string, qty: number, price: number): Promise<OrderResponse> {
  return signedPost("/order", {
    symbol,
    side:        "SELL",
    type:        "LIMIT",
    timeInForce: "GTC",
    quantity:    Math.floor(qty).toString(),
    price:       price.toFixed(5),
  });
}

export async function placeStopLimitSellXlm(
  symbol: string, qty: number,
  stopPrice: number, limitPrice: number,
): Promise<OrderResponse> {
  return signedPost("/order", {
    symbol,
    side:        "SELL",
    type:        "STOP_LOSS_LIMIT",
    timeInForce: "GTC",
    quantity:    Math.floor(qty).toString(),
    stopPrice:   stopPrice.toFixed(5),
    price:       limitPrice.toFixed(5),
  });
}

// XLM OCO: TP limit sell + SL stop-limit sell in one linked order
export async function placeOcoSellXlm(
  symbol: string, qty: number,
  tpPrice: number, slStopPrice: number, slLimitPrice: number,
): Promise<OCOResponse> {
  return signedPost("/order/oco", {
    symbol,
    side:                 "SELL",
    quantity:             Math.floor(qty).toString(),
    price:                tpPrice.toFixed(5),
    stopPrice:            slStopPrice.toFixed(5),
    stopLimitPrice:       slLimitPrice.toFixed(5),
    stopLimitTimeInForce: "GTC",
  });
}

// BNB-specific: qty to 3 decimal places (step 0.001), price to 2 decimal places (tick 0.01)
export async function placeLimitBuyBnb(symbol: string, qty: number, price: number): Promise<OrderResponse> {
  return signedPost("/order", {
    symbol,
    side:        "BUY",
    type:        "LIMIT",
    timeInForce: "GTC",
    quantity:    (Math.floor(qty * 1000) / 1000).toFixed(3),
    price:       price.toFixed(2),
  });
}

export async function placeLimitSellBnb(symbol: string, qty: number, price: number): Promise<OrderResponse> {
  return signedPost("/order", {
    symbol,
    side:        "SELL",
    type:        "LIMIT",
    timeInForce: "GTC",
    quantity:    (Math.floor(qty * 1000) / 1000).toFixed(3),
    price:       price.toFixed(2),
  });
}

export async function placeMarketSellBnb(symbol: string, qty: number): Promise<OrderResponse> {
  return signedPost("/order", {
    symbol,
    side:     "SELL",
    type:     "MARKET",
    quantity: (Math.floor(qty * 1000) / 1000).toFixed(3),
  });
}

export async function placeStopLimitSellBnb(
  symbol: string, qty: number,
  stopPrice: number, limitPrice: number,
): Promise<OrderResponse> {
  return signedPost("/order", {
    symbol,
    side:        "SELL",
    type:        "STOP_LOSS_LIMIT",
    timeInForce: "GTC",
    quantity:    (Math.floor(qty * 1000) / 1000).toFixed(3),
    stopPrice:   stopPrice.toFixed(2),
    price:       limitPrice.toFixed(2),
  });
}

export async function placeOcoSellBnb(
  symbol: string, qty: number,
  tpPrice: number, slStopPrice: number, slLimitPrice: number,
): Promise<OCOResponse> {
  return signedPost("/order/oco", {
    symbol,
    side:                 "SELL",
    quantity:             (Math.floor(qty * 1000) / 1000).toFixed(3),
    price:                tpPrice.toFixed(2),
    stopPrice:            slStopPrice.toFixed(2),
    stopLimitPrice:       slLimitPrice.toFixed(2),
    stopLimitTimeInForce: "GTC",
  });
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
    headers: { "X-MBX-APIKEY": API_KEY },
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

export async function getKlinesGlobal(symbol: string, interval: string, limit: number) {
  const url = `${BASE_GL}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Binance global API error: ${res.status}`);
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
  const p = parseFloat(data.price);
  if (!res.ok || isNaN(p)) throw new Error(`getPrice failed: ${JSON.stringify(data)}`);
  return p;
}

export async function getPriceGlobal(symbol: string): Promise<number> {
  const res = await fetch(`${BASE_GL}/ticker/price?symbol=${symbol}`, { cache: "no-store" });
  const data = await res.json();
  const p = parseFloat(data.price);
  if (!res.ok || isNaN(p)) throw new Error(`getPriceGlobal failed: ${JSON.stringify(data)}`);
  return p;
}
