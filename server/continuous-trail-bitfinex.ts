// Standalone always-on worker — SOL/USD Pure Trail strategy on Bitfinex, run as a persistent
// Render background worker instead of Trigger.dev's 1-min-cron + 50s-WS-burst pattern. Point of
// this: true continuous tick coverage (no ~10s/min dark gap), so live results track the
// backtest more closely.
//
// REAL MONEY (converted 2026-09-03): was paper-only, now places real EXCHANGE MARKET orders on
// Bitfinex via lib/bitfinex-auth.ts. $20 seed, compounds. Confirmed via direct test trades that
// this account has zero taker fees on both tUSTUSD and tSOLUSD — the whole reason Bitfinex was
// chosen. Reuses the same sol_trail_continuous_* tables/dashboard panel as the paper version
// that ran earlier this session — this file was converted in place, not duplicated, per explicit
// user instruction.
//
// Strategy (verified via backtest this session): no entry filter, instant re-entry the moment
// flat; continuous trailing stop at SL_PCT below the peak price since entry, ratchets up only,
// never loosens; no take-profit ceiling; no cooldown. The WS trade-tick feed is used to DECIDE
// when to buy/sell (worst-case-consistent: ask-adjusted for entry timing, bid-adjusted for
// peak/stop timing, matching the original backtest methodology) — but the price and quantity
// actually RECORDED for entry_price/exit_price come from the real Bitfinex fill, not the
// estimate, so realized P&L is ground truth.
//
// SINGLE-INSTANCE GUARANTEE: critical now more than ever — a duplicate instance here would place
// duplicate real orders. Claims a lock row (lock_owner/lock_heartbeat) on startup and refuses to
// trade if another instance's heartbeat is still fresh. Releases the lock cleanly on shutdown.
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

const SYMBOL          = "tSOLUSD";
const SL_PCT          = 0.1;
const SEED_USD        = 20;
const HALF_SPREAD_PCT = 0.0117; // real measured Bitfinex SOLUSD half-spread — used only to DECIDE timing
const HEARTBEAT_MS    = 10_000;
const LOCK_STALE_MS   = 30_000; // 3 missed heartbeats = assume dead, safe to take over
const DB_WRITE_THROTTLE_MS = 2_000; // don't write peak/stop to DB on every tick
const RUN_LOG_INTERVAL_MS  = 5 * 60_000; // heartbeat-style status row, not per-tick

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

function entryFill(price: number): number { return price * (1 + HALF_SPREAD_PCT / 100); } // ask-adjusted, timing only
function exitFill(price: number): number { return price * (1 - HALF_SPREAD_PCT / 100); }  // bid-adjusted, timing only

let state: SolTrailContinuousState;
let lastDbWrite = 0;
let lastRunLog = 0;
let ticksSinceLastLog = 0;
let reconnectDelayMs = 1_000;
let orderInFlight = false; // hard guard against re-entering while an order is still being placed/confirmed

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
  if (!state.enabled || orderInFlight) return;

  if (state.mode === "USD") {
    // Instant re-entry the moment flat — no candle cadence, no filter.
    const effEntry = entryFill(price);
    if (effEntry <= 0) return; // sanity guard, never actually happens
    orderInFlight = true;
    try {
      const targetPool = SEED_USD + (state.realized_pnl_usd ?? 0);
      const estQty = targetPool / effEntry;
      console.log(`BUY signal @ est=${effEntry.toFixed(4)} qty~=${estQty.toFixed(4)} — submitting real order...`);
      const fill = await submitMarketOrder(SYMBOL, estQty);
      const patch = {
        mode: "SOL" as const, sol_quantity: fill.execAmount, entry_price: fill.execPrice,
        entry_time: new Date().toISOString(), usd_balance: 0,
        peak_price: fill.execPrice, stop_price: fill.execPrice * (1 - SL_PCT / 100),
      };
      state = { ...state, ...patch };
      await updateSolTrailContinuousState(patch);
      lastDbWrite = Date.now();
      console.log(`BUY FILLED price=${fill.execPrice.toFixed(4)} qty=${fill.execAmount.toFixed(4)} fee=${fill.fee}`);
      await logSolTrailContinuousRun({ actions: [{ action: "BUY", price: fill.execPrice, qty: fill.execAmount, orderId: fill.orderId }] });
      lastRunLog = Date.now();
    } catch (err) {
      console.error("BUY order failed:", err);
      await logSolTrailContinuousRun({ actions: [{ action: "ERROR", stage: "buy", error: String(err) }] });
    } finally {
      orderInFlight = false;
    }
    return;
  }

  // mode === "SOL": track peak, check stop, both on the worst-case (bid-adjusted) price —
  // this only decides WHEN to sell; the recorded exit price comes from the real fill.
  const effSell = exitFill(price);
  const peak = state.peak_price ?? state.entry_price!;
  const stop = state.stop_price ?? peak * (1 - SL_PCT / 100);

  if (effSell <= stop) {
    orderInFlight = true;
    try {
      const origEntryPrice = state.entry_price!;
      const origSolQty = state.sol_quantity!;
      const origEntryTime = state.entry_time!;
      console.log(`STOP signal, selling ${origSolQty.toFixed(4)} SOL — submitting real order...`);
      const fill = await submitMarketOrder(SYMBOL, -origSolQty);
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
      actions: [{ action: "STATUS", mode: state.mode, price, peak: state.peak_price, stop: state.stop_price, ticksSinceLastLog }],
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

  console.log(`Starting LIVE continuous trail worker (${INSTANCE_ID}), enabled=${state.enabled}, mode=${state.mode}`);
  console.log(`REAL MONEY — placing actual orders on ${SYMBOL}. Seed $${SEED_USD}, compounding.`);
  connect();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
