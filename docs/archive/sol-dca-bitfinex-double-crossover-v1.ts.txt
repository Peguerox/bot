// PAPER TRADING — SOL double-crossover controller, Worker 1 (replaces the old VWAP+EMA DCA grid
// entirely -- filename/service kept for Render compatibility, internals are a completely
// different strategy). No real orders, no real money.
//
// Continuous variable-exposure strategy, NOT a DCA grid: holds a target % of account equity in
// SOL (0% to ~53%), driven by two hard trend crossovers (direction) and one soft acceleration
// gate (intensity) -- see lib/sol-double-crossover-config.ts for the exact formula and
// docs/adaptive_exposure_family.md for the full research trail. Won a final $1,000/2yr/quarterly
// bake-off against the deployed DCA grid (Worker 2) and four other adaptive-family variants
// (+24.64% vs the grid's +23.24%), at the cost of ~36x the trade count -- that tradeoff is why
// this runs as paper, not real money, until it proves itself live the way Worker 2 did.
//
// EXECUTION: schedule a rebalance when the live weight drifts from the target beyond a deadband,
// at a completed-minute close; execute at the next minute's open -- same 1-bar-delay convention
// as every backtest in this research line. Orders capped at 0.5% of equity, skipped below
// Bitfinex's real confirmed SOLUSD minimum (0.02 SOL, ~$2 -- see lib/sol-double-crossover-config.ts
// for how that was confirmed, it is NOT the $10-25 an earlier report assumed).
//
// EMA SEEDING: on first boot only, pulls ~45 days of real Bitfinex 1-min history and runs the
// exact EMA recursion across it before going live -- a 7-day half-life EMA started flat would
// misprice every signal for most of a week. Subsequent restarts resume from DB-persisted EMA
// state (the recursion generalizes cleanly to an irregular gap -- downtime is just one larger
// step, not a discontinuity).
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import os from "os";
import crypto from "crypto";
import {
  getSolDoubleCrossoverState, updateSolDoubleCrossoverState, recordSolDoubleCrossoverTrade,
  logSolDoubleCrossoverRun, type SolDoubleCrossoverState,
} from "../lib/sol-double-crossover-db";
import {
  stepEmaState, targetFraction, type EmaState,
  BFX_SYMBOL, SEED_USD, DEADBAND_MULT, ORDER_CAP_FRAC, MIN_NOTIONAL_FRAC, REAL_MIN_SOL_UNITS,
  ADVERSE_COST_PER_SIDE, SEED_HISTORY_DAYS,
} from "../lib/sol-double-crossover-config";
import { connectPublicBook, getBookBidAsk, isBookReady, bookMessageAge } from "../lib/bitfinex-trading-ws";

const HEARTBEAT_MS = 10_000;
const LOCK_STALE_MS = 15_000; // 1.5x heartbeat -- see the Render redeploy crash-loop incident on earlier workers
const DB_WRITE_THROTTLE_MS = 2_000;
const RUN_LOG_INTERVAL_MS = 5 * 60_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const BOOK_STALE_MS = 15_000;

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

let state: SolDoubleCrossoverState;
let emaState: EmaState;
let currentMinuteFloor: number | null = null;
let pendingTarget: number | null = null;
let lastDbWrite = 0;
let lastRunLog = 0;
let processing = false;

async function acquireLock(): Promise<boolean> {
  state = await getSolDoubleCrossoverState();
  const heartbeatAge = state.lock_heartbeat ? Date.now() - new Date(state.lock_heartbeat).getTime() : Infinity;
  if (state.lock_owner && heartbeatAge < LOCK_STALE_MS) {
    console.error(`Refusing to start: lock held by ${state.lock_owner}, last heartbeat ${heartbeatAge}ms ago`);
    return false;
  }
  await updateSolDoubleCrossoverState({ lock_owner: INSTANCE_ID, lock_heartbeat: new Date().toISOString() });
  console.log(`Lock acquired as ${INSTANCE_ID}`);
  return true;
}

async function releaseLock() {
  try {
    const fresh = await getSolDoubleCrossoverState();
    if (fresh.lock_owner === INSTANCE_ID) {
      await updateSolDoubleCrossoverState({ lock_owner: null, lock_heartbeat: null });
      console.log("Lock released cleanly.");
    }
  } catch (err) { console.error("releaseLock failed:", err); }
}

async function heartbeat() {
  const fresh = await getSolDoubleCrossoverState();
  if (fresh.lock_owner !== INSTANCE_ID) {
    console.error(`Lost lock to ${fresh.lock_owner} — another instance took over. Exiting.`);
    process.exit(1);
  }
  if (!processing) {
    state = fresh;
  } else {
    state = { ...state, enabled: fresh.enabled };
  }
  await updateSolDoubleCrossoverState({ lock_heartbeat: new Date().toISOString() });
}

// ---------- One-time EMA seeding from real history ----------

async function fetchSeedCandles(days: number): Promise<{ time: number; close: number }[]> {
  const endMs = Date.now();
  const startMs = endMs - days * 86_400_000;
  const all: { time: number; close: number }[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `https://api-pub.bitfinex.com/v2/candles/trade:1m:${BFX_SYMBOL}/hist?start=${cursor}&end=${endMs}&limit=10000&sort=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Bitfinex seed fetch failed: ${res.status}`);
    const raw = await res.json() as number[][];
    if (raw.length === 0) break;
    for (const c of raw) all.push({ time: c[0], close: c[2] });
    const newest = raw[raw.length - 1][0];
    if (raw.length < 10000) break;
    cursor = newest + 1;
    await new Promise((r) => setTimeout(r, 300));
  }
  return all;
}

async function seedEmaFromHistory(): Promise<EmaState> {
  console.log(`Seeding EMAs from ${SEED_HISTORY_DAYS} days of real Bitfinex history...`);
  const candles = await fetchSeedCandles(SEED_HISTORY_DAYS);
  if (candles.length === 0) throw new Error("No seed candles returned");
  let s: EmaState = {
    ema360: candles[0].close, ema4320: candles[0].close,
    ema1440: candles[0].close, ema10080: candles[0].close, rBar: 0,
  };
  for (let i = 1; i < candles.length; i++) {
    const dtMin = (candles[i].time - candles[i - 1].time) / 60_000;
    s = stepEmaState(s, candles[i].close, dtMin);
  }
  const lastTs = candles[candles.length - 1].time;
  console.log(`Seeded from ${candles.length} candles, ${new Date(candles[0].time).toISOString()} -> ${new Date(lastTs).toISOString()}`);
  await updateSolDoubleCrossoverState({
    ema_360: s.ema360, ema_4320: s.ema4320, ema_1440: s.ema1440, ema_10080: s.ema10080,
    r_bar: s.rBar, seeded: true, last_minute_ts: new Date(lastTs).toISOString(),
  });
  return s;
}

// ---------- Execution ----------

async function executeRebalance(target: number, price: number) {
  const C = state.cash;
  const Q = state.sol_qty;
  const s = ADVERSE_COST_PER_SIDE;
  const V = Q * price * (1 - s);
  const E = C + V;
  const k = (1 - s) / (1 + s);

  if (V < target * E) {
    const denom = k + target * (1 - k);
    const spend = Math.min(C, ORDER_CAP_FRAC * E, denom > 0 ? (target * E - V) / denom : 0);
    if (spend < MIN_NOTIONAL_FRAC * SEED_USD || spend <= 0) return;
    const buyPx = price * (1 + s);
    const qty = spend / buyPx;
    if (qty < REAL_MIN_SOL_UNITS) { console.log(`Rebalance buy skipped: ${qty.toFixed(6)} SOL below real exchange minimum (${REAL_MIN_SOL_UNITS})`); return; }
    const newQty = Q + qty;
    const newAvgCost = ((state.avg_cost ?? buyPx) * Q + spend) / newQty;
    state = { ...state, cash: C - spend, sol_qty: newQty, avg_cost: newAvgCost };
    await updateSolDoubleCrossoverState({ cash: state.cash, sol_qty: state.sol_qty, avg_cost: state.avg_cost });
    await recordSolDoubleCrossoverTrade({ side: "buy", price: buyPx, qty, usd_amount: spend, pnl_usd: null });
    console.log(`BUY ${qty.toFixed(6)} SOL @ ${buyPx.toFixed(4)} ($${spend.toFixed(2)}) -> weight target=${(target * 100).toFixed(1)}%`);
  } else if (V > target * E) {
    const proceeds = Math.min(V, ORDER_CAP_FRAC * E, V - target * E);
    if (proceeds < MIN_NOTIONAL_FRAC * SEED_USD || proceeds <= 0) return;
    const sellPx = price * (1 - s);
    let qty = proceeds / sellPx;
    qty = Math.min(qty, Q);
    if (qty < REAL_MIN_SOL_UNITS) { console.log(`Rebalance sell skipped: ${qty.toFixed(6)} SOL below real exchange minimum (${REAL_MIN_SOL_UNITS})`); return; }
    const realProceeds = qty * sellPx;
    const pnl = realProceeds - qty * (state.avg_cost ?? sellPx);
    state = { ...state, cash: C + realProceeds, sol_qty: Q - qty };
    await updateSolDoubleCrossoverState({ cash: state.cash, sol_qty: state.sol_qty });
    await recordSolDoubleCrossoverTrade({ side: "sell", price: sellPx, qty, usd_amount: realProceeds, pnl_usd: pnl });
    console.log(`SELL ${qty.toFixed(6)} SOL @ ${sellPx.toFixed(4)} ($${realProceeds.toFixed(2)}) pnl=${pnl.toFixed(4)} -> weight target=${(target * 100).toFixed(1)}%`);
  }
  lastDbWrite = Date.now();
}

// ---------- Minute-boundary driven signal + schedule ----------

async function onMinuteBoundary(price: number, dtMin: number) {
  // 1. execute any order scheduled at the previous minute's close, using this minute's open
  if (pendingTarget !== null) {
    await executeRebalance(pendingTarget, price);
    pendingTarget = null;
  }

  // 2. update EMA state with this (just-completed) minute's close
  emaState = stepEmaState(emaState, price, dtMin);
  await updateSolDoubleCrossoverState({
    ema_360: emaState.ema360, ema_4320: emaState.ema4320, ema_1440: emaState.ema1440,
    ema_10080: emaState.ema10080, r_bar: emaState.rBar, last_minute_ts: new Date().toISOString(),
  });

  // 3. compute new target, schedule a rebalance if weight has drifted beyond the deadband
  const f = targetFraction(emaState);
  const E = state.cash + state.sol_qty * price * (1 - ADVERSE_COST_PER_SIDE);
  const w = E > 0 ? (state.sol_qty * price * (1 - ADVERSE_COST_PER_SIDE)) / E : 0;
  const scheduled = Math.abs(w - f) > DEADBAND_MULT * f * (1 - f);
  if (scheduled) pendingTarget = f;

  if (Date.now() - lastRunLog > RUN_LOG_INTERVAL_MS) {
    console.log(`STATUS price=${price.toFixed(4)} target=${(f * 100).toFixed(2)}% weight=${(w * 100).toFixed(2)}% equity=$${E.toFixed(2)} scheduled=${scheduled}`);
    await logSolDoubleCrossoverRun({ actions: [{ action: "STATUS", price, target: f, weight: w, equity: E, scheduled }] });
    lastRunLog = Date.now();
  }
}

async function onBookUpdate() {
  if (!state.enabled || processing) return;
  const { bid, ask } = getBookBidAsk();
  if (bid === null || ask === null) return;
  const price = (bid + ask) / 2;

  const nowMinuteFloor = Math.floor(Date.now() / 60_000);
  if (currentMinuteFloor === null) { currentMinuteFloor = nowMinuteFloor; return; }
  if (nowMinuteFloor <= currentMinuteFloor) return;

  processing = true;
  try {
    const dtMin = nowMinuteFloor - currentMinuteFloor;
    currentMinuteFloor = nowMinuteFloor;
    await onMinuteBoundary(price, dtMin);
  } catch (err) {
    console.error("onMinuteBoundary error:", err);
    await logSolDoubleCrossoverRun({ actions: [{ action: "ERROR", stage: "onMinuteBoundary", error: String(err) }] }).catch(() => {});
  } finally {
    processing = false;
  }
}

function startWatchdog() {
  setInterval(() => {
    const staleMs = bookMessageAge();
    if (staleMs >= BOOK_STALE_MS) {
      console.error(`Watchdog: order book feed silent for ${Math.round(staleMs / 1000)}s.`);
    }
  }, WATCHDOG_INTERVAL_MS);
}

async function main() {
  const got = await acquireLock();
  if (!got) process.exit(1);

  if (!state.seeded) {
    emaState = await seedEmaFromHistory();
    state = await getSolDoubleCrossoverState();
  } else {
    emaState = {
      ema360: state.ema_360!, ema4320: state.ema_4320!, ema1440: state.ema_1440!,
      ema10080: state.ema_10080!, rBar: state.r_bar!,
    };
    console.log(`Resuming EMA state from DB (last_minute_ts=${state.last_minute_ts})`);
  }

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

  console.log(`Starting SOL Double-Crossover PAPER worker (${INSTANCE_ID}), enabled=${state.enabled}, cash=$${state.cash.toFixed(2)}, sol=${state.sol_qty.toFixed(6)}`);
  console.log(`PAPER ONLY — no real orders. Hard T/L crossovers + soft acceleration gate, target range [0, 53%], $${SEED_USD} seed, real bid/ask fills from Bitfinex's live book.`);
  connectPublicBook(BFX_SYMBOL, () => { onBookUpdate().catch((err) => console.error("onBookUpdate error:", err)); });
  startWatchdog();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
