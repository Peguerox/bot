// Standalone always-on worker — SOL/USD Pure Trail strategy on Bitfinex, run as a persistent
// Render background worker instead of Trigger.dev's 1-min-cron + 50s-WS-burst pattern. Point of
// this: true continuous tick coverage (no ~10s/min dark gap), so live paper results should track
// the backtest more closely. Paper only — no real orders, no API key needed (public WS feed).
//
// Strategy (verified via backtest this session — see project memory "Surfer Strategy Results" /
// session notes): no entry filter, instant re-entry the moment flat; continuous trailing stop at
// SL_PCT below the peak price since entry, ratchets up only, never loosens; no take-profit
// ceiling; no cooldown. Entry priced as ask (+half-spread), exit/peak-tracking priced as bid
// (-half-spread), continuously through the whole hold — not just at the final fill.
//
// Runs in its own tables (sol_trail_continuous_*), separate from sol_trail_bitfinex_* (the
// existing burst bot), so the two can run side-by-side for direct comparison before this one is
// trusted with anything more.
//
// SINGLE-INSTANCE GUARANTEE: this codebase deliberately moved away from long-lived WS sessions
// earlier because they caused duplicate trades / zombie sessions when a redeploy didn't cleanly
// kill the old process. A persistent worker reintroduces that exact risk class, so on startup
// this process claims a lock row (lock_owner/lock_heartbeat) and refuses to trade if another
// instance's heartbeat is still fresh. It maintains its own heartbeat every HEARTBEAT_MS and
// releases the lock cleanly on SIGINT/SIGTERM.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import WebSocket from "ws";
import os from "os";
import crypto from "crypto";
import {
  getSolTrailContinuousState, updateSolTrailContinuousState, recordSolTrailContinuousTrade,
  logSolTrailContinuousRun, type SolTrailContinuousState,
} from "../lib/sol-trail-continuous-db";

const SYMBOL          = "tSOLUSD";
const SL_PCT          = 0.1;
const SEED_USD        = 100;
const HALF_SPREAD_PCT = 0.0117; // real measured Bitfinex SOLUSD half-spread
const HEARTBEAT_MS    = 10_000;
const LOCK_STALE_MS   = 30_000; // 3 missed heartbeats = assume dead, safe to take over
const DB_WRITE_THROTTLE_MS = 2_000; // don't write peak/stop to DB on every tick
const RUN_LOG_INTERVAL_MS  = 5 * 60_000; // heartbeat-style status row, not per-tick

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

function entryFill(price: number): number { return price * (1 + HALF_SPREAD_PCT / 100); } // ask-adjusted
function exitFill(price: number): number { return price * (1 - HALF_SPREAD_PCT / 100); }  // bid-adjusted

let state: SolTrailContinuousState;
let lastDbWrite = 0;
let lastRunLog = 0;
let ticksSinceLastLog = 0;
let reconnectDelayMs = 1_000;

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
  state.enabled = fresh.enabled; // allow toggling from dashboard without redeploy
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

async function onTick(price: number) {
  ticksSinceLastLog++;
  if (!state.enabled) return;

  if (state.mode === "USD") {
    // Instant re-entry the moment flat — no candle cadence, no filter.
    const targetPool = SEED_USD + (state.realized_pnl_usd ?? 0);
    const entryPrice = entryFill(price);
    const solQty = targetPool / entryPrice;
    const initialPeak = exitFill(price);
    const patch = {
      mode: "SOL" as const, sol_quantity: solQty, entry_price: entryPrice,
      entry_time: new Date().toISOString(), usd_balance: 0,
      peak_price: initialPeak, stop_price: initialPeak * (1 - SL_PCT / 100),
    };
    state = { ...state, ...patch };
    await updateSolTrailContinuousState(patch);
    lastDbWrite = Date.now();
    console.log(`BUY  price=${entryPrice.toFixed(4)} qty=${solQty.toFixed(4)}`);
    return;
  }

  // mode === "SOL": track peak, check stop, both on the worst-case (bid-adjusted) price.
  const effSell = exitFill(price);
  const peak = state.peak_price ?? state.entry_price!;
  const stop = state.stop_price ?? peak * (1 - SL_PCT / 100);

  if (effSell <= stop) {
    const exitPrice = stop; // already bid-consistent
    const origEntryPrice = state.entry_price!;
    const origSolQty = state.sol_quantity!;
    const origEntryTime = state.entry_time!;
    const usdOut = origSolQty * exitPrice;
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
      entry_price: origEntryPrice, exit_price: exitPrice, sol_quantity: origSolQty,
      usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct, entry_time: origEntryTime,
    });
    lastDbWrite = Date.now();
    console.log(`STOP price=${exitPrice.toFixed(4)} pnlUsd=${pnlUsd.toFixed(4)} pnlPct=${pnlPct.toFixed(4)}`);

  } else if (effSell > peak) {
    state = { ...state, peak_price: effSell, stop_price: effSell * (1 - SL_PCT / 100) };
    if (Date.now() - lastDbWrite > DB_WRITE_THROTTLE_MS) {
      await updateSolTrailContinuousState({ peak_price: state.peak_price, stop_price: state.stop_price });
      lastDbWrite = Date.now();
    }
  }

  if (Date.now() - lastRunLog > RUN_LOG_INTERVAL_MS) {
    await logSolTrailContinuousRun({
      action: "STATUS", mode: state.mode, peak: state.peak_price, stop: state.stop_price,
      ticksSinceLastLog, instance: INSTANCE_ID,
    });
    lastRunLog = Date.now();
    ticksSinceLastLog = 0;
  }
}

function connect() {
  const ws = new WebSocket("wss://api-pub.bitfinex.com/ws/2");
  let chanId: number | null = null;
  let queue: Promise<void> = Promise.resolve();

  ws.on("open", () => {
    console.log("WS connected, subscribing...");
    reconnectDelayMs = 1_000;
    ws.send(JSON.stringify({ event: "subscribe", channel: "trades", symbol: SYMBOL }));
  });

  ws.on("message", (raw: Buffer) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "subscribed" && msg.channel === "trades") { chanId = msg.chanId; return; }
    if (!Array.isArray(msg) || msg[0] !== chanId) return;
    if (msg[1] !== "te") return; // ignore heartbeats, snapshot, and "tu" duplicate confirmation

    const price = msg[2][3];
    if (!price || isNaN(price)) return;

    queue = queue.then(() => onTick(price)).catch((err) => console.error("onTick error:", err));
  });

  ws.on("error", (err) => console.error("WS error:", err));
  ws.on("close", () => {
    console.log(`WS closed, reconnecting in ${reconnectDelayMs}ms...`);
    setTimeout(connect, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
  });
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

  console.log(`Starting continuous trail worker (${INSTANCE_ID}), enabled=${state.enabled}, mode=${state.mode}`);
  connect();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
