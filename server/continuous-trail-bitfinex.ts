// REAL MONEY — Jump Trail strategy (NOT Pure Trail — this file used to run the always-re-enter
// Pure Trail strategy, converted 2026-09-03 per explicit user instruction to the Jump strategy
// instead). Watches Binance SOLUSDT for a "jump" (>=JUMP_PCT cumulative move within a 2s rolling
// window, single-venue, no cross-venue comparison) and, when flat, buys SOL on Bitfinex. Manages
// the position with a SL_PCT trailing stop on Bitfinex's real bid.
// $20 seed, compounds. Same tables/dashboard panel as before (sol_trail_continuous_*) — schema
// is compatible since both strategies are "flat vs holding SOL, entry/peak/stop" shaped, only
// the entry TRIGGER differs (jump signal here, instant re-entry in the old Pure Trail version).
//
// PARAMETER HISTORY: was JUMP_PCT=0.02%/SL_PCT=0.1% (matching the paper bot's original,
// most-tested setting). The paper bot was separately redesigned to a cross-venue ask-vs-ask gap
// signal, but that research found the cross-venue thesis wasn't holding up in the specific
// windows tested (see [[project_jump_trail_bot]] memory / research/lead-lag-findings.md) — so
// this live bot was deliberately kept on the simpler single-venue jump signal instead, and on
// 2026-09-03 lowered to JUMP_PCT=0.01%/SL_PCT=0.05% to retest a more sensitive combination now
// that entry/exit use real bid/ask instead of an estimate.
//
// REAL MONEY MECHANICS: entry/exit timing decisions use Bitfinex's real live ticker (true bid
// and ask), not an estimate. Earlier version subscribed to the "trades" channel (last executed
// price) and approximated bid/ask by subtracting/adding an assumed spread constant — but the
// last trade price bounces between sitting near the real bid and near the real ask depending on
// who was the aggressor, so a fixed offset from it isn't the same as the real bid. Found
// 2026-09-03 after live P&L was running ~0.15 points worse than the paper bot over 11 matched
// trades even after correcting the spread constant once already. Switched to the "ticker"
// channel, which streams the real bid/ask directly — no more approximation needed. The
// price/quantity actually recorded still comes from the real Bitfinex fill via
// lib/bitfinex-auth.ts, not an estimate.
//
// SINGLE-INSTANCE GUARANTEE: critical with real orders — claims a lock row (lock_owner/
// lock_heartbeat) on startup, refuses to trade if another instance's heartbeat is fresh, releases
// the lock cleanly on shutdown.
//
// INFRA NOTE: this worker needs BOTH a Binance WS connection (jump signal) and a Bitfinex WS
// connection (execution). Binance's global WS feed returns HTTP 451 from Render's US regions —
// this service must run in a non-US region (Frankfurt/Singapore), same fix already applied to
// the paper SOL Jump Trail worker.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import WebSocket from "ws";
import os from "os";
import crypto from "crypto";
import {
  getSolTrailContinuousState, updateSolTrailContinuousState, recordSolTrailContinuousTrade,
  logSolTrailContinuousRun, type SolTrailContinuousState,
} from "../lib/sol-trail-continuous-db";
import { submitMarketOrder } from "../lib/bitfinex-auth";

const BFX_SYMBOL       = "tSOLUSD";
const BINANCE_WS       = "wss://stream.binance.com:9443/ws/solusdt@trade";
const JUMP_PCT         = 0.01;   // lowered from 0.02% 2026-09-03 — testing a more sensitive single-venue Binance jump signal
const ROLL_MS          = 2000;
const SL_PCT           = 0.05;   // lowered from 0.1% 2026-09-03 — retesting now that entry/exit use real bid/ask (0.1% won the earlier comparison, but that was with the 0.02% cross-venue signal, not this 0.01% single-venue one)
const SEED_USD         = 20;
const HEARTBEAT_MS     = 10_000;
const LOCK_STALE_MS    = 30_000;
const DB_WRITE_THROTTLE_MS = 2_000;
const RUN_LOG_INTERVAL_MS  = 5 * 60_000;

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

let state: SolTrailContinuousState;
let lastDbWrite = 0;
let lastRunLog = 0;
let orderInFlight = false;
let binBuf: { t: number; p: number }[] = [];
let bidLast: number | null = null;
let askLast: number | null = null;

async function acquireLock(): Promise<boolean> {
  state = await getSolTrailContinuousState();
  const heartbeatAge = state.lock_heartbeat ? Date.now() - new Date(state.lock_heartbeat).getTime() : Infinity;
  if (state.lock_owner && heartbeatAge < LOCK_STALE_MS) {
    console.error(`Refusing to start: lock held by ${state.lock_owner}, last heartbeat ${heartbeatAge}ms ago`);
    return false;
  }
  await updateSolTrailContinuousState({ lock_owner: INSTANCE_ID, lock_heartbeat: new Date().toISOString() });
  console.log(`Lock acquired as ${INSTANCE_ID}`);
  return true;
}

async function heartbeat() {
  const fresh = await getSolTrailContinuousState();
  if (fresh.lock_owner !== INSTANCE_ID) {
    console.error(`Lost lock to ${fresh.lock_owner} — another instance took over. Exiting.`);
    process.exit(1);
  }
  state.enabled = fresh.enabled;
  await updateSolTrailContinuousState({ lock_heartbeat: new Date().toISOString() });
}

async function releaseLock() {
  try {
    const fresh = await getSolTrailContinuousState();
    if (fresh.lock_owner === INSTANCE_ID) {
      await updateSolTrailContinuousState({ lock_owner: null, lock_heartbeat: null });
      console.log("Lock released cleanly.");
    }
  } catch (err) {
    console.error("releaseLock failed:", err);
  }
}

function checkJump(): number | null {
  if (binBuf.length < 2) return null;
  const now = binBuf[binBuf.length - 1];
  while (binBuf.length > 1 && now.t - binBuf[0].t > ROLL_MS) binBuf.shift();
  const old = binBuf[0];
  const pct = (now.p - old.p) / old.p * 100;
  return pct >= JUMP_PCT ? pct : null; // long-only — spot can't short without margin
}

async function onBinTick(price: number) {
  binBuf.push({ t: Date.now(), p: price });
  if (!state.enabled || state.mode !== "USD" || orderInFlight || askLast === null) return;

  const jumpPct = checkJump();
  if (jumpPct === null) return;

  orderInFlight = true;
  try {
    const targetPool = SEED_USD + (state.realized_pnl_usd ?? 0);
    const estQty = targetPool / askLast; // real live ask, no estimate
    console.log(`BUY signal (jump=${jumpPct.toFixed(4)}%) @ ask=${askLast.toFixed(4)} qty~=${estQty.toFixed(4)} — submitting real order...`);
    const fill = await submitMarketOrder(BFX_SYMBOL, estQty);
    const patch = {
      mode: "SOL" as const, sol_quantity: fill.execAmount, entry_price: fill.execPrice,
      entry_time: new Date().toISOString(), usd_balance: 0,
      peak_price: fill.execPrice, stop_price: fill.execPrice * (1 - SL_PCT / 100),
    };
    state = { ...state, ...patch };
    await updateSolTrailContinuousState(patch);
    lastDbWrite = Date.now();
    console.log(`BUY FILLED price=${fill.execPrice.toFixed(4)} qty=${fill.execAmount.toFixed(4)} fee=${fill.fee}`);
    await logSolTrailContinuousRun({ actions: [{ action: "BUY", price: fill.execPrice, qty: fill.execAmount, orderId: fill.orderId, jumpPct }] });
    lastRunLog = Date.now();
    binBuf = [binBuf[binBuf.length - 1]]; // reset jump window so we don't immediately re-trigger
  } catch (err) {
    console.error("BUY order failed:", err);
    await logSolTrailContinuousRun({ actions: [{ action: "ERROR", stage: "buy", error: String(err) }] });
  } finally {
    orderInFlight = false;
  }
}

async function onBfxTicker(bid: number, ask: number) {
  bidLast = bid;
  askLast = ask;
  if (!state.enabled || orderInFlight || state.mode !== "SOL") return;

  const effSell = bid; // real live bid, no estimate — what a market sell would actually receive
  const peak = state.peak_price ?? state.entry_price!;
  const stop = state.stop_price ?? peak * (1 - SL_PCT / 100);

  if (effSell <= stop) {
    orderInFlight = true;
    try {
      const origEntryPrice = state.entry_price!;
      const origSolQty = state.sol_quantity!;
      const origEntryTime = state.entry_time!;
      console.log(`STOP signal, selling ${origSolQty.toFixed(4)} SOL — submitting real order...`);
      const fill = await submitMarketOrder(BFX_SYMBOL, -origSolQty);
      const usdOut = fill.execPrice * Math.abs(fill.execAmount); // execAmount is negative on a sell fill
      const usdIn  = origEntryPrice * origSolQty;
      const pnlUsd = usdOut - usdIn;
      const pnlPct = (pnlUsd / usdIn) * 100;

      const patch = {
        mode: "USD" as const, sol_quantity: null, entry_price: null, entry_time: null,
        usd_balance: usdOut, peak_price: null, stop_price: null,
      };
      state = { ...state, ...patch };
      await updateSolTrailContinuousState(patch);
      await recordSolTrailContinuousTrade({
        entry_price: origEntryPrice, exit_price: fill.execPrice, sol_quantity: origSolQty,
        usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct, entry_time: origEntryTime,
      });
      lastDbWrite = Date.now();
      console.log(`STOP FILLED price=${fill.execPrice.toFixed(4)} pnlUsd=${pnlUsd.toFixed(4)} pnlPct=${pnlPct.toFixed(4)}`);
      await logSolTrailContinuousRun({ actions: [{ action: "STOP_FILLED", price: fill.execPrice, pnlUsd, pnlPct, orderId: fill.orderId }] });
      lastRunLog = Date.now();
    } catch (err) {
      console.error("SELL order failed:", err);
      await logSolTrailContinuousRun({ actions: [{ action: "ERROR", stage: "sell", error: String(err) }] });
    } finally {
      orderInFlight = false;
    }
    return;
  } else if (effSell > peak) {
    state = { ...state, peak_price: effSell, stop_price: effSell * (1 - SL_PCT / 100) };
    if (Date.now() - lastDbWrite > DB_WRITE_THROTTLE_MS) {
      await updateSolTrailContinuousState({ peak_price: state.peak_price, stop_price: state.stop_price });
      lastDbWrite = Date.now();
    }
  }

  if (Date.now() - lastRunLog > RUN_LOG_INTERVAL_MS) {
    await logSolTrailContinuousRun({
      actions: [{ action: "STATUS", mode: state.mode, bid, ask, peak: state.peak_price, stop: state.stop_price }],
    });
    lastRunLog = Date.now();
  }
}

function connectBinance() {
  const ws = new WebSocket(BINANCE_WS);
  ws.on("open", () => console.log("Binance WS connected"));
  ws.on("message", (raw: Buffer) => {
    try { const p = parseFloat(JSON.parse(raw.toString()).p); if (p) onBinTick(p).catch((err) => console.error("onBinTick error:", err)); } catch {}
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
    console.log("Bitfinex WS connected, subscribing to ticker (real bid/ask)...");
    ws.send(JSON.stringify({ event: "subscribe", channel: "ticker", symbol: BFX_SYMBOL }));
  });

  ws.on("message", (raw: Buffer) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.event === "subscribed" && msg.channel === "ticker") { chanId = msg.chanId; return; }
    if (!Array.isArray(msg) || msg[0] !== chanId || msg[1] === "hb") return;
    const data = msg[1];
    if (!Array.isArray(data) || data.length < 4) return;
    const bid = data[0], ask = data[2];
    if (!bid || !ask || isNaN(bid) || isNaN(ask)) return;
    queue = queue.then(() => onBfxTicker(bid, ask)).catch((err) => console.error("onBfxTicker error:", err));
  });

  ws.on("error", (err) => console.error("Bitfinex WS error:", err));
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

  console.log(`Starting LIVE Jump Trail worker (${INSTANCE_ID}), enabled=${state.enabled}, mode=${state.mode}`);
  console.log(`REAL MONEY — jump>=${JUMP_PCT}% triggers a real buy on ${BFX_SYMBOL}. Seed $${SEED_USD}, compounding, SL=${SL_PCT}%.`);
  connectBinance();
  connectBitfinex();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
