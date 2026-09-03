// REAL MONEY — converted 2026-09-03 from the single-venue Binance-jump strategy to the
// exact-zero cross-venue gap strategy (the one proven out on the paper bot,
// server/jump-trail-bitfinex.ts). The single-venue jump signal (0.02→0.01→0.02→0.03% tried)
// kept getting killed by real order slippage on Bitfinex's thin SOL/USD book — see the
// -0.43% anomalous-fill investigation. Moving to the more promising paper result instead.
//
// SIGNAL: continuously compare Binance's real ask (bookTicker) to Bitfinex's real ask
// (ticker channel). Enter LONG on Bitfinex the instant the gap is EXACTLY zero
// (gapPct === 0, no tolerance band — confirmed via a real frequency check that the gap moves
// in discrete steps, so exact equality is achievable, not absurdly strict). Long-only (spot
// can't short without margin).
//
// SETTINGS: two-stage trail, no TP. Stop starts at 0.1% below entry; once a new peak is set,
// the trail tightens to 0.05% below the new peak (backtested on paper trade tick data
// 2026-09-03 — beat both a flat 0.1% trail and a 0.1% TP on every trade in the sample, small
// n though). Seed $20 (real money; paper bot uses $100 for its own tracking, still on a flat
// 0.1% trail off bid — this live bot has diverged from the paper bot's exact settings).
//
// REAL MONEY MECHANICS: entry sizes off Bitfinex's real ask. Peak-tracking and the stop trigger
// switched from bid to ask 2026-09-03 per user request (was bid, "getting out late" concern) —
// both come from the "ticker" WS channel (true bid/ask), not an estimate. Actual sell proceeds
// still come from whatever the real market order fills at (near bid), regardless of which price
// triggers the decision — this change only affects trigger timing, not received amount.
//
// LATENCY FIX TRIED THEN REVERTED 2026-09-03: briefly removed the serialized queue on the
// Bitfinex ticker handler (calling onBfxTicker directly, fire-and-forget) to stop order
// submission from blocking subsequent price ticks. That version was live for all three
// real-money freeze incidents that day (position enters fine, then zero further ticks/peak
// updates ever again, heartbeat still fresh) — root mechanism never conclusively proven, but
// it's the only change in that window that touches how price messages get dispatched, and the
// bot ran fine for hours before it existed. Reverted back to the serialized queue as the
// higher-priority fix; the unconfirmed latency benefit isn't worth the repeat real losses.
//
// SINGLE-INSTANCE GUARANTEE: critical with real orders — claims a lock row (lock_owner/
// lock_heartbeat) on startup, refuses to trade if another instance's heartbeat is fresh, releases
// the lock cleanly on shutdown.
//
// INFRA NOTE: needs BOTH a Binance WS connection (signal) and a Bitfinex WS connection
// (signal + execution). Binance's global WS feed returns HTTP 451 from Render's US regions —
// this service must run in a non-US region (Frankfurt/Singapore).
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import WebSocket from "ws";
import os from "os";
import crypto from "crypto";
import {
  getSolTrailContinuousState, updateSolTrailContinuousState, recordSolTrailContinuousTrade,
  logSolTrailContinuousRun, recordSolTrailContinuousTick, type SolTrailContinuousState,
} from "../lib/sol-trail-continuous-db";
import { submitMarketOrder } from "../lib/bitfinex-auth";

const BFX_SYMBOL       = "tSOLUSD";
const INIT_SL_PCT      = 0.1;    // initial stop distance from entry, until the first new peak is set
const TIGHT_SL_PCT     = 0.05;   // tightened trail distance once a new peak (profit) is set — backtested on paper trade tick data 2026-09-03, beat both the flat 0.1% trail and a 0.1% TP
const SEED_USD         = 20;
const HEARTBEAT_MS     = 10_000;
const LOCK_STALE_MS    = 30_000;
const DB_WRITE_THROTTLE_MS = 2_000;
const RUN_LOG_INTERVAL_MS  = 5 * 60_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const BFX_STALE_MS         = 15_000; // no message at all (incl. heartbeats) on the Bitfinex WS for this long -> force reconnect
const BFX_EMERGENCY_MS     = 25_000; // still stale this long while holding SOL -> emergency flatten via REST, independent of the (likely dead) WS

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

let state: SolTrailContinuousState;
let lastBfxMessageTime = Date.now();
let bfxWs: WebSocket | null = null;
let emergencyInProgress = false;
let lastDbWrite = 0;
let lastRunLog = 0;
let orderInFlight = false;
let binanceAsk: number | null = null;
let bfxBid: number | null = null;
let bfxAsk: number | null = null;
let currentTradeGapPct: number | null = null;

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

async function checkEntry() {
  if (!state.enabled || state.mode !== "USD" || orderInFlight || binanceAsk === null || bfxAsk === null) return;
  const gapPct = (binanceAsk - bfxAsk) / bfxAsk * 100;
  if (gapPct !== 0) return;

  orderInFlight = true;
  try {
    const targetPool = SEED_USD + (state.realized_pnl_usd ?? 0);
    const estQty = targetPool / bfxAsk; // real live ask, no estimate
    console.log(`BUY signal (gap=${gapPct.toFixed(4)}%) @ ask=${bfxAsk.toFixed(4)} qty~=${estQty.toFixed(4)} — submitting real order...`);
    const fill = await submitMarketOrder(BFX_SYMBOL, estQty);
    currentTradeGapPct = gapPct;
    const patch = {
      mode: "SOL" as const, sol_quantity: fill.execAmount, entry_price: fill.execPrice,
      entry_time: new Date().toISOString(), usd_balance: 0,
      peak_price: fill.execPrice, stop_price: fill.execPrice * (1 - INIT_SL_PCT / 100),
    };
    state = { ...state, ...patch };
    await updateSolTrailContinuousState(patch);
    lastDbWrite = Date.now();
    console.log(`BUY FILLED price=${fill.execPrice.toFixed(4)} qty=${fill.execAmount.toFixed(4)} fee=${fill.fee}`);
    await logSolTrailContinuousRun({ actions: [{ action: "BUY", price: fill.execPrice, qty: fill.execAmount, orderId: fill.orderId, gapPct }] });
    lastRunLog = Date.now();
  } catch (err) {
    console.error("BUY order failed:", err);
    await logSolTrailContinuousRun({ actions: [{ action: "ERROR", stage: "buy", error: String(err) }] });
  } finally {
    orderInFlight = false;
  }
}

let tickCount = 0;
let lastTickLogAt = 0;

async function onBfxTicker(bid: number, ask: number) {
  bfxBid = bid;
  bfxAsk = ask;
  tickCount++;
  // Diagnostic 2026-09-03: unconditional, fires before any other check, to directly prove
  // whether onBfxTicker keeps executing after entry (three real positions froze with zero
  // ticks recorded and no clear mechanism found in code review — this replaces guessing with
  // direct evidence). Throttled to avoid spamming the runs table.
  if (Date.now() - lastTickLogAt > 10_000) {
    lastTickLogAt = Date.now();
    logSolTrailContinuousRun({ actions: [{ action: "DIAG", tickCount, mode: state.mode, bid, ask, orderInFlight, enabled: state.enabled }] }).catch(() => {});
  }
  if (!state.enabled || orderInFlight) return;

  if (state.mode !== "SOL") {
    await checkEntry();
    return;
  }

  recordSolTrailContinuousTick(state.entry_time!, bid, ask).catch((err) => console.error("recordTick error:", err));

  const effSell = ask; // switched from bid to ask 2026-09-03 per user request — peak-tracking and stop trigger now follow Bitfinex's real ask, not bid. Real order fill/proceeds are still whatever the market sell actually executes at (near bid), this only changes the trigger timing.
  const peak = state.peak_price ?? state.entry_price!;
  const stop = state.stop_price ?? peak * (1 - INIT_SL_PCT / 100);

  if (effSell <= stop) {
    orderInFlight = true;
    try {
      const origEntryPrice = state.entry_price!;
      const origSolQty = state.sol_quantity!;
      const origEntryTime = state.entry_time!;
      const gapPct = currentTradeGapPct ?? 0;
      currentTradeGapPct = null;
      console.log(`STOP signal, selling ${origSolQty.toFixed(4)} SOL — submitting real order...`);
      const fill = await submitMarketOrder(BFX_SYMBOL, -origSolQty);
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
      await logSolTrailContinuousRun({ actions: [{ action: "STOP_FILLED", price: fill.execPrice, pnlUsd, pnlPct, orderId: fill.orderId, gapPct }] });
      lastRunLog = Date.now();
    } catch (err) {
      console.error("SELL order failed:", err);
      await logSolTrailContinuousRun({ actions: [{ action: "ERROR", stage: "sell", error: String(err) }] });
    } finally {
      orderInFlight = false;
    }
    return;
  } else if (effSell > peak) {
    state = { ...state, peak_price: effSell, stop_price: effSell * (1 - TIGHT_SL_PCT / 100) };
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
    // Liveness signal only counts an actual parsed ticker update, NOT any raw message or "hb"
    // frame — a socket that stays open and sends heartbeats while the subscription silently
    // stops delivering real ticker data would otherwise look "alive" and defeat the watchdog.
    // This was the second version of the same bug: first the lock heartbeat proved the process
    // was alive but not that price data was flowing; this fixes the watchdog itself having the
    // identical blind spot at a different layer.
    lastBfxMessageTime = Date.now();
    // REVERTED 2026-09-03: back to a serialized queue. The fire-and-forget version (direct call,
    // no queue) was live for every one of the three real-money freeze incidents; before that
    // change existed, this bot ran fine for hours. Never proved the exact mechanism, but it's
    // the only change in that stretch that touches how price messages get dispatched at all, so
    // reverting it takes priority over the unconfirmed latency-improvement theory.
    queue = queue.then(() => onBfxTicker(bid, ask)).catch((err) => console.error("onBfxTicker error:", err));
  });

  ws.on("error", (err) => console.error("Bitfinex WS error:", err));
  ws.on("close", () => { console.log("Bitfinex WS closed, reconnecting in 2s..."); setTimeout(connectBitfinex, 2000); });
  return ws;
}

// Emergency backstop added 2026-09-03 after a real position sat unmanaged for ~30 minutes: the
// Bitfinex WS went silent (no close/error event, just stopped delivering messages) and nothing
// detected it — the lock heartbeat only proves the process is alive, not that price data is
// flowing. Real price kept falling well past the stop while peak/stop_price never updated.
// This flattens via a real order using a freshly-fetched REST price, fully independent of
// whatever state the (possibly dead) WS is in, then exits so Render restarts a clean process.
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
    const fill = await submitMarketOrder(BFX_SYMBOL, -fresh.sol_quantity);
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
    process.exit(1); // exit regardless of outcome so Render restarts with a clean process/WS
  }
}

function startWatchdog() {
  setInterval(() => {
    const staleMs = Date.now() - lastBfxMessageTime;
    if (staleMs < BFX_STALE_MS) return;

    if (state.mode === "SOL" && staleMs >= BFX_EMERGENCY_MS && !emergencyInProgress) {
      emergencyFlatten(`Bitfinex WS silent for ${Math.round(staleMs / 1000)}s while holding SOL`)
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

  console.log(`Starting LIVE Jump Trail worker (${INSTANCE_ID}), enabled=${state.enabled}, mode=${state.mode}`);
  console.log(`REAL MONEY — signal: Binance ask - Bitfinex ask == exactly 0. Seed $${SEED_USD}, compounding, SL=${INIT_SL_PCT}% init / ${TIGHT_SL_PCT}% chase.`);
  connectBinance();
  connectBitfinex();
  startWatchdog();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
