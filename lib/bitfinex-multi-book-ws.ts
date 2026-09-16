// Multi-symbol-safe public order-book WS tracker for Bitfinex — separate from
// lib/bitfinex-trading-ws.ts on purpose. That file's connectPublicBook() uses single
// module-level globals (one bookLevels map, one chanId) which only works correctly for ONE
// symbol per process. Worker 2 (Hypertrade) already depends on that exact behavior for real
// money, so rather than risk regressing it, this is a fresh implementation that keys book state
// by Bitfinex's channel id, letting one WS connection track multiple symbols' order books at
// once (SOLUSD + SOLBTC) for the Surfer-on-Bitfinex worker.
//
// The authenticated side (wallet balances, order submission, fill detection) is NOT duplicated
// here — lib/bitfinex-trading-ws.ts's connectAuthenticated/getLiveBalance/submitMarketOrderFast
// are already symbol-agnostic (keyed by currency and by per-order CID, not by a single global
// symbol), so both Surfer bots share that existing, proven authenticated connection directly.
import WebSocket from "ws";

type BookLevel = { count: number; amount: number };

type SymbolBook = {
  levels: Map<number, BookLevel>;
  ready: boolean;
  lastMessageTime: number;
};

const booksBySymbol = new Map<string, SymbolBook>();
const chanIdToSymbol = new Map<number, string>();
let ws: WebSocket | null = null;
let subscribedSymbols: string[] = [];

function applyRow(book: SymbolBook, row: [number, number, number]) {
  const [price, count, amount] = row;
  if (count === 0) book.levels.delete(price);
  else book.levels.set(price, { count, amount });
}

function bestBid(book: SymbolBook): number | null {
  let best: number | null = null;
  for (const [price, lvl] of book.levels) if (lvl.amount > 0 && (best === null || price > best)) best = price;
  return best;
}
function bestAsk(book: SymbolBook): number | null {
  let best: number | null = null;
  for (const [price, lvl] of book.levels) if (lvl.amount < 0 && (best === null || price < best)) best = price;
  return best;
}

export function getBookBidAsk(symbol: string): { bid: number | null; ask: number | null } {
  const book = booksBySymbol.get(symbol);
  if (!book) return { bid: null, ask: null };
  return { bid: bestBid(book), ask: bestAsk(book) };
}
export function isBookReady(symbol: string): boolean {
  return booksBySymbol.get(symbol)?.ready ?? false;
}
export function bookMessageAge(symbol: string): number {
  const book = booksBySymbol.get(symbol);
  return book ? Date.now() - book.lastMessageTime : Infinity;
}

// Connects once and subscribes to every symbol in the list on the same socket. onUpdate fires
// with the symbol that just changed, so a caller running multiple independent bot loops in one
// process can dispatch to the right one.
export function connectMultiSymbolBook(symbols: string[], onUpdate: (symbol: string) => void): WebSocket {
  subscribedSymbols = symbols;
  for (const s of symbols) {
    if (!booksBySymbol.has(s)) booksBySymbol.set(s, { levels: new Map(), ready: false, lastMessageTime: Date.now() });
  }

  const sock = new WebSocket("wss://api-pub.bitfinex.com/ws/2");
  ws = sock;

  sock.on("open", () => {
    console.log(`Multi-symbol book WS connected, subscribing to: ${symbols.join(", ")}`);
    for (const s of symbols) {
      sock.send(JSON.stringify({ event: "subscribe", channel: "book", symbol: s, prec: "P0", freq: "F0", len: "25" }));
    }
  });

  sock.on("message", (raw: Buffer) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "subscribed" && msg.channel === "book") {
      chanIdToSymbol.set(msg.chanId, msg.symbol);
      const book = booksBySymbol.get(msg.symbol);
      if (book) { book.levels.clear(); book.ready = false; }
      return;
    }
    if (!Array.isArray(msg) || msg[1] === "hb") return;
    const symbol = chanIdToSymbol.get(msg[0]);
    if (!symbol) return;
    const book = booksBySymbol.get(symbol);
    if (!book) return;

    book.lastMessageTime = Date.now();
    const data = msg[1];
    if (Array.isArray(data[0])) {
      book.levels.clear();
      for (const row of data) applyRow(book, row);
      book.ready = true;
    } else {
      applyRow(book, data);
    }
    onUpdate(symbol);
  });

  sock.on("error", (err) => console.error("Multi-symbol book WS error:", err));
  sock.on("close", () => {
    console.log("Multi-symbol book WS closed, reconnecting in 2s...");
    for (const book of booksBySymbol.values()) book.ready = false;
    chanIdToSymbol.clear();
    setTimeout(() => connectMultiSymbolBook(subscribedSymbols, onUpdate), 2000);
  });

  return sock;
}
