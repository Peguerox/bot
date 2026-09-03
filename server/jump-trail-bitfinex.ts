// Standalone always-on worker — REDESIGNED AGAIN 2026-09-03. Previous version bought when
// Binance's ask rose >=0.02% above Bitfinex's ask (assumed lag) — that thesis didn't hold up
// (see event-based convergence testing this session: gap-widening events mostly led to further
// divergence, not catch-up).
//
// New signal, based on a mean-reversion pattern found via statistical event analysis: events
// where Bitfinex's own price went on to RISE started from a small absolute gap (avg -0.19%);
// events where it went on to FALL started from a bigger absolute gap (avg -0.27%). So: buy when
// the ask-to-ask gap is exactly zero — that's when Bitfinex's price has
// historically been more likely to move up next. Same real Bitfinex ask used for signal and
// execution. Long-only (spot can't short without margin).
//
// Exit: unchanged — 0.1% trailing stop on Bitfinex's real bid.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import WebSocket from "ws";
import os from "os";
import crypto from "crypto";
import {
  getSolJumpTrailBitfinexState, updateSolJumpTrailBitfinexState, recordSolJumpTrailBitfinexTrade,
  logSolJumpTrailBitfinexRun, recordSolJumpTrailBitfinexTick, type SolJumpTrailBitfinexState,
} from "../lib/sol-jump-trail-bitfinex-db";

const SL_PCT             = 0.1;
const SEED_USD           = 100;
const HEARTBEAT_MS       = 10_000;
const LOCK_STALE_MS      = 30_000;
const DB_WRITE_THROTTLE_MS = 2_000;
const RUN_LOG_INTERVAL_MS  = 5 * 60_000;

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

let state: SolJumpTrailBitfinexState;
let lastDbWrite = 0;
let lastRunLog = 0;
let binanceAsk: number | null = null;
let bfxBid: number | null = null;
let bfxAsk: number | null = null;
let currentTradeGapPct: number | null = null; // Binance-vs-Bitfinex ask gap that triggered the currently-open position

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

async function enterPosition(gapPct: number) {
  if (bfxAsk === null) return;
  const targetPool = SEED_USD + (state.realized_pnl_usd ?? 0);
  const entry = bfxAsk; // real Bitfinex ask, same price used for the signal
  const solQty = targetPool / entry;
  const extreme = bfxBid ?? bfxAsk;
  const stop = extreme * (1 - SL_PCT / 100);

  currentTradeGapPct = gapPct;
  const patch = {
    mode: "LONG" as const, sol_quantity: solQty, entry_price: entry,
    entry_time: new Date().toISOString(), usd_balance: 0,
    extreme_price: extreme, stop_price: stop,
  };
  state = { ...state, ...patch };
  await updateSolJumpTrailBitfinexState(patch);
  lastDbWrite = Date.now();
  console.log(`ENTER LONG  @ $${entry.toFixed(4)}  qty=${solQty.toFixed(4)}  gap=${gapPct.toFixed(4)}%`);
  await logSolJumpTrailBitfinexRun({ actions: [{ action: "ENTER", direction: "LONG", price: entry, qty: solQty, jumpPct: gapPct }] });
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
  const gapPct = currentTradeGapPct ?? 0;
  currentTradeGapPct = null;

  const patch = {
    mode: "FLAT" as const, sol_quantity: null, entry_price: null, entry_time: null,
    usd_balance: usdOut, extreme_price: null, stop_price: null,
  };
  state = { ...state, ...patch };
  await updateSolJumpTrailBitfinexState(patch);
  await recordSolJumpTrailBitfinexTrade({
    direction: "LONG", entry_price: origEntry, exit_price: fillPrice, sol_quantity: origQty,
    usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct, entry_time: origEntryTime,
    jump_pct: gapPct,
  });
  lastDbWrite = Date.now();
  console.log(`EXIT LONG  @ $${fillPrice.toFixed(4)}  pnlUsd=${pnlUsd.toFixed(4)} pnlPct=${pnlPct.toFixed(4)}`);
  await logSolJumpTrailBitfinexRun({ actions: [{ action: "EXIT", direction: "LONG", price: fillPrice, pnlUsd, pnlPct }] });
  lastRunLog = Date.now();
}

async function checkEntry() {
  if (!state.enabled || state.mode !== "FLAT" || binanceAsk === null || bfxAsk === null) return;
  const gapPct = (binanceAsk - bfxAsk) / bfxAsk * 100;
  if (gapPct === 0) await enterPosition(gapPct);
}

async function onBfxTicker(bid: number, ask: number) {
  bfxBid = bid;
  bfxAsk = ask;

  if (state.mode === "LONG") {
    recordSolJumpTrailBitfinexTick(state.entry_time!, bid).catch((err) => console.error("recordTick error:", err));

    const extreme = state.extreme_price ?? state.entry_price!;
    const stop = state.stop_price ?? extreme * (1 - SL_PCT / 100);
    if (bid <= stop) { await exitPosition(stop); return; }
    if (bid > extreme) {
      state = { ...state, extreme_price: bid, stop_price: bid * (1 - SL_PCT / 100) };
      if (Date.now() - lastDbWrite > DB_WRITE_THROTTLE_MS) {
        await updateSolJumpTrailBitfinexState({ extreme_price: state.extreme_price, stop_price: state.stop_price });
        lastDbWrite = Date.now();
      }
    }
    if (Date.now() - lastRunLog > RUN_LOG_INTERVAL_MS) {
      await logSolJumpTrailBitfinexRun({
        actions: [{ action: "STATUS", mode: state.mode, price: bid, extreme: state.extreme_price, stop: state.stop_price }],
      });
      lastRunLog = Date.now();
    }
  } else {
    await checkEntry();
  }
}

function connectBinance() {
  const ws = new WebSocket("wss://stream.binance.com:9443/ws/solusdt@bookTicker");
  ws.on("open", () => console.log("Binance bookTicker WS connected (real bid/ask)"));
  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      const ask = parseFloat(msg.a);
      if (ask) { binanceAsk = ask; checkEntry().catch((err) => console.error("checkEntry error:", err)); }
    } catch {}
  });
  ws.on("error", (e) => console.error("Binance WS error:", e));
  ws.on("close", () => { console.log("Binance WS closed, reconnecting in 2s..."); setTimeout(connectBinance, 2000); });
  return ws;
}

function connectBitfinex() {
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
      queue = queue.then(() => onBfxTicker(bid, ask)).catch((err) => console.error("onBfxTicker error:", err));
    } catch {}
  });
  ws.on("error", (e) => console.error("Bitfinex WS error:", e));
  ws.on("close", () => { console.log("Bitfinex WS closed, reconnecting in 2s..."); setTimeout(connectBitfinex, 2000); });
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

  console.log(`Starting jump-trail worker (${INSTANCE_ID}), enabled=${state.enabled}, mode=${state.mode}`);
  console.log(`Signal: Binance ask - Bitfinex ask == exactly 0. SL/trail: ${SL_PCT}%.`);
  connectBinance();
  connectBitfinex();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
