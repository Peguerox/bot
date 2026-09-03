// Standalone always-on paper worker — REVERTED 2026-09-03 back to the exact-zero cross-venue
// gap signal (the best-performing paper strategy this session, +$3.17 realized / 19-26 wins
// before being swapped out to test order book imbalance, which never showed a real signal).
//
// SIGNAL: continuously compare Binance's real ask (bookTicker) to Bitfinex's real ask (ticker
// channel). Buy on Bitfinex the instant the gap is EXACTLY zero (gapPct === 0, no tolerance
// band). Long-only (spot can't short without margin).
//
// EXIT: CHANGED 2026-09-03 from a 0.1% trailing stop to a fixed OCO-style bracket — TP=+0.1%,
// SL=-0.05% from entry, whichever hits first, no trailing. Testing this specific fixed
// combination fresh; the earlier tick-data backtest found a flat 0.1% TP alone underperformed
// the trailing stop, but that test didn't pair it with a tighter 0.05% SL like this.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import WebSocket from "ws";
import os from "os";
import crypto from "crypto";
import {
  getSolJumpTrailBitfinexState, updateSolJumpTrailBitfinexState, recordSolJumpTrailBitfinexTrade,
  logSolJumpTrailBitfinexRun, recordSolJumpTrailBitfinexTick, type SolJumpTrailBitfinexState,
} from "../lib/sol-jump-trail-bitfinex-db";

const TP_PCT              = 0.1;
const SL_PCT              = 0.05;
const SEED_USD            = 100;
const HEARTBEAT_MS        = 10_000;
const LOCK_STALE_MS       = 30_000;
const DB_WRITE_THROTTLE_MS = 2_000;
const RUN_LOG_INTERVAL_MS  = 5 * 60_000;

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

let state: SolJumpTrailBitfinexState;
let lastDbWrite = 0;
let lastRunLog = 0;
let binanceAsk: number | null = null;
let bfxBid: number | null = null;
let bfxAsk: number | null = null;
let currentTradeGapPct: number | null = null;
let tpPrice: number | null = null;
let slPrice: number | null = null;
let armed = true; // re-arm filter 2026-09-03: gap==0 only counts as a fresh signal once the gap
                   // has read non-zero at least once since the last entry -- stops the bot from
                   // re-firing repeatedly on the same stagnant zero right after a trade closes.

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
  const entry = bfxAsk;
  const solQty = targetPool / entry;
  tpPrice = entry * (1 + TP_PCT / 100);
  slPrice = entry * (1 - SL_PCT / 100);

  armed = false;
  currentTradeGapPct = gapPct;
  const patch = {
    mode: "LONG" as const, sol_quantity: solQty, entry_price: entry,
    entry_time: new Date().toISOString(), usd_balance: 0,
    extreme_price: entry, stop_price: slPrice,
  };
  state = { ...state, ...patch };
  await updateSolJumpTrailBitfinexState(patch);
  lastDbWrite = Date.now();
  console.log(`ENTER LONG  @ $${entry.toFixed(4)}  qty=${solQty.toFixed(4)}  gap=${gapPct.toFixed(4)}%  TP=$${tpPrice.toFixed(4)}  SL=$${slPrice.toFixed(4)}`);
  await logSolJumpTrailBitfinexRun({ actions: [{ action: "ENTER", direction: "LONG", price: entry, qty: solQty, jumpPct: gapPct }] });
  lastRunLog = Date.now();
}

async function exitPosition(fillPrice: number, reason: "TP" | "SL") {
  const origEntry = state.entry_price!;
  const origQty = state.sol_quantity!;
  const origEntryTime = state.entry_time!;

  const usdIn = origEntry * origQty;
  const usdOut = fillPrice * origQty;
  const pnlUsd = usdOut - usdIn;
  const pnlPct = (pnlUsd / usdIn) * 100;
  const gapPct = currentTradeGapPct ?? 0;
  currentTradeGapPct = null;
  tpPrice = null;
  slPrice = null;

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
  console.log(`EXIT LONG (${reason})  @ $${fillPrice.toFixed(4)}  pnlUsd=${pnlUsd.toFixed(4)} pnlPct=${pnlPct.toFixed(4)}`);
  await logSolJumpTrailBitfinexRun({ actions: [{ action: "EXIT", direction: "LONG", price: fillPrice, pnlUsd, pnlPct, reason }] });
  lastRunLog = Date.now();
}

async function checkEntry() {
  if (binanceAsk === null || bfxAsk === null) return;
  const gapPct = (binanceAsk - bfxAsk) / bfxAsk * 100;
  if (gapPct !== 0) armed = true; // re-arms regardless of mode, so it's ready the moment we're flat again
  if (!state.enabled || state.mode !== "FLAT") return;
  if (gapPct === 0 && armed) await enterPosition(gapPct);
}

async function onBfxTicker(bid: number, ask: number) {
  bfxBid = bid;
  bfxAsk = ask;

  if (state.mode === "LONG") {
    recordSolJumpTrailBitfinexTick(state.entry_time!, bid).catch((err) => console.error("recordTick error:", err));

    const tp = tpPrice ?? state.entry_price! * (1 + TP_PCT / 100);
    const sl = slPrice ?? state.stop_price!;
    if (bid <= sl) { await exitPosition(sl, "SL"); return; }
    if (bid >= tp) { await exitPosition(tp, "TP"); return; }

    if (Date.now() - lastRunLog > RUN_LOG_INTERVAL_MS) {
      await logSolJumpTrailBitfinexRun({
        actions: [{ action: "STATUS", mode: state.mode, bid, ask, tp, sl }],
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
      onBfxTicker(bid, ask).catch((err) => console.error("onBfxTicker error:", err));
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
  console.log(`Signal: Binance ask - Bitfinex ask == exactly 0. TP=${TP_PCT}% / SL=${SL_PCT}% (fixed OCO-style, no trailing).`);
  connectBinance();
  connectBitfinex();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
