// Standalone always-on worker — CONVERTED 2026-09-03 from a trading bot into a pure research
// logger. No entry signal, no positions, no TP/SL. Just continuously records real order book
// volume (top 25 levels each side, bid vs ask) alongside price and the derived imbalance ratio,
// so the actual relationship between book depth and price movement can be inspected directly
// instead of guessing a threshold up front. Reuses the same lock/enabled state table as the old
// trading version (sol_jump_trail_bitfinex_state) purely for the single-instance lock and the
// dashboard's enable/disable toggle — mode/entry/trade fields on that table are unused now.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import WebSocket from "ws";
import os from "os";
import crypto from "crypto";
import {
  getSolJumpTrailBitfinexState, updateSolJumpTrailBitfinexState,
} from "../lib/sol-jump-trail-bitfinex-db";
import { recordBookVolume } from "../lib/sol-book-volume-log-db";

const BOOK_LEVELS       = 25;
const LOG_INTERVAL_MS   = 5_000; // throttle DB writes
const HEARTBEAT_MS      = 10_000;
const LOCK_STALE_MS     = 30_000;

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

type Level = { price: number; count: number; amount: number };
const bids = new Map<number, Level>();
const asks = new Map<number, Level>();

let state: { enabled: boolean; lock_owner: string | null; lock_heartbeat: string | null };
let lastLogAt = 0;
let bfxBid: number | null = null;
let bfxAsk: number | null = null;

async function acquireLock(): Promise<boolean> {
  state = await getSolJumpTrailBitfinexState();
  const heartbeatAge = state.lock_heartbeat ? Date.now() - new Date(state.lock_heartbeat).getTime() : Infinity;
  if (state.lock_owner && heartbeatAge < LOCK_STALE_MS) {
    console.error(`Refusing to start: lock held by ${state.lock_owner}, last heartbeat ${heartbeatAge}ms ago`);
    return false;
  }
  await updateSolJumpTrailBitfinexState({ lock_owner: INSTANCE_ID, lock_heartbeat: new Date().toISOString() });
  console.log(`Lock acquired as ${INSTANCE_ID}`);
  return true;
}

async function heartbeat() {
  const fresh = await getSolJumpTrailBitfinexState();
  if (fresh.lock_owner !== INSTANCE_ID) {
    console.error(`Lost lock to ${fresh.lock_owner} — another instance took over. Exiting.`);
    process.exit(1);
  }
  state.enabled = fresh.enabled;
  await updateSolJumpTrailBitfinexState({ lock_heartbeat: new Date().toISOString() });
}

async function releaseLock() {
  try {
    const fresh = await getSolJumpTrailBitfinexState();
    if (fresh.lock_owner === INSTANCE_ID) {
      await updateSolJumpTrailBitfinexState({ lock_owner: null, lock_heartbeat: null });
      console.log("Lock released cleanly.");
    }
  } catch (err) { console.error("releaseLock failed:", err); }
}

function topN(map: Map<number, Level>, n: number, desc: boolean): Level[] {
  const arr = Array.from(map.values());
  arr.sort((a, b) => (desc ? b.price - a.price : a.price - b.price));
  return arr.slice(0, n);
}

function maybeLog() {
  if (!state.enabled) return;
  if (bfxBid === null || bfxAsk === null) return;
  if (Date.now() - lastLogAt < LOG_INTERVAL_MS) return;

  const bidLevels = topN(bids, BOOK_LEVELS, true);
  const askLevels = topN(asks, BOOK_LEVELS, false);
  if (bidLevels.length < 5 || askLevels.length < 5) return;
  const bidVolume = bidLevels.reduce((s, l) => s + Math.abs(l.amount), 0);
  const askVolume = askLevels.reduce((s, l) => s + Math.abs(l.amount), 0);
  const price = (bfxBid + bfxAsk) / 2;

  lastLogAt = Date.now();
  recordBookVolume(price, bidVolume, askVolume).catch((err) => console.error("recordBookVolume error:", err));
}

function connectBook() {
  const ws = new WebSocket("wss://api-pub.bitfinex.com/ws/2");
  let chanId: number | null = null;
  ws.on("open", () => {
    console.log("Bitfinex book WS connected, subscribing (P0, top 25 levels)...");
    ws.send(JSON.stringify({ event: "subscribe", channel: "book", symbol: "tSOLUSD", prec: "P0", len: String(BOOK_LEVELS) }));
  });
  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === "subscribed" && msg.channel === "book") { chanId = msg.chanId; return; }
      if (!Array.isArray(msg) || msg[0] !== chanId || msg[1] === "hb") return;
      const data = msg[1];
      if (!Array.isArray(data)) return;
      const applyLevel = (lvl: number[]) => {
        const [price, count, amount] = lvl;
        const map = amount > 0 ? bids : asks;
        if (count === 0) map.delete(price);
        else map.set(price, { price, count, amount });
      };
      if (Array.isArray(data[0])) { for (const lvl of data) applyLevel(lvl); }
      else { applyLevel(data as number[]); }
      maybeLog();
    } catch {}
  });
  ws.on("error", (e) => console.error("Bitfinex book WS error:", e));
  ws.on("close", () => { console.log("Bitfinex book WS closed, reconnecting in 2s..."); setTimeout(connectBook, 2000); });
  return ws;
}

function connectTicker() {
  const ws = new WebSocket("wss://api-pub.bitfinex.com/ws/2");
  let chanId: number | null = null;
  ws.on("open", () => {
    console.log("Bitfinex ticker WS connected (real bid/ask), subscribing...");
    ws.send(JSON.stringify({ event: "subscribe", channel: "ticker", symbol: "tSOLUSD" }));
  });
  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === "subscribed" && msg.channel === "ticker") { chanId = msg.chanId; return; }
      if (!Array.isArray(msg) || msg[0] !== chanId || msg[1] === "hb") return;
      const data = msg[1];
      if (!Array.isArray(data) || data.length < 4) return;
      const bid = data[0], ask = data[2];
      if (!bid || !ask) return;
      bfxBid = bid; bfxAsk = ask;
      maybeLog();
    } catch {}
  });
  ws.on("error", (e) => console.error("Bitfinex ticker WS error:", e));
  ws.on("close", () => { console.log("Bitfinex ticker WS closed, reconnecting in 2s..."); setTimeout(connectTicker, 2000); });
  return ws;
}

async function main() {
  const got = await acquireLock();
  if (!got) process.exit(1);

  const heartbeatTimer = setInterval(() => {
    heartbeat().catch((err) => console.error("heartbeat failed:", err));
  }, HEARTBEAT_MS);

  const shutdown = async () => {
    clearInterval(heartbeatTimer);
    await releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`Starting book-volume logger (${INSTANCE_ID}), enabled=${state.enabled}`);
  connectBook();
  connectTicker();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
