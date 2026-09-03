// Standalone always-on paper worker — REDESIGNED AGAIN 2026-09-03. Previous version bought when
// the ask-to-ask gap between Binance and Bitfinex hit exactly 0% (mean-reversion signal). That's
// now running live instead (server/continuous-trail-bitfinex.ts) — converting THIS worker (the
// paper slot) to test a fresh, untested idea: order book imbalance.
//
// SIGNAL: subscribe to Bitfinex's real order book (P0 precision, top 25 levels per side) for
// tSOLUSD. Compute imbalance = (bidVolume - askVolume) / (bidVolume + askVolume) across those
// levels. A one-off 4-minute manual test found ask-heavy books (imbalance <= -0.15) preceded
// up-moves 91% of the time at a 5s horizon — but that test ran during a single uptrending
// window with almost zero bid-heavy samples to compare against, so it's unvalidated. Buy on
// Bitfinex when imbalance <= IMBALANCE_THRESH while flat. Long-only (spot can't short without
// margin). This worker exists to accumulate real data across many hours/market conditions to
// actually test whether this holds up.
//
// Exit: 0.1% trailing stop off Bitfinex's real bid (unchanged pattern from the prior version).
// Entry priced off Bitfinex's real ask.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import WebSocket from "ws";
import os from "os";
import crypto from "crypto";
import {
  getSolJumpTrailBitfinexState, updateSolJumpTrailBitfinexState, recordSolJumpTrailBitfinexTrade,
  logSolJumpTrailBitfinexRun, recordSolJumpTrailBitfinexTick, type SolJumpTrailBitfinexState,
} from "../lib/sol-jump-trail-bitfinex-db";

const IMBALANCE_THRESH   = -0.15; // ask-heavy book; from the one-off manual test 2026-09-03
const BOOK_LEVELS        = 25;
const SL_PCT             = 0.1;
const SEED_USD           = 100;
const HEARTBEAT_MS       = 10_000;
const LOCK_STALE_MS      = 30_000;
const DB_WRITE_THROTTLE_MS = 2_000;
const RUN_LOG_INTERVAL_MS  = 5 * 60_000;

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

type Level = { price: number; count: number; amount: number };
const bids = new Map<number, Level>();
const asks = new Map<number, Level>();

let state: SolJumpTrailBitfinexState;
let lastDbWrite = 0;
let lastRunLog = 0;
let bfxBid: number | null = null;
let bfxAsk: number | null = null;
let imbalance: number | null = null;
let currentTradeImbalance: number | null = null; // imbalance that triggered the currently-open position

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

function computeImbalance() {
  const bidLevels = topN(bids, BOOK_LEVELS, true);
  const askLevels = topN(asks, BOOK_LEVELS, false);
  if (bidLevels.length < 5 || askLevels.length < 5) return;
  const bidVol = bidLevels.reduce((s, l) => s + Math.abs(l.amount), 0);
  const askVol = askLevels.reduce((s, l) => s + Math.abs(l.amount), 0);
  imbalance = (bidVol - askVol) / (bidVol + askVol);
}

async function enterPosition(imb: number) {
  if (bfxAsk === null) return;
  const targetPool = SEED_USD + (state.realized_pnl_usd ?? 0);
  const entry = bfxAsk;
  const solQty = targetPool / entry;
  const extreme = bfxBid ?? bfxAsk;
  const stop = extreme * (1 - SL_PCT / 100);

  currentTradeImbalance = imb;
  const patch = {
    mode: "LONG" as const, sol_quantity: solQty, entry_price: entry,
    entry_time: new Date().toISOString(), usd_balance: 0,
    extreme_price: extreme, stop_price: stop,
  };
  state = { ...state, ...patch };
  await updateSolJumpTrailBitfinexState(patch);
  lastDbWrite = Date.now();
  console.log(`ENTER LONG  @ $${entry.toFixed(4)}  qty=${solQty.toFixed(4)}  imbalance=${imb.toFixed(4)}`);
  await logSolJumpTrailBitfinexRun({ actions: [{ action: "ENTER", direction: "LONG", price: entry, qty: solQty, jumpPct: imb }] });
  lastRunLog = Date.now();
}

async function exitPosition(fillPrice: number) {
  const origEntry = state.entry_price!;
  const origQty = state.sol_quantity!;
  const origEntryTime = state.entry_time!;

  const usdIn = origEntry * origQty;
  const usdOut = fillPrice * origQty;
  const pnlUsd = usdOut - usdIn;
  const pnlPct = (pnlUsd / usdIn) * 100;
  const imb = currentTradeImbalance ?? 0;
  currentTradeImbalance = null;

  const patch = {
    mode: "FLAT" as const, sol_quantity: null, entry_price: null, entry_time: null,
    usd_balance: usdOut, extreme_price: null, stop_price: null,
  };
  state = { ...state, ...patch };
  await updateSolJumpTrailBitfinexState(patch);
  await recordSolJumpTrailBitfinexTrade({
    direction: "LONG", entry_price: origEntry, exit_price: fillPrice, sol_quantity: origQty,
    usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct, entry_time: origEntryTime,
    jump_pct: imb, // repurposed column: imbalance value that triggered this trade
  });
  lastDbWrite = Date.now();
  console.log(`EXIT LONG  @ $${fillPrice.toFixed(4)}  pnlUsd=${pnlUsd.toFixed(4)} pnlPct=${pnlPct.toFixed(4)}`);
  await logSolJumpTrailBitfinexRun({ actions: [{ action: "EXIT", direction: "LONG", price: fillPrice, pnlUsd, pnlPct }] });
  lastRunLog = Date.now();
}

async function checkEntry() {
  if (!state.enabled || state.mode !== "FLAT" || imbalance === null || bfxAsk === null) return;
  if (imbalance <= IMBALANCE_THRESH) await enterPosition(imbalance);
}

async function checkExit() {
  if (state.mode !== "LONG" || bfxBid === null) return;

  recordSolJumpTrailBitfinexTick(state.entry_time!, bfxBid).catch((err) => console.error("recordTick error:", err));

  const extreme = state.extreme_price ?? state.entry_price!;
  const stop = state.stop_price ?? extreme * (1 - SL_PCT / 100);
  if (bfxBid <= stop) { await exitPosition(stop); return; }
  if (bfxBid > extreme) {
    state = { ...state, extreme_price: bfxBid, stop_price: bfxBid * (1 - SL_PCT / 100) };
    if (Date.now() - lastDbWrite > DB_WRITE_THROTTLE_MS) {
      await updateSolJumpTrailBitfinexState({ extreme_price: state.extreme_price, stop_price: state.stop_price });
      lastDbWrite = Date.now();
    }
  }
  if (Date.now() - lastRunLog > RUN_LOG_INTERVAL_MS) {
    await logSolJumpTrailBitfinexRun({
      actions: [{ action: "STATUS", mode: state.mode, price: bfxBid, extreme: state.extreme_price, stop: state.stop_price, imbalance }],
    });
    lastRunLog = Date.now();
  }
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
      computeImbalance();
      checkEntry().catch((err) => console.error("checkEntry error:", err));
    } catch {}
  });
  ws.on("error", (e) => console.error("Bitfinex book WS error:", e));
  ws.on("close", () => { console.log("Bitfinex book WS closed, reconnecting in 2s..."); setTimeout(connectBook, 2000); });
  return ws;
}

function connectTicker() {
  const ws = new WebSocket("wss://api-pub.bitfinex.com/ws/2");
  let chanId: number | null = null;
  let queue: Promise<void> = Promise.resolve();
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
      // Fire-and-forget, not chained through a serialized queue — same latency-bug fix applied
      // to the live bot 2026-09-03 (see server/continuous-trail-bitfinex.ts). No real order
      // execution here (paper), so this matters less, but keep the pattern consistent.
      checkExit().catch((err) => console.error("checkExit error:", err));
      checkEntry().catch((err) => console.error("checkEntry error:", err));
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

  console.log(`Starting order-book-imbalance paper worker (${INSTANCE_ID}), enabled=${state.enabled}, mode=${state.mode}`);
  console.log(`Signal: book imbalance <= ${IMBALANCE_THRESH} (top ${BOOK_LEVELS} levels). SL/trail: ${SL_PCT}%.`);
  connectBook();
  connectTicker();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
