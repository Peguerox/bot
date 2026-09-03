// Standalone always-on worker — watches Binance SOLUSDT for "jumps" (>=0.02% cumulative move
// within a 2s rolling window) and, when flat, enters a Bitfinex tSOLUSD LONG paper position on
// an up-jump (long-only — spot can't short without margin, out of scope for now). Position is
// then managed with a 0.05% trailing stop on Bitfinex's own live ticks, worst-case spread.
//
// SL changed from 0.1% to 0.05% on 2026-09-03 for a head-to-head comparison against the live
// real-money bot (server/continuous-trail-bitfinex.ts, same jump signal, SL=0.1%). Also raised
// HALF_SPREAD_PCT from 0.0117% to 0.0267% — the first live real trade showed ~0.03% extra
// round-trip cost vs the old assumption, added on top (0.0234% old round-trip + 0.03% = 0.0534%
// new round-trip, i.e. 0.0267% half-spread).
//
// Session finding motivating this (2026-09-02): across two independent windows (10min + 5min,
// 27 discrete jump events total), 20/27 (74.1%) of Binance jumps were followed by a
// same-direction Bitfinex move within ~10s — vs ~33-50% (noise level, effectively a dead
// market) for Binance US and KuCoin on the same test. Paper only — no real orders, no API key.
//
// Same single-instance lock pattern as server/continuous-trail-bitfinex.ts — see that file's
// header for why (this codebase moved away from unguarded long-lived WS sessions after a
// zombie-session/duplicate-trade bug class earlier this session).
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import WebSocket from "ws";
import os from "os";
import crypto from "crypto";
import {
  getSolJumpTrailBitfinexState, updateSolJumpTrailBitfinexState, recordSolJumpTrailBitfinexTrade,
  logSolJumpTrailBitfinexRun, recordSolJumpTrailBitfinexTick, type SolJumpTrailBitfinexState,
} from "../lib/sol-jump-trail-bitfinex-db";

const JUMP_PCT         = 0.02;   // % cumulative move over ROLL_MS to trigger entry
const ROLL_MS          = 2000;
const SL_PCT           = 0.05;   // head-to-head test vs the live bot's 0.1% — 2026-09-03
const SEED_USD         = 100;
const HALF_SPREAD_PCT  = 0.0267; // old 0.0117 + half of the extra 0.03% round-trip cost seen on the first live real trade
const HEARTBEAT_MS     = 10_000;
const LOCK_STALE_MS    = 30_000;
const DB_WRITE_THROTTLE_MS = 2_000;
const RUN_LOG_INTERVAL_MS  = 5 * 60_000;

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

function entryFillLong(p: number) { return p * (1 + HALF_SPREAD_PCT / 100); }
function exitFillLong(p: number)  { return p * (1 - HALF_SPREAD_PCT / 100); }

let state: SolJumpTrailBitfinexState;
let lastDbWrite = 0;
let lastRunLog = 0;
let binBuf: { t: number; p: number }[] = [];
let bfxLast: number | null = null;
let currentTradeJumpPct: number | null = null; // jump size that triggered the currently-open position

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

function checkJump(): { dir: "UP" | "DOWN"; pct: number } | null {
  if (binBuf.length < 2) return null;
  const now = binBuf[binBuf.length - 1];
  while (binBuf.length > 1 && now.t - binBuf[0].t > ROLL_MS) binBuf.shift();
  const old = binBuf[0];
  const pct = (now.p - old.p) / old.p * 100;
  if (pct >= JUMP_PCT) return { dir: "UP", pct };
  if (pct <= -JUMP_PCT) return { dir: "DOWN", pct };
  return null;
}

async function enterPosition(dir: "LONG", jumpPct: number) {
  if (bfxLast === null) return;
  const targetPool = SEED_USD + (state.realized_pnl_usd ?? 0);
  const entry = entryFillLong(bfxLast);
  const solQty = targetPool / entry;
  const extreme = exitFillLong(bfxLast);
  const stop = extreme * (1 - SL_PCT / 100);

  currentTradeJumpPct = jumpPct;
  const patch = {
    mode: dir, sol_quantity: solQty, entry_price: entry,
    entry_time: new Date().toISOString(), usd_balance: 0,
    extreme_price: extreme, stop_price: stop,
  };
  state = { ...state, ...patch };
  await updateSolJumpTrailBitfinexState(patch);
  lastDbWrite = Date.now();
  console.log(`ENTER ${dir}  @ $${entry.toFixed(4)}  qty=${solQty.toFixed(4)}  jump=${jumpPct.toFixed(4)}%`);
  await logSolJumpTrailBitfinexRun({ actions: [{ action: "ENTER", direction: dir, price: entry, qty: solQty, jumpPct }] });
  lastRunLog = Date.now();

  binBuf = [binBuf[binBuf.length - 1]]; // reset jump window so we don't immediately re-trigger
}

async function exitPosition(fillPrice: number) {
  const dir = state.mode as "LONG";
  const origEntry = state.entry_price!;
  const origQty = state.sol_quantity!;
  const origEntryTime = state.entry_time!;

  const usdIn = origEntry * origQty;
  const usdOut = fillPrice * origQty;
  const pnlUsd = usdOut - usdIn;
  const pnlPct = (pnlUsd / usdIn) * 100;
  const jumpPct = currentTradeJumpPct ?? 0;
  currentTradeJumpPct = null;

  const patch = {
    mode: "FLAT" as const, sol_quantity: null, entry_price: null, entry_time: null,
    usd_balance: usdOut, extreme_price: null, stop_price: null,
  };
  state = { ...state, ...patch };
  await updateSolJumpTrailBitfinexState(patch);
  await recordSolJumpTrailBitfinexTrade({
    direction: dir, entry_price: origEntry, exit_price: fillPrice, sol_quantity: origQty,
    usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct, entry_time: origEntryTime,
    jump_pct: jumpPct,
  });
  lastDbWrite = Date.now();
  console.log(`EXIT ${dir}  @ $${fillPrice.toFixed(4)}  pnlUsd=${pnlUsd.toFixed(4)} pnlPct=${pnlPct.toFixed(4)}`);
  await logSolJumpTrailBitfinexRun({ actions: [{ action: "EXIT", direction: dir, price: fillPrice, pnlUsd, pnlPct }] });
  lastRunLog = Date.now();
}

async function onBfxTick(price: number) {
  bfxLast = price;
  if (!state.enabled) return;

  if (state.mode !== "LONG") return; // entries are driven by onBinTick, not here

  recordSolJumpTrailBitfinexTick(state.entry_time!, price).catch((err) => console.error("recordTick error:", err));

  const effSell = exitFillLong(price);
  const extreme = state.extreme_price ?? state.entry_price!;
  const stop = state.stop_price ?? extreme * (1 - SL_PCT / 100);
  if (effSell <= stop) { await exitPosition(stop); return; }
  if (effSell > extreme) {
    state = { ...state, extreme_price: effSell, stop_price: effSell * (1 - SL_PCT / 100) };
    if (Date.now() - lastDbWrite > DB_WRITE_THROTTLE_MS) {
      await updateSolJumpTrailBitfinexState({ extreme_price: state.extreme_price, stop_price: state.stop_price });
      lastDbWrite = Date.now();
    }
  }

  if (Date.now() - lastRunLog > RUN_LOG_INTERVAL_MS) {
    await logSolJumpTrailBitfinexRun({
      actions: [{ action: "STATUS", mode: state.mode, price, extreme: state.extreme_price, stop: state.stop_price }],
    });
    lastRunLog = Date.now();
  }
}

async function onBinTick(price: number) {
  binBuf.push({ t: Date.now(), p: price });
  if (!state.enabled || state.mode !== "FLAT") return;
  const jump = checkJump();
  if (jump?.dir === "UP") await enterPosition("LONG", jump.pct);
}

function connectBinance() {
  const ws = new WebSocket("wss://stream.binance.com:9443/ws/solusdt@trade");
  ws.on("open", () => console.log("Binance WS connected"));
  ws.on("message", (raw: Buffer) => {
    try { const p = parseFloat(JSON.parse(raw.toString()).p); if (p) onBinTick(p); } catch {}
  });
  ws.on("error", (e) => console.error("Binance WS error:", e));
  ws.on("close", () => { console.log("Binance WS closed, reconnecting in 2s..."); setTimeout(connectBinance, 2000); });
  return ws;
}

function connectBitfinex() {
  const ws = new WebSocket("wss://api-pub.bitfinex.com/ws/2");
  let chanId: number | null = null;
  ws.on("open", () => {
    console.log("Bitfinex WS connected, subscribing...");
    ws.send(JSON.stringify({ event: "subscribe", channel: "trades", symbol: "tSOLUSD" }));
  });
  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === "subscribed" && msg.channel === "trades") { chanId = msg.chanId; return; }
      if (!Array.isArray(msg) || msg[0] !== chanId || msg[1] !== "te") return;
      const p = msg[2][3];
      if (p) onBfxTick(p).catch((err) => console.error("onBfxTick error:", err));
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
  console.log(`Jump def: Binance moves >=${JUMP_PCT}% within ${ROLL_MS}ms. SL/trail: ${SL_PCT}%.`);
  connectBinance();
  connectBitfinex();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
