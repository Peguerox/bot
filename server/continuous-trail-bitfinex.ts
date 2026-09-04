// REAL MONEY — converted 2026-09-04 from SOL fixed-OCO (TP=1%/SL=0.1%) to ETH/USD always-in
// pure trail. The OCO approach failed a full-year backtest at realistic spread across every
// TP/SL combo tried (0.1%-5% TP, 0.1%-0.5% SL) — all negative once spread was set to SOL's real
// measured level (~0.03% full spread) or worse. Checking other pairs' spreads found ETH's real
// spread is much tighter (~0.008% full spread vs SOL's ~0.029% at the time measured) — closer
// to the OPTIMISTIC spread case that made every strategy look artificially good. Backtested an
// always-in 0.1% trail (buy immediately, trail stop 0.1% below the highest bid since entry,
// re-enter instantly on stop-out) on ETH/USD over a full year at ETH's own spread: positive
// across every spread scenario tested (+693% optimistic real-spread case down to +206% at a
// deliberately conservative 0.01% half-spread) — the first strategy this session to survive
// the full range of spread assumptions, not just the tightest one.
//
// NOT YET DONE: only spot-checked ETH's real spread once, right before backtesting — same
// caveat as every spread-based backtest today, spread can widen at other times of day/week.
// This live run is partly to get a real measurement instead of trusting a single backtest.
//
// STRATEGY: no entry signal/filter — always re-enter the instant flat. Trail a stop TRAIL_PCT
// below the highest real bid seen since entry, re-evaluated on every tick. Entry priced at real
// Bitfinex ask, stop checked against real Bitfinex bid (worst-case-consistent, same methodology
// as every other bot this session).
//
// SINGLE-INSTANCE GUARANTEE: critical with real orders — claims a lock row (lock_owner/
// lock_heartbeat) on startup, refuses to trade if another instance's heartbeat is fresh, releases
// the lock cleanly on shutdown.
//
// WATCHDOG: emergency-flattens via a fresh REST price (independent of the WS) if the Bitfinex
// ticker goes silent for too long while holding — carried over from the jump-trail version after
// three real-money freeze incidents there (root cause was unrelated — a missing function deploy
// — but the watchdog itself is good defense-in-depth regardless).
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import WebSocket from "ws";
import os from "os";
import crypto from "crypto";
import {
  getSolTrailContinuousState, updateSolTrailContinuousState, recordSolTrailContinuousTrade,
  logSolTrailContinuousRun, recordSolTrailContinuousTick, type SolTrailContinuousState,
} from "../lib/sol-trail-continuous-db";
import { submitMarketOrderSafe } from "../lib/bitfinex-auth";

const BFX_SYMBOL       = "tETHUSD";
const TRAIL_PCT        = 0.1;
const SEED_USD         = 20;
const HEARTBEAT_MS     = 10_000;
const LOCK_STALE_MS    = 30_000;
const DB_WRITE_THROTTLE_MS = 2_000;
const RUN_LOG_INTERVAL_MS  = 5 * 60_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const BFX_STALE_MS         = 15_000;
const BFX_EMERGENCY_MS     = 25_000;

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

let state: SolTrailContinuousState;
let lastDbWrite = 0;
let lastBfxMessageTime = Date.now();
let bfxWs: WebSocket | null = null;
let emergencyInProgress = false;
let lastRunLog = 0;
let orderInFlight = false;
let bfxBid: number | null = null;
let bfxAsk: number | null = null;

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
  if (orderInFlight) {
    state.enabled = fresh.enabled;
  } else {
    state = fresh;
  }
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

async function checkEntry() {
  if (!state.enabled || state.mode !== "USD" || orderInFlight || bfxAsk === null) return;

  orderInFlight = true;
  try {
    const targetPool = SEED_USD + (state.realized_pnl_usd ?? 0);
    const estQty = targetPool / bfxAsk;
    console.log(`BUY (always-on trail, no filter) @ ask=${bfxAsk.toFixed(4)} qty~=${estQty.toFixed(4)} — submitting real order...`);
    const fill = await submitMarketOrderSafe(BFX_SYMBOL, estQty, "USD", bfxAsk);
    const extreme = fill.execPrice;
    const stop = extreme * (1 - TRAIL_PCT / 100);
    const patch = {
      mode: "SOL" as const, sol_quantity: fill.execAmount, entry_price: fill.execPrice,
      entry_time: new Date().toISOString(), usd_balance: 0,
      peak_price: extreme, stop_price: stop,
    };
    state = { ...state, ...patch };
    await updateSolTrailContinuousState(patch);
    lastDbWrite = Date.now();
    console.log(`BUY FILLED price=${fill.execPrice.toFixed(4)} qty=${fill.execAmount.toFixed(4)} fee=${fill.fee} stop=${stop.toFixed(4)}`);
    await logSolTrailContinuousRun({ actions: [{ action: "BUY", price: fill.execPrice, qty: fill.execAmount, orderId: fill.orderId }] });
    lastRunLog = Date.now();
  } catch (err) {
    console.error("BUY order failed:", err);
    await logSolTrailContinuousRun({ actions: [{ action: "ERROR", stage: "buy", error: String(err) }] });
  } finally {
    orderInFlight = false;
  }
}

async function onBfxTicker(bid: number, ask: number) {
  bfxBid = bid;
  bfxAsk = ask;
  if (!state.enabled || orderInFlight) return;

  if (state.mode !== "SOL") {
    await checkEntry();
    return;
  }

  recordSolTrailContinuousTick(state.entry_time!, bid, ask).catch((err) => console.error("recordTick error:", err));

  const peak = state.peak_price ?? state.entry_price!;
  const stop = state.stop_price ?? peak * (1 - TRAIL_PCT / 100);

  if (bid <= stop) {
    orderInFlight = true;
    try {
      const origEntryPrice = state.entry_price!;
      const origSolQty = state.sol_quantity!;
      const origEntryTime = state.entry_time!;
      console.log(`STOP signal, selling ${origSolQty.toFixed(4)} ETH — submitting real order...`);
      const fill = await submitMarketOrderSafe(BFX_SYMBOL, -origSolQty, "ETH");
      const usdOut = fill.execPrice * Math.abs(fill.execAmount);
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
    // Always-in: re-enter the instant we're flat again (checkEntry no-ops if disabled meanwhile).
    await checkEntry();
    return;
  } else if (bid > peak) {
    state = { ...state, peak_price: bid, stop_price: bid * (1 - TRAIL_PCT / 100) };
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

function connectBitfinex() {
  const ws = new WebSocket("wss://api-pub.bitfinex.com/ws/2");
  bfxWs = ws;
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
    lastBfxMessageTime = Date.now();
    queue = queue.then(() => onBfxTicker(bid, ask)).catch((err) => console.error("onBfxTicker error:", err));
  });

  ws.on("error", (err) => console.error("Bitfinex WS error:", err));
  ws.on("close", () => { console.log("Bitfinex WS closed, reconnecting in 2s..."); setTimeout(connectBitfinex, 2000); });
  return ws;
}

async function emergencyFlatten(reason: string) {
  if (emergencyInProgress) return;
  emergencyInProgress = true;
  try {
    console.error(`EMERGENCY FLATTEN triggered: ${reason}`);
    await logSolTrailContinuousRun({ actions: [{ action: "ERROR", stage: "watchdog", error: reason }] }).catch(() => {});
    const fresh = await getSolTrailContinuousState();
    if (fresh.mode !== "SOL" || !fresh.sol_quantity) {
      console.error("Watchdog: not holding per DB state, nothing to flatten.");
      return;
    }
    const fill = await submitMarketOrderSafe(BFX_SYMBOL, -fresh.sol_quantity, "ETH");
    const usdOut = fill.execPrice * Math.abs(fill.execAmount);
    const usdIn = fresh.entry_price! * fresh.sol_quantity;
    const pnlUsd = usdOut - usdIn;
    const pnlPct = (pnlUsd / usdIn) * 100;
    await updateSolTrailContinuousState({
      mode: "USD", sol_quantity: null, entry_price: null, entry_time: null,
      usd_balance: usdOut, peak_price: null, stop_price: null, enabled: false,
    });
    await recordSolTrailContinuousTrade({
      entry_price: fresh.entry_price!, exit_price: fill.execPrice, sol_quantity: fresh.sol_quantity,
      usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct, entry_time: fresh.entry_time!,
    });
    console.error(`EMERGENCY FLATTEN complete @ ${fill.execPrice}, pnlPct=${pnlPct.toFixed(4)}. Bot paused (enabled=false).`);
    await logSolTrailContinuousRun({ actions: [{ action: "STOP_FILLED", price: fill.execPrice, pnlUsd, pnlPct, orderId: fill.orderId, emergency: true }] }).catch(() => {});
  } catch (err) {
    console.error("EMERGENCY FLATTEN FAILED:", err);
    await logSolTrailContinuousRun({ actions: [{ action: "ERROR", stage: "watchdog-flatten-failed", error: String(err) }] }).catch(() => {});
  } finally {
    process.exit(1);
  }
}

function startWatchdog() {
  setInterval(() => {
    const staleMs = Date.now() - lastBfxMessageTime;
    if (staleMs < BFX_STALE_MS) return;

    if (state.mode === "SOL" && staleMs >= BFX_EMERGENCY_MS && !emergencyInProgress) {
      emergencyFlatten(`Bitfinex WS silent for ${Math.round(staleMs / 1000)}s while holding ETH`)
        .catch((err) => console.error("emergencyFlatten error:", err));
      return;
    }

    console.error(`Watchdog: Bitfinex WS silent for ${Math.round(staleMs / 1000)}s, forcing reconnect...`);
    bfxWs?.terminate();
  }, WATCHDOG_INTERVAL_MS);
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

  console.log(`Starting LIVE ETH pure-trail worker (${INSTANCE_ID}), enabled=${state.enabled}, mode=${state.mode}`);
  console.log(`REAL MONEY — always-on entry, no filter. Seed $${SEED_USD}, compounding, trail=${TRAIL_PCT}%.`);
  connectBitfinex();
  startWatchdog();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
