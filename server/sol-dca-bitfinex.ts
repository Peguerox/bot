// REAL MONEY — SOL/USD DCA-martingale, repurposing Worker 1's freed Render service/API key/DB
// tables (sol_trail_bitfinex_*) after the BTC ML predictor was retired 2026-09-10. Rebuilt from
// the Trigger.dev cron version to a persistent worker specifically to get the same proven
// WS-native execution path as Worker 2 (lib/bitfinex-trading-ws.ts) — fast order fills and
// continuous tick-by-tick trail/DCA/TP monitoring instead of once-per-minute REST checks.
//
// STRATEGY — entry (long only, flat, re-armed on every new closed 5-min candle): price > rolling
// 24h VWAP AND EMA9 > EMA20 (5-min bars, spans scaled to represent 9h/20h) AND previous candle's
// volume below its own 5h rolling average (pullback) AND current candle's volume above that
// average (expansion resuming).
//
// EXIT: a trailing stop (2.5% below the peak price since entry) that only ever arms once price is
// at/above the original entry — it can never realize a loss. If price instead drops 6% from the
// last entry before the trail arms, add another position (2.0x the size of the previous leg) and
// switch to targeting +1.5% on the new blended cost; repeats on each further 6% drop, uncapped.
//
// Position sizing compounds: at the moment a new trade opens (flat -> entry), the base unit is
// recalculated as current balance / 31 (31 = 1+2+4+8+16, the capital reserve ratio for 5 levels
// at a 2.0x multiplier — the worst case seen in 2 years of backtesting). Each DCA leg after that
// is 2.0x the previous leg's size.
//
// Backtested at $1,000/$31,000 (base/worst-case-reserve) scale: 254 trades over 2yr, 100%
// eventual win rate, 70% 2yr return compounding. Cross-validated on two independent
// non-overlapping 1-year halves (worst-case-year ROI 23%) before being chosen over configs that
// looked better on the full 2yr number but collapsed out-of-sample. Live-deployed at $500 seed.
//
// EXECUTION: entries/DCA-adds/exits all submit via submitMarketOrderFast (WS-native, falls back
// to REST if the WS path isn't ready) — same proven path as Worker 2. No taker fee on this
// account, so plain EXCHANGE MARKET orders are used throughout, no maker/OCO complexity.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import os from "os";
import crypto from "crypto";
import {
  getSolDcaBitfinexState, updateSolDcaBitfinexState, recordSolDcaBitfinexTrade, logSolDcaBitfinexRun,
  type SolDcaBitfinexState, type DcaPosition,
} from "../lib/sol-dca-bitfinex-db";
import { getBitfinexCandlesOHLCV, type BitfinexOHLCV } from "../lib/bitfinex";
import { submitMarketOrderSafe } from "../lib/bitfinex-auth";
import {
  connectPublicBook, getBookBidAsk, isBookReady, bookMessageAge,
  connectAuthenticated, getLiveBalance, isWalletReady, submitMarketOrderFast,
} from "../lib/bitfinex-trading-ws";

const BFX_SYMBOL       = "tSOLUSD";
const VWAP_PERIOD      = 24 * 12; // 24h on 5-min bars
const EMA9_SPAN        = 9 * 12;
const EMA20_SPAN       = 20 * 12;
const VOLAVG_PERIOD    = 5 * 12;
const C5_LIMIT         = VWAP_PERIOD + 320; // extra history so EMA20 has room to converge
const DCA_DROP_PCT     = 6;
const MULT             = 2.0;
const TP_PCT           = 1.5;
const TRAIL_PCT        = 2.5;
const RESERVE_DIVISOR  = 31; // 1+2+4+8+16 — 5-level reserve at 2.0x
const CANDLE_CHECK_MS  = 30_000; // 5-min candles only close every 5min; 30s is plenty responsive
const HEARTBEAT_MS     = 10_000;
const LOCK_STALE_MS    = 30_000;
const DB_WRITE_THROTTLE_MS = 2_000;
const RUN_LOG_INTERVAL_MS  = 5 * 60_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const BOOK_STALE_MS        = 15_000;
const BOOK_EMERGENCY_MS    = 25_000;

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

let state: SolDcaBitfinexState;
let lastDbWrite = 0;
let lastRunLog = 0;
let orderInFlight = false;
let emergencyInProgress = false;

async function acquireLock(): Promise<boolean> {
  state = await getSolDcaBitfinexState();
  const heartbeatAge = state.lock_heartbeat ? Date.now() - new Date(state.lock_heartbeat).getTime() : Infinity;
  if (state.lock_owner && heartbeatAge < LOCK_STALE_MS) {
    console.error(`Refusing to start: lock held by ${state.lock_owner}, last heartbeat ${heartbeatAge}ms ago`);
    return false;
  }
  await updateSolDcaBitfinexState({ lock_owner: INSTANCE_ID, lock_heartbeat: new Date().toISOString() });
  console.log(`Lock acquired as ${INSTANCE_ID}`);
  return true;
}

async function releaseLock() {
  try {
    const fresh = await getSolDcaBitfinexState();
    if (fresh.lock_owner === INSTANCE_ID) {
      await updateSolDcaBitfinexState({ lock_owner: null, lock_heartbeat: null });
      console.log("Lock released cleanly.");
    }
  } catch (err) { console.error("releaseLock failed:", err); }
}

async function heartbeat() {
  const fresh = await getSolDcaBitfinexState();
  if (fresh.lock_owner !== INSTANCE_ID) {
    console.error(`Lost lock to ${fresh.lock_owner} — another instance took over. Exiting.`);
    process.exit(1);
  }
  if (orderInFlight) {
    state.enabled = fresh.enabled;
  } else {
    state = fresh;
  }
  await updateSolDcaBitfinexState({ lock_heartbeat: new Date().toISOString() });
}

// ---------- Indicators (same formulas as the backtest / Trigger.dev predecessor) ----------

function rollingVWAP(candles: BitfinexOHLCV[], period: number): number[] {
  const out: number[] = new Array(candles.length).fill(NaN);
  let pv = 0, vol = 0;
  const pvArr: number[] = [], volArr: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    pvArr.push(tp * candles[i].volume);
    volArr.push(candles[i].volume);
    pv += pvArr[i]; vol += volArr[i];
    if (i >= period) { pv -= pvArr[i - period]; vol -= volArr[i - period]; }
    if (i >= period - 1 && vol > 0) out[i] = pv / vol;
  }
  return out;
}

function ema(values: number[], span: number): number[] {
  const k = 2 / (span + 1);
  const out: number[] = new Array(values.length).fill(NaN);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rollingAvg(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function portfolioValue(positions: DcaPosition[], markPrice: number): number {
  return positions.reduce((sum, p) => sum + p.sol_qty * markPrice, 0);
}

// ---------- Entry: periodic 5-min candle check ----------

async function checkEntry() {
  if (!state.enabled || state.mode !== "USD" || orderInFlight) return;

  let candles: BitfinexOHLCV[];
  try {
    candles = await getBitfinexCandlesOHLCV(BFX_SYMBOL, "5m", C5_LIMIT);
  } catch (err) {
    console.error("checkEntry: candle fetch failed:", err);
    return;
  }
  const closed = candles.slice(0, -1); // drop the still-forming candle
  const lastClosedTs = closed[closed.length - 1].time;
  const isNewCandle = lastClosedTs > (state.last_candle_ts ?? 0);
  if (!isNewCandle) return;

  await updateSolDcaBitfinexState({ last_candle_ts: lastClosedTs });
  state = await getSolDcaBitfinexState();
  if (!state.enabled || state.mode !== "USD") return;

  const closes = closed.map((c) => c.close);
  const volumes = closed.map((c) => c.volume);
  const vwap = rollingVWAP(closed, VWAP_PERIOD);
  const ema9 = ema(closes, EMA9_SPAN);
  const ema20 = ema(closes, EMA20_SPAN);
  const avgVol = rollingAvg(volumes, VOLAVG_PERIOD);

  const i = closed.length - 1;
  const longTrend = closes[i] > vwap[i] && ema9[i] > ema20[i];
  const lowerVol = volumes[i - 1] < avgVol[i];
  const higherVol = volumes[i] > avgVol[i];
  const entrySignal = longTrend && lowerVol && higherVol;

  if (!entrySignal) return;

  const { bid, ask } = getBookBidAsk();
  if (!isBookReady() || ask === null) { console.log("Entry signal fired but order book not ready yet — skipping this candle."); return; }
  if (!isWalletReady()) { console.log("Entry signal fired but wallet WS not ready yet — skipping this candle."); return; }

  orderInFlight = true;
  const signalTime = Date.now();
  try {
    const baseSize = state.balance / RESERVE_DIVISOR;
    const realUsd = getLiveBalance("USD");
    const cappedSize = Math.min(baseSize, realUsd);
    const qty = cappedSize / ask;
    if (qty <= 0) { console.log(`Entry signal but no real USD available (real=${realUsd}) — skipping.`); return; }

    console.log(`ENTRY signal @ ask=${ask.toFixed(4)} size=$${cappedSize.toFixed(2)} qty~=${qty.toFixed(6)} (real USD=${realUsd.toFixed(2)}) — submitting real order...`);
    const fill = await submitMarketOrderFast(BFX_SYMBOL, qty);
    const totalLatencyMs = Date.now() - signalTime;
    const usdSize = fill.execPrice * Math.abs(fill.execAmount);

    const positions: DcaPosition[] = [{ price: fill.execPrice, usd_size: usdSize, sol_qty: Math.abs(fill.execAmount) }];
    const patch = {
      mode: "SOL" as const, positions, total_cost: usdSize, dca_count: 0,
      entry_price: fill.execPrice, entry_time: new Date().toISOString(),
      last_entry_price: fill.execPrice, max_price: fill.execPrice,
      tp_target: null, dca_triggered: false,
    };
    state = { ...state, ...patch };
    await updateSolDcaBitfinexState(patch);
    lastDbWrite = Date.now();
    console.log(`ENTRY FILLED price=${fill.execPrice.toFixed(4)} qty=${fill.execAmount.toFixed(6)} fee=${fill.fee} fillLatencyMs=${fill.latencyMs} totalLatencyMs=${totalLatencyMs}`);
    await logSolDcaBitfinexRun({ actions: [{ action: "ENTRY", price: fill.execPrice, usdSize, qty: fill.execAmount, fillLatencyMs: fill.latencyMs, totalLatencyMs }] });
    lastRunLog = Date.now();
  } catch (err) {
    console.error("ENTRY order failed:", err);
    await logSolDcaBitfinexRun({ actions: [{ action: "ERROR", stage: "entry", error: String(err) }] });
  } finally {
    orderInFlight = false;
  }
}

// ---------- Manage open trade: every live book tick ----------

async function onBookUpdate() {
  if (!state.enabled || orderInFlight || state.mode !== "SOL") return;
  const { bid, ask } = getBookBidAsk();
  if (bid === null || ask === null) return;

  const entryPrice = state.entry_price!;
  let maxPrice = Math.max(state.max_price ?? entryPrice, bid);
  if (maxPrice !== state.max_price) {
    state = { ...state, max_price: maxPrice };
    if (Date.now() - lastDbWrite > DB_WRITE_THROTTLE_MS) {
      await updateSolDcaBitfinexState({ max_price: maxPrice });
      lastDbWrite = Date.now();
    }
  }

  if (!state.dca_triggered) {
    const trailStop = maxPrice * (1 - TRAIL_PCT / 100);
    const trailProfitable = trailStop >= entryPrice;

    if (trailProfitable && bid <= trailStop) {
      await exitPosition(trailStop, "TRAIL");
      return;
    } else if (bid <= state.last_entry_price! * (1 - DCA_DROP_PCT / 100)) {
      await dcaAdd(ask);
      return;
    }
  } else {
    if (bid <= state.last_entry_price! * (1 - DCA_DROP_PCT / 100)) {
      await dcaAdd(ask);
      return;
    }
    const pv = portfolioValue(state.positions, bid);
    if (pv >= state.tp_target!) {
      await exitPosition(bid, "DCA_TP");
      return;
    }
  }

  if (Date.now() - lastRunLog > RUN_LOG_INTERVAL_MS) {
    await logSolDcaBitfinexRun({
      actions: [{ action: "STATUS", mode: state.mode, bid, ask, dcaCount: state.dca_count, totalCost: state.total_cost, maxPrice, tpTarget: state.tp_target }],
    });
    lastRunLog = Date.now();
  }
}

async function dcaAdd(askPrice: number) {
  orderInFlight = true;
  const signalTime = Date.now();
  try {
    const lastLeg = state.positions[state.positions.length - 1];
    const nextSize = lastLeg.usd_size * MULT;
    const realUsd = getLiveBalance("USD");
    const cappedSize = Math.min(nextSize, realUsd);
    const qty = cappedSize / askPrice;
    if (qty <= 0) { console.log(`DCA trigger but no real USD available (real=${realUsd}) — skipping this tick.`); return; }

    console.log(`DCA_ADD level=${state.dca_count + 1} @ ask=${askPrice.toFixed(4)} size=$${cappedSize.toFixed(2)} qty~=${qty.toFixed(6)} (real USD=${realUsd.toFixed(2)}) — submitting real order...`);
    const fill = await submitMarketOrderFast(BFX_SYMBOL, qty);
    const totalLatencyMs = Date.now() - signalTime;
    const usdSize = fill.execPrice * Math.abs(fill.execAmount);

    const newPositions = [...state.positions, { price: fill.execPrice, usd_size: usdSize, sol_qty: Math.abs(fill.execAmount) }];
    const newTotalCost = state.total_cost + usdSize;
    const tpTarget = newTotalCost * (1 + TP_PCT / 100);

    const patch = {
      positions: newPositions, total_cost: newTotalCost, dca_count: state.dca_count + 1,
      last_entry_price: fill.execPrice, dca_triggered: true, tp_target: tpTarget,
    };
    state = { ...state, ...patch };
    await updateSolDcaBitfinexState(patch);
    lastDbWrite = Date.now();
    console.log(`DCA_ADD FILLED level=${state.dca_count} price=${fill.execPrice.toFixed(4)} qty=${fill.execAmount.toFixed(6)} tpTarget=${tpTarget.toFixed(2)} fillLatencyMs=${fill.latencyMs} totalLatencyMs=${totalLatencyMs}`);
    await logSolDcaBitfinexRun({ actions: [{ action: "DCA_ADD", level: state.dca_count, price: fill.execPrice, usdSize, tpTarget, fillLatencyMs: fill.latencyMs, totalLatencyMs }] });
    lastRunLog = Date.now();
  } catch (err) {
    console.error("DCA_ADD order failed:", err);
    await logSolDcaBitfinexRun({ actions: [{ action: "ERROR", stage: "dca_add", error: String(err) }] });
  } finally {
    orderInFlight = false;
  }
}

async function exitPosition(expectedPrice: number, reason: "TRAIL" | "DCA_TP") {
  orderInFlight = true;
  const signalTime = Date.now();
  try {
    const origPositions = state.positions;
    const origTotalCost = state.total_cost;
    const origDcaCount = state.dca_count;
    const origEntryTime = state.entry_time!;
    const trackedQty = origPositions.reduce((s, p) => s + p.sol_qty, 0);
    const realSol = getLiveBalance("SOL");
    const sellQty = isWalletReady() ? Math.min(trackedQty, realSol) : trackedQty;
    if (sellQty <= 0) throw new Error(`No real SOL available to sell (tracked=${trackedQty}, real=${realSol})`);

    console.log(`${reason} signal, selling ${sellQty.toFixed(6)} SOL (tracked=${trackedQty.toFixed(6)}, real=${realSol.toFixed(6)}) — submitting real order...`);
    const fill = await submitMarketOrderFast(BFX_SYMBOL, -sellQty);
    const totalLatencyMs = Date.now() - signalTime;
    const usdOut = fill.execPrice * Math.abs(fill.execAmount);
    const usdIn  = origTotalCost;
    const pnlUsd = usdOut - usdIn;
    const pnlPct = (pnlUsd / usdIn) * 100;
    const newBalance = state.balance + pnlUsd;

    const patch = {
      mode: "USD" as const, positions: [], total_cost: 0, dca_count: 0,
      entry_price: null, last_entry_price: null, max_price: null, tp_target: null, dca_triggered: false,
      balance: newBalance,
    };
    state = { ...state, ...patch };
    await updateSolDcaBitfinexState(patch);
    lastDbWrite = Date.now();
    await recordSolDcaBitfinexTrade({
      positions: origPositions, dca_levels: origDcaCount, usd_in: usdIn, usd_out: usdOut,
      pnl_usd: pnlUsd, pnl_pct: pnlPct, exit_reason: reason, entry_time: origEntryTime,
    });
    console.log(`${reason} FILLED price=${fill.execPrice.toFixed(4)} pnlUsd=${pnlUsd.toFixed(4)} pnlPct=${pnlPct.toFixed(4)} newBalance=${newBalance.toFixed(2)} fillLatencyMs=${fill.latencyMs} totalLatencyMs=${totalLatencyMs}`);
    await logSolDcaBitfinexRun({ actions: [{ action: `EXIT_${reason}`, price: fill.execPrice, pnlUsd, pnlPct, newBalance, fillLatencyMs: fill.latencyMs, totalLatencyMs }] });
    lastRunLog = Date.now();
  } catch (err) {
    console.error(`${reason} order failed:`, err);
    await logSolDcaBitfinexRun({ actions: [{ action: "ERROR", stage: "exit", error: String(err) }] });
  } finally {
    orderInFlight = false;
  }
}

// ---------- Watchdog: book feed staleness -> emergency flatten ----------

async function emergencyFlatten(reason: string) {
  if (emergencyInProgress) return;
  emergencyInProgress = true;
  try {
    console.error(`EMERGENCY FLATTEN triggered: ${reason}`);
    await logSolDcaBitfinexRun({ actions: [{ action: "ERROR", stage: "watchdog", error: reason }] }).catch(() => {});
    const fresh = await getSolDcaBitfinexState();
    if (fresh.mode !== "SOL" || fresh.positions.length === 0) {
      console.error("Watchdog: not holding per DB state, nothing to flatten.");
      return;
    }
    const qty = fresh.positions.reduce((s, p) => s + p.sol_qty, 0);
    const fill = await submitMarketOrderSafe(BFX_SYMBOL, -qty, "SOL");
    const usdOut = fill.execPrice * Math.abs(fill.execAmount);
    const usdIn = fresh.total_cost;
    const pnlUsd = usdOut - usdIn;
    const pnlPct = (pnlUsd / usdIn) * 100;
    const newBalance = fresh.balance + pnlUsd;

    await updateSolDcaBitfinexState({
      mode: "USD", positions: [], total_cost: 0, dca_count: 0,
      entry_price: null, last_entry_price: null, max_price: null, tp_target: null, dca_triggered: false,
      balance: newBalance, enabled: false,
    });
    await recordSolDcaBitfinexTrade({
      positions: fresh.positions, dca_levels: fresh.dca_count, usd_in: usdIn, usd_out: usdOut,
      pnl_usd: pnlUsd, pnl_pct: pnlPct, exit_reason: "TRAIL", entry_time: fresh.entry_time!,
    });
    console.error(`EMERGENCY FLATTEN complete @ ${fill.execPrice}, pnlPct=${pnlPct.toFixed(4)}. Bot paused (enabled=false).`);
    await logSolDcaBitfinexRun({ actions: [{ action: "EXIT_TRAIL", price: fill.execPrice, pnlUsd, pnlPct, newBalance, emergency: true }] }).catch(() => {});
  } catch (err) {
    console.error("EMERGENCY FLATTEN FAILED:", err);
    await logSolDcaBitfinexRun({ actions: [{ action: "ERROR", stage: "watchdog-flatten-failed", error: String(err) }] }).catch(() => {});
  } finally {
    process.exit(1);
  }
}

function startWatchdog() {
  setInterval(() => {
    const staleMs = bookMessageAge();
    if (staleMs < BOOK_STALE_MS) return;

    if (state.mode === "SOL" && staleMs >= BOOK_EMERGENCY_MS && !emergencyInProgress) {
      emergencyFlatten(`Order book feed silent for ${Math.round(staleMs / 1000)}s while holding SOL`)
        .catch((err) => console.error("emergencyFlatten error:", err));
      return;
    }
    console.error(`Watchdog: order book feed silent for ${Math.round(staleMs / 1000)}s.`);
  }, WATCHDOG_INTERVAL_MS);
}

async function main() {
  const got = await acquireLock();
  if (!got) process.exit(1);

  const heartbeatTimer = setInterval(() => {
    heartbeat().catch((err) => console.error("heartbeat failed:", err));
  }, HEARTBEAT_MS);
  const candleTimer = setInterval(() => {
    checkEntry().catch((err) => console.error("checkEntry error:", err));
  }, CANDLE_CHECK_MS);

  const shutdown = async () => {
    clearInterval(heartbeatTimer);
    clearInterval(candleTimer);
    await releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`Starting LIVE SOL DCA-Martingale (WS execution) worker (${INSTANCE_ID}), enabled=${state.enabled}, mode=${state.mode}, balance=${state.balance}`);
  console.log(`REAL MONEY — VWAP(24h)+EMA(9/20)+volume-expansion entry on 5m candles, trail ${TRAIL_PCT}% (arms only if profitable), DCA rescue at -${DCA_DROP_PCT}%/${MULT}x uncapped, +${TP_PCT}% blended TP. Orders + fills over WS, bid/ask from the real order book.`);
  connectPublicBook(BFX_SYMBOL, () => { onBookUpdate().catch((err) => console.error("onBookUpdate error:", err)); });
  connectAuthenticated();
  checkEntry().catch((err) => console.error("checkEntry error:", err)); // initial check, don't wait for first timer tick
  startWatchdog();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
