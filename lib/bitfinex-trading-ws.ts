// Real-time trading infra over persistent WebSockets, replacing REST-based order submission +
// polling and the throttled public `ticker` channel. Built 2026-09-06 after a real trade audit
// found meaningful slippage (SOL: -0.293% vs a -0.1% intended stop) traced to the old path:
// submitMarketOrder() did a fresh REST POST per order, then polled REST trade-history every 500ms
// (up to 5s worst case) just to learn the fill price. Every millisecond in that gap is real money
// during a fast move.
//
// New path:
//  - Public `book` channel (not `ticker`) for best bid/ask -- book updates on every real order-
//    book change; `ticker` is a throttled snapshot. Verified against current Bitfinex docs.
//  - Authenticated channel, filter=["wallet","trading"] -- same connection now carries wallet
//    balance updates AND order/trade events, so orders submit and confirm over one already-open,
//    already-authenticated socket instead of a fresh HTTPS request per order.
//  - Orders submitted via the `on` (order-new) WS op with a locally-generated CID; fills detected
//    via the `te` (trade-executed) event, matched back to the pending order by CID (te carries CID
//    at index 11) -- this is the fastest possible fill signal Bitfinex sends, pushed the instant
//    the exchange executes, no polling.
// Message formats verified against https://docs.bitfinex.com/reference (ws-auth-input-order-new,
// ws-auth-trades, ws-public-books) on 2026-09-06.
import WebSocket from "ws";
import crypto from "crypto";
import { submitMarketOrder as submitMarketOrderRest } from "./bitfinex-auth";

// ---------- Public order book (best bid/ask) ----------

type BookLevel = { count: number; amount: number };
const bookLevels = new Map<number, BookLevel>();
let bookReady = false;
let bookWs: WebSocket | null = null;
let bookChanId: number | null = null;
let lastBookMessageTime = Date.now();

function applyBookRow(row: [number, number, number]) {
  const [price, count, amount] = row;
  if (count === 0) bookLevels.delete(price);
  else bookLevels.set(price, { count, amount });
}

function bestBid(): number | null {
  let best: number | null = null;
  for (const [price, lvl] of bookLevels) if (lvl.amount > 0 && (best === null || price > best)) best = price;
  return best;
}
function bestAsk(): number | null {
  let best: number | null = null;
  for (const [price, lvl] of bookLevels) if (lvl.amount < 0 && (best === null || price < best)) best = price;
  return best;
}

export function getBookBidAsk(): { bid: number | null; ask: number | null } {
  return { bid: bestBid(), ask: bestAsk() };
}
export function isBookReady(): boolean { return bookReady; }
export function bookMessageAge(): number { return Date.now() - lastBookMessageTime; }

export function connectPublicBook(symbol: string, onUpdate?: () => void): WebSocket {
  const ws = new WebSocket("wss://api-pub.bitfinex.com/ws/2");
  bookWs = ws;

  ws.on("open", () => {
    console.log(`Book WS connected, subscribing to order book (real bid/ask) for ${symbol}...`);
    ws.send(JSON.stringify({ event: "subscribe", channel: "book", symbol, prec: "P0", freq: "F0", len: "25" }));
  });

  ws.on("message", (raw: Buffer) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.event === "subscribed" && msg.channel === "book") {
      bookChanId = msg.chanId; bookLevels.clear(); bookReady = false;
      return;
    }
    if (!Array.isArray(msg) || msg[0] !== bookChanId || msg[1] === "hb") return;
    lastBookMessageTime = Date.now();
    const data = msg[1];
    if (Array.isArray(data[0])) {
      bookLevels.clear();
      for (const row of data) applyBookRow(row);
      bookReady = true;
    } else {
      applyBookRow(data);
    }
    onUpdate?.();
  });

  ws.on("error", (err) => console.error("Book WS error:", err));
  ws.on("close", () => {
    console.log("Book WS closed, reconnecting in 2s...");
    bookReady = false;
    setTimeout(() => connectPublicBook(symbol, onUpdate), 2000);
  });
  return ws;
}

// ---------- Authenticated: wallet balances + order submission + fill detection ----------

const walletBalances = new Map<string, number>();
let authWs: WebSocket | null = null;
let authReady = false;
let readyCallbacks: (() => void)[] = [];
let lastAuthMessageTime = Date.now();

export type OrderFill = { orderId: number; execPrice: number; execAmount: number; fee: number; latencyMs: number };

type PendingOrder = { resolve: (fill: OrderFill) => void; reject: (err: Error) => void; submitTime: number; timeout: NodeJS.Timeout };
const pendingOrders = new Map<number, PendingOrder>(); // keyed by CID

function authSig(nonce: string): string {
  const apiSecret = process.env.BITFINEX_API_SECRET!;
  return crypto.createHmac("sha384", apiSecret).update(`AUTH${nonce}`).digest("hex");
}

export function connectAuthenticated(): WebSocket {
  const ws = new WebSocket("wss://api.bitfinex.com/ws/2");
  authWs = ws;

  ws.on("open", () => {
    const apiKey = process.env.BITFINEX_API_KEY!;
    const nonce = Date.now().toString();
    ws.send(JSON.stringify({
      apiKey, authSig: authSig(nonce), authNonce: nonce, authPayload: `AUTH${nonce}`,
      event: "auth", filter: ["wallet", "trading"],
    }));
  });

  ws.on("message", (raw: Buffer) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "auth") {
      if (msg.status !== "OK") console.error("Auth WS auth FAILED:", JSON.stringify(msg));
      else console.log("Auth WS authenticated (wallet + trading), waiting for snapshot...");
      return;
    }
    if (!Array.isArray(msg) || msg[1] === "hb") return;
    lastAuthMessageTime = Date.now();
    const type = msg[1];

    if (type === "ws") {
      for (const w of msg[2]) if (w[0] === "exchange") walletBalances.set(w[1], w[4] ?? w[2]);
      console.log("Wallet snapshot loaded:", JSON.stringify(Object.fromEntries(walletBalances)));
      if (!authReady) { authReady = true; readyCallbacks.forEach((cb) => cb()); readyCallbacks = []; }
    } else if (type === "wu") {
      const w = msg[2];
      if (w[0] === "exchange") walletBalances.set(w[1], w[4] ?? w[2]);
    } else if (type === "te") {
      // trade executed -- fastest fill signal; te carries [ID,SYMBOL,MTS,ORDER_ID,EXEC_AMOUNT,
      // EXEC_PRICE,ORDER_TYPE,ORDER_PRICE,MAKER,FEE,FEE_CURRENCY,CID]
      const t = msg[2];
      const cid = t[11];
      const pending = pendingOrders.get(cid);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingOrders.delete(cid);
        pending.resolve({ orderId: t[3], execPrice: t[5], execAmount: t[4], fee: t[9] ?? 0, latencyMs: Date.now() - pending.submitTime });
      }
    } else if (type === "n") {
      // notification -- catches submit-time errors (insufficient balance, invalid params, etc).
      // notify array: [MTS, TYPE, MSG_ID, null, ORDER_ARRAY, CODE, STATUS, TEXT]; ORDER_ARRAY[2]=CID
      const n = msg[2];
      if (n[1] === "on-req" && n[6] === "ERROR") {
        const orderArr = n[4];
        const cid = orderArr?.[2];
        const pending = cid != null ? pendingOrders.get(cid) : undefined;
        if (pending) {
          clearTimeout(pending.timeout);
          pendingOrders.delete(cid);
          pending.reject(new Error(`Order rejected: ${n[7]}`));
        }
      }
    }
  });

  ws.on("error", (err) => console.error("Auth WS error:", err));
  ws.on("close", () => {
    console.log("Auth WS closed, reconnecting in 2s...");
    authReady = false;
    setTimeout(connectAuthenticated, 2000);
  });
  return ws;
}

export function getLiveBalance(currency: string): number { return walletBalances.get(currency) ?? 0; }
export function isWalletReady(): boolean { return authReady; }
export function onWalletReady(cb: () => void) { if (authReady) cb(); else readyCallbacks.push(cb); }
export function authMessageAge(): number { return Date.now() - lastAuthMessageTime; }

let cidCounter = 0;

// Submits an EXCHANGE MARKET order over the already-open authenticated WS and resolves the moment
// the `te` fill event arrives (matched by CID) -- no REST round trip, no polling. Rejects if
// Bitfinex sends an explicit error, or after timeoutMs with nothing back (caller's REST fallback,
// submitMarketOrderSafe, should be used as the last-resort path on that rejection).
export function submitMarketOrderWs(symbol: string, amount: number, timeoutMs = 3000): Promise<OrderFill> {
  return new Promise((resolve, reject) => {
    if (!authWs || authWs.readyState !== WebSocket.OPEN) { reject(new Error("Auth WS not connected")); return; }
    const cid = Date.now() * 1000 + (cidCounter++ % 1000);
    const submitTime = Date.now();
    const timeout = setTimeout(() => {
      pendingOrders.delete(cid);
      reject(new Error(`Order (cid=${cid}) submitted over WS but no fill/error within ${timeoutMs}ms`));
    }, timeoutMs);
    pendingOrders.set(cid, { resolve, reject, submitTime, timeout });
    authWs.send(JSON.stringify([0, "on", null, { cid, type: "EXCHANGE MARKET", symbol, amount: amount.toString() }]));
  });
}

// Tries the fast WS path first; falls back to the proven REST path (submitMarketOrder) if the WS
// path isn't ready, times out, or errors -- real money always gets an order placed one way or the
// other, the WS path is a speed optimization on top, not a single point of failure.
export async function submitMarketOrderFast(symbol: string, amount: number): Promise<OrderFill> {
  const submitTime = Date.now();
  try {
    return await submitMarketOrderWs(symbol, amount);
  } catch (err) {
    console.error(`WS order submission failed (${String(err)}) — falling back to REST...`);
    const fill = await submitMarketOrderRest(symbol, amount);
    return { ...fill, latencyMs: Date.now() - submitTime };
  }
}
