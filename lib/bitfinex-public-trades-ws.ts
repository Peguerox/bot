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
//
// Real bug found 2026-09-17 via the backtest comparison: any real trade that happened during a
// brief disconnect/reconnect was permanently lost, not just delayed -- the old code only used the
// reconnect snapshot to seed the dedup set (`rememberId`), it never fed those trades through
// `onTick`. That silently missing trade shifts the engine's accumulated pressure/response state
// away from what a continuous replay computes, which can make later real decisions (which real
// batch crosses the entry threshold, at what price) genuinely wrong -- confirmed against real
// Bitfinex data: a live entry fired at a worse price than a gapless backtest replay of the exact
// same window determined. Fixed by explicitly backfilling the gap via REST on every reconnect
// (including the very first connect has nothing to backfill, `lastDeliveredTsMs` starts null).
import WebSocket from "ws";
import { getBitfinexTradesRange } from "./bitfinex";

export type Tick = { id: number; tsMs: number; amount: number; price: number };

let ws: WebSocket | null = null;
let chanId: number | null = null;
let lastMessageTime = Date.now();
let lastDeliveredTsMs: number | null = null;
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

async function backfillGap(symbol: string, onTick: (t: Tick) => void) {
  if (lastDeliveredTsMs === null) return; // cold start -- nothing to backfill, matches documented limitation
  try {
    const gap = await getBitfinexTradesRange(symbol, lastDeliveredTsMs + 1, Date.now(), 5);
    let applied = 0;
    for (const t of gap) {
      if (seenIds.has(t.id)) continue;
      rememberId(t.id);
      lastDeliveredTsMs = Math.max(lastDeliveredTsMs!, t.tsMs);
      onTick({ id: t.id, tsMs: t.tsMs, amount: t.amount, price: t.price });
      applied++;
    }
    if (applied > 0) console.log(`Trades WS reconnect: backfilled ${applied} real trade(s) missed during the gap via REST`);
  } catch (err) {
    console.error("Trades WS reconnect backfill failed (gap may remain unfilled):", err);
  }
}

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
      backfillGap(symbol, onTick).catch((err) => console.error("backfillGap failed:", err));
      return;
    }
    if (!Array.isArray(msg) || msg[0] !== chanId || msg[1] === "hb") return;
    lastMessageTime = Date.now();

    // snapshot: [chanId, [[ID,MTS,AMOUNT,PRICE], ...]] -- seed dedup set only, don't replay
    // historical ticks through the live engine (they'd be stale by the time we're subscribed).
    // Any real gap is instead closed explicitly by backfillGap() above, which fires right after
    // "subscribed" and can reach further back than this snapshot's ~100-trade window.
    if (Array.isArray(msg[1])) {
      for (const row of msg[1]) rememberId(row[0]);
      return;
    }
    if (msg[1] !== "te") return; // skip "tu" (duplicate confirmation of an already-seen "te")

    const [id, mts, amount, price] = msg[2];
    if (seenIds.has(id)) return;
    rememberId(id);
    lastDeliveredTsMs = Math.max(lastDeliveredTsMs ?? 0, mts);
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
