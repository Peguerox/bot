// PAPER TRADING — SOL/USD DCA-martingale, Worker 1. Converted from real money to paper on
// 2026-09-12 when the real $500 was moved to Worker 2 (the variable-rate formula, independently
// verified more robust — see docs/hypertrade_formula_database.md). This strategy and its
// tracking tables (sol_trail_bitfinex_*) are kept running as paper so its own signal/config can
// keep being observed without further real-money risk. No real orders are submitted anywhere in
// this file; fills are simulated from the live public order book, same pattern as Worker 2.
//
// STRATEGY — entry (long only, flat, re-armed on every new closed 5-min candle): price > rolling
// 24h VWAP AND EMA9 > EMA20 (5-min bars, spans scaled to represent 9h/20h) AND previous candle's
// volume below its own 5h rolling average (pullback) AND current candle's volume above that
// average (expansion resuming).
//
// EXIT: a trailing stop (1% below the peak price since entry) that only ever arms once price is
// at/above the original entry — it can never realize a loss. If price instead drops 10% from the
// last entry before the trail arms, add another position (1.5x the size of the previous leg) and
// switch to targeting +3% on the new blended cost; repeats on each further 10% drop, uncapped.
//
// Position sizing compounds: at the moment a new trade opens (flat -> entry), the base unit is
// recalculated as current balance / RESERVE_DIVISOR (lib/sol-dca-config.ts — geometric sum for
// the worst-case DCA depth seen in backtesting at this multiplier). Each DCA leg after that is
// MULT x the previous leg's size.
//
// Chosen via a 12-window cross-validation (3 exchanges -- Bitfinex, Binance Global, Binance US --
// x 4 non-overlapping quarters each, 2yr SOL 5-min data), ranked by WORST-CASE ROI across all 12,
// not average or best. See project_dca_martingale_sol memory for the full comparison table.
//
// EXECUTION: entries/DCA-adds/exits all simulate fills using the live public order book (real
// bid/ask spread, no assumed slippage), same as Worker 2. No real orders submitted.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import os from "os";
import crypto from "crypto";
import {
  getSolDcaBitfinexState, updateSolDcaBitfinexState, recordSolDcaBitfinexTrade, logSolDcaBitfinexRun,
  type SolDcaBitfinexState, type DcaPosition,
} from "../lib/sol-dca-bitfinex-db";
import { getBitfinexCandlesOHLCV, type BitfinexOHLCV } from "../lib/bitfinex";
import { connectPublicBook, getBookBidAsk, isBookReady, bookMessageAge } from "../lib/bitfinex-trading-ws";
import { DCA_DROP_PCT, MULT, TP_PCT, TRAIL_PCT, RESERVE_DIVISOR } from "../lib/sol-dca-config";

const BFX_SYMBOL       = "tSOLUSD";
const VWAP_PERIOD      = 24 * 12; // 24h on 5-min bars
const EMA9_SPAN        = 9 * 12;
const EMA20_SPAN       = 20 * 12;
const VOLAVG_PERIOD    = 5 * 12;
const C5_LIMIT         = VWAP_PERIOD + 320; // extra history so EMA20 has room to converge
const CANDLE_CHECK_MS  = 30_000; // 5-min candles only close every 5min; 30s is plenty responsive
const HEARTBEAT_MS     = 10_000;
const LOCK_STALE_MS    = 15_000; // 1.5x heartbeat -- see the Render redeploy crash-loop incident
const DB_WRITE_THROTTLE_MS = 2_000;
const RUN_LOG_INTERVAL_MS  = 5 * 60_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const BOOK_STALE_MS        = 15_000;

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

let state: SolDcaBitfinexState;
let lastDbWrite = 0;
let lastRunLog = 0;
let orderInFlight = false;

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

// ---------- Indicators (same formulas as the backtest) ----------

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
  const priceAboveVwap = closes[i] > vwap[i];
  const emaBullish = ema9[i] > ema20[i];
  const longTrend = priceAboveVwap && emaBullish;
  const lowerVol = volumes[i - 1] < avgVol[i];
  const higherVol = volumes[i] > avgVol[i];
  const entrySignal = longTrend && lowerVol && higherVol;

  // Fires once per closed 5-min candle (~every 5 min) regardless of whether the full signal
  // triggers — without this, the Activity feed goes silent for hours/days between trades with
  // nothing to show the bot is actually alive and evaluating candles, not just stalled.
  let stage: string;
  if (!longTrend) {
    stage = !priceAboveVwap && !emaBullish ? "no trend (price below VWAP, EMA9<EMA20)"
      : !priceAboveVwap ? "no trend (price below VWAP)"
      : "no trend (EMA9<EMA20)";
  } else if (!lowerVol) {
    stage = "trend confirmed, waiting for volume pullback";
  } else if (!higherVol) {
    stage = "trend + pullback confirmed, waiting for volume expansion";
  } else {
    stage = "ARMED — all conditions met, entering";
  }
  await logSolDcaBitfinexRun({
    actions: [{
      action: "SIGNAL_CHECK", stage,
      price: closes[i], vwap: vwap[i], ema9: ema9[i], ema20: ema20[i],
      volume: volumes[i], avgVol: avgVol[i], prevVolume: volumes[i - 1],
      longTrend, lowerVol, higherVol,
    }],
  });

  if (!entrySignal) return;

  const { ask } = getBookBidAsk();
  if (!isBookReady() || ask === null) { console.log("Entry signal fired but order book not ready yet — skipping this candle."); return; }

  orderInFlight = true;
  try {
    const baseSize = state.balance / RESERVE_DIVISOR;
    const qty = baseSize / ask;
    if (qty <= 0) return;

    console.log(`ENTRY signal (paper) @ ask=${ask.toFixed(4)} size=$${baseSize.toFixed(2)} qty~=${qty.toFixed(6)}`);
    const execPrice = ask;
    const execAmount = qty;
    const usdSize = execPrice * execAmount;

    const positions: DcaPosition[] = [{ price: execPrice, usd_size: usdSize, sol_qty: execAmount }];
    const patch = {
      mode: "SOL" as const, positions, total_cost: usdSize, dca_count: 0,
      entry_price: execPrice, entry_time: new Date().toISOString(),
      last_entry_price: execPrice, max_price: execPrice,
      tp_target: null, dca_triggered: false,
    };
    state = { ...state, ...patch };
    await updateSolDcaBitfinexState(patch);
    lastDbWrite = Date.now();
    console.log(`ENTRY FILLED (paper) price=${execPrice.toFixed(4)} qty=${execAmount.toFixed(6)}`);
    await logSolDcaBitfinexRun({ actions: [{ action: "ENTRY", price: execPrice, usdSize, qty: execAmount }] });
    lastRunLog = Date.now();
  } catch (err) {
    console.error("ENTRY (paper) failed:", err);
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
  try {
    const lastLeg = state.positions[state.positions.length - 1];
    const nextSize = lastLeg.usd_size * MULT;
    const qty = nextSize / askPrice;
    if (qty <= 0) return;

    console.log(`DCA_ADD (paper) level=${state.dca_count + 1} @ ask=${askPrice.toFixed(4)} size=$${nextSize.toFixed(2)} qty~=${qty.toFixed(6)}`);
    const execPrice = askPrice;
    const execAmount = qty;
    const usdSize = execPrice * execAmount;

    const newPositions = [...state.positions, { price: execPrice, usd_size: usdSize, sol_qty: execAmount }];
    const newTotalCost = state.total_cost + usdSize;
    const tpTarget = newTotalCost * (1 + TP_PCT / 100);

    const patch = {
      positions: newPositions, total_cost: newTotalCost, dca_count: state.dca_count + 1,
      last_entry_price: execPrice, dca_triggered: true, tp_target: tpTarget,
    };
    state = { ...state, ...patch };
    await updateSolDcaBitfinexState(patch);
    lastDbWrite = Date.now();
    console.log(`DCA_ADD FILLED (paper) level=${state.dca_count} price=${execPrice.toFixed(4)} qty=${execAmount.toFixed(6)} tpTarget=${tpTarget.toFixed(2)}`);
    await logSolDcaBitfinexRun({ actions: [{ action: "DCA_ADD", level: state.dca_count, price: execPrice, usdSize, tpTarget }] });
    lastRunLog = Date.now();
  } catch (err) {
    console.error("DCA_ADD (paper) failed:", err);
    await logSolDcaBitfinexRun({ actions: [{ action: "ERROR", stage: "dca_add", error: String(err) }] });
  } finally {
    orderInFlight = false;
  }
}

async function exitPosition(expectedPrice: number, reason: "TRAIL" | "DCA_TP") {
  orderInFlight = true;
  try {
    const origPositions = state.positions;
    const origTotalCost = state.total_cost;
    const origDcaCount = state.dca_count;
    const origEntryTime = state.entry_time!;
    const trackedQty = origPositions.reduce((s, p) => s + p.sol_qty, 0);
    if (trackedQty <= 0) throw new Error("No tracked SOL to sell (paper)");

    console.log(`${reason} signal (paper), selling ${trackedQty.toFixed(6)} SOL @ ~${expectedPrice.toFixed(4)}`);
    const execPrice = expectedPrice;
    const execAmount = trackedQty;
    const usdOut = execPrice * execAmount;
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
      positions: origPositions, dca_levels: origDcaCount,
      entry_price: origTotalCost / trackedQty, exit_price: execPrice, sol_quantity: trackedQty,
      usd_in: usdIn, usd_out: usdOut,
      pnl_usd: pnlUsd, pnl_pct: pnlPct, exit_reason: reason, entry_time: origEntryTime,
    });
    console.log(`${reason} FILLED (paper) price=${execPrice.toFixed(4)} pnlUsd=${pnlUsd.toFixed(4)} pnlPct=${pnlPct.toFixed(4)} newBalance=${newBalance.toFixed(2)}`);
    await logSolDcaBitfinexRun({ actions: [{ action: `EXIT_${reason}`, price: execPrice, pnlUsd, pnlPct, newBalance }] });
    lastRunLog = Date.now();
  } catch (err) {
    console.error(`${reason} (paper) failed:`, err);
    await logSolDcaBitfinexRun({ actions: [{ action: "ERROR", stage: "exit", error: String(err) }] });
  } finally {
    orderInFlight = false;
  }
}

// ---------- Watchdog: book feed staleness (log-only, nothing real to protect) ----------

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

  console.log(`Starting PAPER SOL DCA-Martingale worker (${INSTANCE_ID}), enabled=${state.enabled}, mode=${state.mode}, balance=${state.balance}`);
  console.log(`PAPER ONLY — no real orders. VWAP(24h)+EMA(9/20)+volume-expansion entry on 5m candles, trail ${TRAIL_PCT}% (arms only if profitable), DCA rescue at -${DCA_DROP_PCT}%/${MULT}x uncapped, +${TP_PCT}% blended TP. Fills simulated from the live public order book.`);
  connectPublicBook(BFX_SYMBOL, () => { onBookUpdate().catch((err) => console.error("onBookUpdate error:", err)); });
  checkEntry().catch((err) => console.error("checkEntry error:", err)); // initial check, don't wait for first timer tick
  startWatchdog();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
