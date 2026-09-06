// REAL MONEY — SOL Z-score, Worker 1's existing Render service/API key/DB tables (still named
// eth_zscore_bitfinex_* internally -- kept as-is, same precedent used throughout this session).
//
// 2026-09-06 REWRITE: replaced REST order submission + REST-polling fill detection + the
// throttled public `ticker` channel with a WS-native execution path (lib/bitfinex-trading-ws.ts):
// orders submit over the already-authenticated WS and fills arrive via the `te` push event
// (matched by client order id) instead of polling REST every 500ms for up to 5s. Bid/ask now come
// from the real order book (`book` channel, updates on every book change) instead of the
// throttled `ticker` snapshot. Built after a real trade audit found meaningful slippage (SOL:
// -0.293% vs a -0.1% intended stop) that traced back to that latency gap -- every ms between
// "price crossed the stop" and "we know we're filled" is real money during a fast move.
// Every order now logs its actual latency (signal -> fill) so this can be verified with real
// numbers instead of assumed.
//
// SIGNAL: continuous rolling z-score against Binance SOLUSDT's own mid-price ((bestBid+bestAsk)/2
// from bookTicker), NOT raw last-trade price. Window = last 25 completed 1-minute mid-price
// closes, checked continuously in real time (not gated to candle close). Entry: z <= -2.0 while
// flat.
//
// EXIT: ratcheting stop, SL=ARM=0.1% -- back from the fixed-OCO experiment (0.1%/0.2% and
// 0.1%/0.4%) tried earlier tonight; ratchet backtested clearly stronger for Z-score entries
// ($13,012 ETH 2yr vs $1,980-1,922 for the best OCO variant). Entry-0.1% initial stop, moves to
// breakeven once price clears entry, resumes trailing peak-0.1% once price clears entry+0.1%.
//
// SINGLE-INSTANCE GUARANTEE + WATCHDOG + SHARED-WALLET FIX: lock row with heartbeat,
// emergency-flatten via a fresh REST price if the book feed goes silent while holding, real
// live-balance check before every order. Emergency path still uses the proven REST
// submitMarketOrderSafe (lib/bitfinex-auth.ts) deliberately -- that's the rare, safety-critical
// path where an extra REST round trip is acceptable, unlike the speed-critical hot path.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import WebSocket from "ws";
import os from "os";
import crypto from "crypto";
import {
  getEthZscoreBitfinexState, updateEthZscoreBitfinexState, recordEthZscoreBitfinexTrade,
  logEthZscoreBitfinexRun, type EthZscoreBitfinexState,
} from "../lib/eth-zscore-bitfinex-db";
import { submitMarketOrderSafe } from "../lib/bitfinex-auth";
import {
  connectPublicBook, getBookBidAsk, isBookReady, bookMessageAge,
  connectAuthenticated, getLiveBalance, isWalletReady, submitMarketOrderFast,
} from "../lib/bitfinex-trading-ws";

const BFX_SYMBOL       = "tSOLUSD";
const BINANCE_WS       = "wss://stream.binance.com:9443/ws/solusdt@bookTicker";
const ZSCORE_WINDOW_MIN = 25;
const Z_ENTRY           = -2.0;
const TRAIL_PCT         = 0.1;
const ARM_PCT           = 0.1; // price must clear entry + this% before the stop trails past breakeven
const SEED_USD          = 20;
const HEARTBEAT_MS     = 10_000;
const LOCK_STALE_MS    = 30_000;
const DB_WRITE_THROTTLE_MS = 2_000;
const RUN_LOG_INTERVAL_MS  = 5 * 60_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const BOOK_STALE_MS        = 15_000;
const BOOK_EMERGENCY_MS    = 25_000;

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

let state: EthZscoreBitfinexState;
let lastDbWrite = 0;
let lastRunLog = 0;
let lastSkipLog = 0;
const SKIP_LOG_THROTTLE_MS = 30_000;
let orderInFlight = false;
let emergencyInProgress = false;

// rolling 1-min-close window for the z-score baseline
let oneMinCloses: number[] = [];
let currentMinuteBucket = 0;
let currentMinuteLastPrice: number | null = null;

async function acquireLock(): Promise<boolean> {
  state = await getEthZscoreBitfinexState();
  const heartbeatAge = state.lock_heartbeat ? Date.now() - new Date(state.lock_heartbeat).getTime() : Infinity;
  if (state.lock_owner && heartbeatAge < LOCK_STALE_MS) {
    console.error(`Refusing to start: lock held by ${state.lock_owner}, last heartbeat ${heartbeatAge}ms ago`);
    return false;
  }
  await updateEthZscoreBitfinexState({ lock_owner: INSTANCE_ID, lock_heartbeat: new Date().toISOString() });
  console.log(`Lock acquired as ${INSTANCE_ID}`);
  return true;
}

async function releaseLock() {
  try {
    const fresh = await getEthZscoreBitfinexState();
    if (fresh.lock_owner === INSTANCE_ID) {
      await updateEthZscoreBitfinexState({ lock_owner: null, lock_heartbeat: null });
      console.log("Lock released cleanly.");
    }
  } catch (err) { console.error("releaseLock failed:", err); }
}

async function heartbeat() {
  const fresh = await getEthZscoreBitfinexState();
  if (fresh.lock_owner !== INSTANCE_ID) {
    console.error(`Lost lock to ${fresh.lock_owner} — another instance took over. Exiting.`);
    process.exit(1);
  }
  if (orderInFlight) {
    state.enabled = fresh.enabled;
  } else {
    state = fresh;
  }
  await updateEthZscoreBitfinexState({ lock_heartbeat: new Date().toISOString() });
}

// Ratcheting stop: entry-0.1% until price pushes above entry (then breakeven), then trailing
// peak-0.1% once price clears entry+0.1%.
function computeStop(entryPrice: number, extremePrice: number): number {
  const armThreshold = entryPrice * (1 + ARM_PCT / 100);
  if (extremePrice >= armThreshold) return extremePrice * (1 - TRAIL_PCT / 100);
  if (extremePrice > entryPrice) return entryPrice;
  return entryPrice * (1 - TRAIL_PCT / 100);
}

function calcZ(current: number): number | null {
  if (oneMinCloses.length < ZSCORE_WINDOW_MIN) return null;
  const window = oneMinCloses.slice(-ZSCORE_WINDOW_MIN);
  const mean = window.reduce((s, v) => s + v, 0) / window.length;
  const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
  const std = Math.sqrt(variance);
  return std > 0 ? (current - mean) / std : 0;
}

async function onBinTick(price: number) {
  const minuteBucket = Math.floor(Date.now() / 60_000);
  if (currentMinuteBucket === 0) currentMinuteBucket = minuteBucket;
  if (minuteBucket > currentMinuteBucket) {
    if (currentMinuteLastPrice !== null) {
      oneMinCloses.push(currentMinuteLastPrice);
      if (oneMinCloses.length > ZSCORE_WINDOW_MIN) oneMinCloses.shift();
    }
    currentMinuteBucket = minuteBucket;
  }
  currentMinuteLastPrice = price;

  const zRaw = calcZ(price);
  if (zRaw === null || zRaw > Z_ENTRY) return;
  const z: number = zRaw;
  const signalTime = Date.now();

  // Real signal from here on -- log WHY we don't act on it, instead of silently returning, so a
  // signal that never results in a trade is never a mystery.
  if (!state.enabled || state.mode !== "FLAT" || orderInFlight) return; // expected/routine, not worth logging
  function logSkip(reason: string) {
    if (Date.now() - lastSkipLog > SKIP_LOG_THROTTLE_MS) {
      console.log(`SIGNAL SKIPPED (z=${z.toFixed(3)}): ${reason}`);
      logEthZscoreBitfinexRun({ actions: [{ action: "SKIPPED", z, reason }] }).catch(() => {});
      lastSkipLog = Date.now();
    }
  }
  const { bid: bfxBid, ask: bfxAsk } = getBookBidAsk();
  if (!isBookReady() || bfxAsk === null || bfxBid === null) { logSkip("Order book not ready yet"); return; }
  if (!isWalletReady()) { logSkip("Wallet WS not authenticated/ready yet"); return; }

  orderInFlight = true;
  try {
    const targetPool = SEED_USD + (state.realized_pnl_usd ?? 0);
    const realUsd = getLiveBalance("USD");
    const cappedPool = Math.min(targetPool, realUsd);
    const estQty = cappedPool / bfxAsk;
    if (estQty <= 0) { console.log(`BUY signal but no real USD available (real=${realUsd}) — skipping.`); return; }
    const entrySpreadPct = (bfxAsk - bfxBid) / bfxBid * 100;
    console.log(`BUY signal (z=${z.toFixed(3)}) @ ask=${bfxAsk.toFixed(4)} qty~=${estQty.toFixed(4)} (real USD=${realUsd.toFixed(2)}) — submitting real order...`);
    const fill = await submitMarketOrderFast(BFX_SYMBOL, estQty);
    const totalLatencyMs = Date.now() - signalTime;
    const slPrice = fill.execPrice * (1 - TRAIL_PCT / 100);
    const patch = {
      mode: "LONG" as const, eth_quantity: fill.execAmount, entry_price: fill.execPrice,
      entry_time: new Date().toISOString(), usd_balance: 0,
      extreme_price: fill.execPrice, stop_price: slPrice, entry_spread_pct: entrySpreadPct,
    };
    state = { ...state, ...patch };
    await updateEthZscoreBitfinexState(patch);
    lastDbWrite = Date.now();
    console.log(`BUY FILLED price=${fill.execPrice.toFixed(4)} qty=${fill.execAmount.toFixed(4)} fee=${fill.fee} z=${z.toFixed(3)} fillLatencyMs=${fill.latencyMs} totalLatencyMs=${totalLatencyMs}`);
    await logEthZscoreBitfinexRun({ actions: [{ action: "BUY", price: fill.execPrice, qty: fill.execAmount, orderId: fill.orderId, z, fillLatencyMs: fill.latencyMs, totalLatencyMs }] });
    lastRunLog = Date.now();
  } catch (err) {
    console.error("BUY order failed:", err);
    await logEthZscoreBitfinexRun({ actions: [{ action: "ERROR", stage: "buy", error: String(err) }] });
  } finally {
    orderInFlight = false;
  }
}

async function onBookUpdate() {
  if (!state.enabled || orderInFlight || state.mode !== "LONG") return;
  const { bid, ask } = getBookBidAsk();
  if (bid === null || ask === null) return;

  const entryPrice = state.entry_price!;
  const extreme = state.extreme_price ?? entryPrice;
  const stop = state.stop_price ?? computeStop(entryPrice, extreme);

  if (bid <= stop) {
    const signalTime = Date.now();
    orderInFlight = true;
    try {
      const origEntryPrice = state.entry_price!;
      const origQty = state.eth_quantity!;
      const origEntryTime = state.entry_time!;
      const origEntrySpread = state.entry_spread_pct;
      const realSol = getLiveBalance("SOL");
      const sellQty = isWalletReady() ? Math.min(origQty, realSol) : origQty;
      if (sellQty <= 0) throw new Error(`No real SOL available to sell (tracked=${origQty}, real=${realSol})`);
      console.log(`STOP signal, selling ${sellQty.toFixed(4)} SOL (tracked=${origQty.toFixed(4)}, real=${realSol.toFixed(4)}) — submitting real order...`);
      const fill = await submitMarketOrderFast(BFX_SYMBOL, -sellQty);
      const totalLatencyMs = Date.now() - signalTime;
      const usdOut = fill.execPrice * Math.abs(fill.execAmount);
      const usdIn  = origEntryPrice * Math.abs(fill.execAmount);
      const pnlUsd = usdOut - usdIn;
      const pnlPct = (pnlUsd / usdIn) * 100;
      const exitSpreadPct = (ask - bid) / bid * 100;

      const patch = {
        mode: "FLAT" as const, eth_quantity: null, entry_price: null, entry_time: null,
        usd_balance: usdOut, extreme_price: null, stop_price: null, entry_spread_pct: null,
      };
      state = { ...state, ...patch };
      await updateEthZscoreBitfinexState(patch);
      await recordEthZscoreBitfinexTrade({
        entry_price: origEntryPrice, exit_price: fill.execPrice, eth_quantity: Math.abs(fill.execAmount),
        usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct,
        zscore_at_entry: Z_ENTRY, entry_spread_pct: origEntrySpread, exit_spread_pct: exitSpreadPct,
        entry_time: origEntryTime,
      });
      lastDbWrite = Date.now();
      console.log(`STOP FILLED price=${fill.execPrice.toFixed(4)} pnlUsd=${pnlUsd.toFixed(4)} pnlPct=${pnlPct.toFixed(4)} fillLatencyMs=${fill.latencyMs} totalLatencyMs=${totalLatencyMs}`);
      await logEthZscoreBitfinexRun({ actions: [{ action: "EXIT", price: fill.execPrice, pnlUsd, pnlPct, orderId: fill.orderId, fillLatencyMs: fill.latencyMs, totalLatencyMs }] });
      lastRunLog = Date.now();
    } catch (err) {
      console.error("SELL order failed:", err);
      await logEthZscoreBitfinexRun({ actions: [{ action: "ERROR", stage: "sell", error: String(err) }] });
    } finally {
      orderInFlight = false;
    }
    return;
  } else if (bid > extreme) {
    state = { ...state, extreme_price: bid, stop_price: computeStop(entryPrice, bid) };
    if (Date.now() - lastDbWrite > DB_WRITE_THROTTLE_MS) {
      await updateEthZscoreBitfinexState({ extreme_price: state.extreme_price, stop_price: state.stop_price });
      lastDbWrite = Date.now();
    }
  }

  if (Date.now() - lastRunLog > RUN_LOG_INTERVAL_MS) {
    await logEthZscoreBitfinexRun({
      actions: [{ action: "STATUS", mode: state.mode, bid, ask, extreme: state.extreme_price, stop: state.stop_price }],
    });
    lastRunLog = Date.now();
  }
}

function connectBinance() {
  const ws = new WebSocket(BINANCE_WS);
  ws.on("open", () => console.log("Binance WS connected (bookTicker, mid-price signal)"));
  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      const bid = parseFloat(msg.b), ask = parseFloat(msg.a);
      if (bid && ask) { const mid = (bid + ask) / 2; onBinTick(mid).catch((err) => console.error("onBinTick error:", err)); }
    } catch {}
  });
  ws.on("error", (e) => console.error("Binance WS error:", e));
  ws.on("close", () => { console.log("Binance WS closed, reconnecting in 2s..."); setTimeout(connectBinance, 2000); });
  return ws;
}

async function emergencyFlatten(reason: string) {
  if (emergencyInProgress) return;
  emergencyInProgress = true;
  try {
    console.error(`EMERGENCY FLATTEN triggered: ${reason}`);
    await logEthZscoreBitfinexRun({ actions: [{ action: "ERROR", stage: "watchdog", error: reason }] }).catch(() => {});
    const fresh = await getEthZscoreBitfinexState();
    if (fresh.mode !== "LONG" || !fresh.eth_quantity) {
      console.error("Watchdog: not holding per DB state, nothing to flatten.");
      return;
    }
    const fill = await submitMarketOrderSafe(BFX_SYMBOL, -fresh.eth_quantity, "SOL");
    const usdOut = fill.execPrice * Math.abs(fill.execAmount);
    const usdIn = fresh.entry_price! * fresh.eth_quantity;
    const pnlUsd = usdOut - usdIn;
    const pnlPct = (pnlUsd / usdIn) * 100;
    await updateEthZscoreBitfinexState({
      mode: "FLAT", eth_quantity: null, entry_price: null, entry_time: null,
      usd_balance: usdOut, extreme_price: null, stop_price: null, entry_spread_pct: null, enabled: false,
    });
    await recordEthZscoreBitfinexTrade({
      entry_price: fresh.entry_price!, exit_price: fill.execPrice, eth_quantity: fresh.eth_quantity,
      usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct,
      zscore_at_entry: Z_ENTRY, entry_spread_pct: fresh.entry_spread_pct, exit_spread_pct: null,
      entry_time: fresh.entry_time!,
    });
    console.error(`EMERGENCY FLATTEN complete @ ${fill.execPrice}, pnlPct=${pnlPct.toFixed(4)}. Bot paused (enabled=false).`);
    await logEthZscoreBitfinexRun({ actions: [{ action: "EXIT", price: fill.execPrice, pnlUsd, pnlPct, orderId: fill.orderId, emergency: true }] }).catch(() => {});
  } catch (err) {
    console.error("EMERGENCY FLATTEN FAILED:", err);
    await logEthZscoreBitfinexRun({ actions: [{ action: "ERROR", stage: "watchdog-flatten-failed", error: String(err) }] }).catch(() => {});
  } finally {
    process.exit(1);
  }
}

function startWatchdog() {
  setInterval(() => {
    const staleMs = bookMessageAge();
    if (staleMs < BOOK_STALE_MS) return;

    if (state.mode === "LONG" && staleMs >= BOOK_EMERGENCY_MS && !emergencyInProgress) {
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

  const shutdown = async () => {
    clearInterval(heartbeatTimer);
    await releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`Starting LIVE SOL Z-score (ratchet, WS execution) worker (${INSTANCE_ID}), enabled=${state.enabled}, mode=${state.mode}`);
  console.log(`REAL MONEY — z<=${Z_ENTRY} (${ZSCORE_WINDOW_MIN}min rolling window) triggers a real buy on ${BFX_SYMBOL}. Seed $${SEED_USD}, compounding, ratchet stop (initial -${TRAIL_PCT}%, breakeven at entry, trail past +${ARM_PCT}%). Orders + fills over WS, bid/ask from the real order book.`);
  connectBinance();
  connectPublicBook(BFX_SYMBOL, () => { onBookUpdate().catch((err) => console.error("onBookUpdate error:", err)); });
  connectAuthenticated();
  startWatchdog();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
