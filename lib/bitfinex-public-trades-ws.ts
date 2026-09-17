// Public trade-tape WebSocket for a single Bitfinex symbol -- the real-time analog of the
// research CSVs' per-execution rows (trade_id, timestamp_ms, amount, price). Used to drive the
// SOL/BTC "size confirmation" live engine (lib/solbtc-sizeconf-engine.ts), which needs individual
// executions grouped into same-millisecond batches, not periodic candle polling.
//
// Bitfinex trades channel: subscribe -> snapshot [chanId, [[ID,MTS,AMOUNT,PRICE], ...]], then a
// live stream of [chanId, "te", [ID,MTS,AMOUNT,PRICE]] (trade executed -- fastest signal) followed
// shortly after by [chanId, "tu", [ID,MTS,AMOUNT,PRICE]] (trade updated/confirmed, same ID). Only
// "te" is consumed here -- "tu" would double-count the same execution. Verified against
// https://docs.bitfinex.com/reference/ws-public-trades on 2026-09-17.
import WebSocket from "ws";

export type Tick = { id: number; tsMs: number; amount: number; price: number };

let ws: WebSocket | null = null;
let chanId: number | null = null;
let lastMessageTime = Date.now();
const seenIds = new Set<number>(); // guards against a rare duplicate "te" redelivery after reconnect
let seenIdsOrder: number[] = [];

function rememberId(id: number) {
  seenIds.add(id);
  seenIdsOrder.push(id);
  if (seenIdsOrder.length > 5000) {
    const old = seenIdsOrder.shift()!;
    seenIds.delete(old);
  }
}

export function tradesMessageAge(): number { return Date.now() - lastMessageTime; }

export function connectPublicTrades(symbol: string, onTick: (t: Tick) => void): WebSocket {
  const sock = new WebSocket("wss://api-pub.bitfinex.com/ws/2");
  ws = sock;

  sock.on("open", () => {
    console.log(`Trades WS connected, subscribing to ${symbol}...`);
    sock.send(JSON.stringify({ event: "subscribe", channel: "trades", symbol }));
  });

  sock.on("message", (raw: Buffer) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "subscribed" && msg.channel === "trades") {
      chanId = msg.chanId;
      console.log(`Trades WS subscribed, chanId=${chanId}`);
      return;
    }
    if (!Array.isArray(msg) || msg[0] !== chanId || msg[1] === "hb") return;
    lastMessageTime = Date.now();

    // snapshot: [chanId, [[ID,MTS,AMOUNT,PRICE], ...]] -- seed dedup set only, don't replay
    // historical ticks through the live engine (they'd be stale by the time we're subscribed).
    if (Array.isArray(msg[1])) {
      for (const row of msg[1]) rememberId(row[0]);
      return;
    }
    if (msg[1] !== "te") return; // skip "tu" (duplicate confirmation of an already-seen "te")

    const [id, mts, amount, price] = msg[2];
    if (seenIds.has(id)) return;
    rememberId(id);
    onTick({ id, tsMs: mts, amount, price });
  });

  sock.on("error", (err) => console.error("Trades WS error:", err));
  sock.on("close", () => {
    console.log("Trades WS closed, reconnecting in 2s...");
    chanId = null;
    setTimeout(() => connectPublicTrades(symbol, onTick), 2000);
  });

  return sock;
}
