// REAL MONEY — BTC ML predictor entry + plain trail exit, Worker 1's existing Render
// service/API key/DB tables (still named eth_zscore_bitfinex_* internally -- kept as-is, same
// precedent used throughout this session). Converted 2026-09-08 from Jump entry to ML entry
// after extensive backtesting (purged walk-forward CV, genuine forward tests on data the model
// never trained on) found Jump's win rate underwhelming and a simple 2-feature logistic
// regression (binance_imbalance + binance_venueGapPct) showed a real, statistically significant
// edge at 5s/15s horizons -- see project_market_ticks_logger memory. Chose 15s over 5s: smaller
// edge but far more stable across every test (lowest variance of any horizon). Chose plain-trail
// exit over an ML exit or ML+trail-combo after testing showed the ML exit added no measurable
// value over the trail alone, and simpler is safer for a first real-money test of this signal.
// User's explicit framing: "the problem with backtesting is it never works... $20 is
// insignificant... only testing will give us the truth" -- this IS that test.
//
// STRATEGY: entry when the locked model (lib/btc-ml-predictor.ts) predicts >=70% confidence of
// price rising in the next 15s. Exit on a plain trailing stop -- TRAIL_PCT below the peak price
// since entry, no breakeven arm, no ratchet, no ML on the exit side.
//
// EXECUTION: reuses the proven WS-native path (lib/bitfinex-trading-ws.ts) -- orders over the
// authenticated WS, fills accumulated across every `te` partial-fill event, bid/ask from the real
// order book, not the throttled ticker.
//
// FEATURES: computed via lib/market-features.ts's computeFeatures() -- the SAME function used to
// generate the training data, via a dedicated public book WS connection separate from the
// execution book connection (kept decoupled on purpose: feature computation vs order pricing are
// different concerns, and this mirrors how the data logger worked).
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
import { createFeatureState, applyBookRow, computeFeatures, updateHistory, type FeatureState } from "../lib/market-features";
import { predictUpProbability } from "../lib/btc-ml-predictor";

const BFX_SYMBOL       = "tBTCUSD";
const BINANCE_WS       = "wss://stream.binance.com:9443/ws/btcusdt@bookTicker";
const CONF_THRESHOLD   = 0.70; // model must be >=70% confident UP to enter
const TRAIL_PCT        = 0.1;
const SEED_USD         = 20;
const HEARTBEAT_MS     = 10_000;
const LOCK_STALE_MS    = 30_000;
const DB_WRITE_THROTTLE_MS = 2_000;
const RUN_LOG_INTERVAL_MS  = 5 * 60_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const BOOK_STALE_MS        = 15_000;
const BOOK_EMERGENCY_MS    = 25_000;
const FEATURE_TICK_MS      = 1_000;

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

let state: EthZscoreBitfinexState;
let lastDbWrite = 0;
let lastRunLog = 0;
let lastSkipLog = 0;
const SKIP_LOG_THROTTLE_MS = 30_000;
let orderInFlight = false;
let emergencyInProgress = false;
const featureState: FeatureState = createFeatureState();

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

// Plain trailing stop: TRAIL_PCT below the highest price seen since entry. No breakeven arm.
function computeStop(entryPrice: number, extremePrice: number): number {
  return extremePrice * (1 - TRAIL_PCT / 100);
}

async function onFeatureTick() {
  const now = Date.now();
  if (!featureState.bookReady) return;
  const result = computeFeatures(featureState, now);
  if (!result) return;
  const { mid, features } = result;
  updateHistory(featureState, now, mid, features.spreadPct as number, features.imbalance as number);

  const binance = features.binance as { imbalance: number | null; venueGapPct: number | null } | null;
  const pUp = predictUpProbability({
    binance_imbalance: binance?.imbalance ?? null,
    binance_venueGapPct: binance?.venueGapPct ?? null,
  });
  if (pUp === null) return;

  if (!state.enabled || state.mode !== "FLAT" || orderInFlight) return; // expected/routine, not worth logging
  function logSkip(reason: string) {
    if (Date.now() - lastSkipLog > SKIP_LOG_THROTTLE_MS) {
      console.log(`SIGNAL SKIPPED (P(up)=${pUp!.toFixed(4)}): ${reason}`);
      logEthZscoreBitfinexRun({ actions: [{ action: "SKIPPED", pUp, reason }] }).catch(() => {});
      lastSkipLog = Date.now();
    }
  }
  if (pUp < CONF_THRESHOLD) return; // no signal, routine -- not worth logging every tick

  const signalTime = Date.now();
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
    console.log(`BUY signal (P(up)=${pUp.toFixed(4)}) @ ask=${bfxAsk.toFixed(4)} qty~=${estQty.toFixed(6)} (real USD=${realUsd.toFixed(2)}) — submitting real order...`);
    const fill = await submitMarketOrderFast(BFX_SYMBOL, estQty);
    const totalLatencyMs = Date.now() - signalTime;
    const patch = {
      mode: "LONG" as const, eth_quantity: fill.execAmount, entry_price: fill.execPrice,
      entry_time: new Date().toISOString(), usd_balance: 0,
      extreme_price: fill.execPrice, stop_price: computeStop(fill.execPrice, fill.execPrice), entry_spread_pct: entrySpreadPct,
    };
    state = { ...state, ...patch };
    await updateEthZscoreBitfinexState(patch);
    lastDbWrite = Date.now();
    console.log(`BUY FILLED price=${fill.execPrice.toFixed(4)} qty=${fill.execAmount.toFixed(6)} fee=${fill.fee} pUp=${pUp.toFixed(4)} fillLatencyMs=${fill.latencyMs} totalLatencyMs=${totalLatencyMs}`);
    await logEthZscoreBitfinexRun({ actions: [{ action: "BUY", price: fill.execPrice, qty: fill.execAmount, orderId: fill.orderId, pUp, fillLatencyMs: fill.latencyMs, totalLatencyMs }] });
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
      const realBtc = getLiveBalance("BTC");
      const sellQty = isWalletReady() ? Math.min(origQty, realBtc) : origQty;
      if (sellQty <= 0) throw new Error(`No real BTC available to sell (tracked=${origQty}, real=${realBtc})`);
      console.log(`STOP signal, selling ${sellQty.toFixed(6)} BTC (tracked=${origQty.toFixed(6)}, real=${realBtc.toFixed(6)}) — submitting real order...`);
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
        zscore_at_entry: 0, entry_spread_pct: origEntrySpread, exit_spread_pct: exitSpreadPct,
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
  ws.on("open", () => console.log("Binance WS connected (bookTicker, feeds ML feature computation)"));
  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      const bid = parseFloat(msg.b), ask = parseFloat(msg.a);
      const bidQty = parseFloat(msg.B), askQty = parseFloat(msg.A);
      if (bid && ask) {
        featureState.binanceBid = bid;
        featureState.binanceAsk = ask;
        featureState.binanceBidQty = bidQty;
        featureState.binanceAskQty = askQty;
      }
    } catch {}
  });
  ws.on("error", (e) => console.error("Binance WS error:", e));
  ws.on("close", () => { console.log("Binance WS closed, reconnecting in 2s..."); setTimeout(connectBinance, 2000); });
  return ws;
}

// Dedicated public book connection purely for feature computation (separate from the execution
// book connection above, which lib/bitfinex-trading-ws.ts owns internally and doesn't expose raw
// rows from) -- mirrors how the data logger tracked its own book state independently.
function connectFeatureBook() {
  const ws = new WebSocket("wss://api-pub.bitfinex.com/ws/2");
  let chanId: number | null = null;
  ws.on("open", () => {
    ws.send(JSON.stringify({ event: "subscribe", channel: "book", symbol: BFX_SYMBOL, prec: "P0", freq: "F0", len: "25" }));
  });
  ws.on("message", (raw: Buffer) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.event === "subscribed" && msg.channel === "book") {
      chanId = msg.chanId;
      featureState.book.clear();
      featureState.bookReady = false;
      return;
    }
    if (!Array.isArray(msg) || msg[0] !== chanId || msg[1] === "hb") return;
    const data = msg[1];
    if (Array.isArray(data[0])) {
      featureState.book.clear();
      for (const row of data) applyBookRow(featureState, row);
      featureState.bookReady = true;
    } else {
      applyBookRow(featureState, data);
    }
  });
  ws.on("error", (e) => console.error("Feature book WS error:", e));
  ws.on("close", () => { console.log("Feature book WS closed, reconnecting in 2s..."); featureState.bookReady = false; setTimeout(connectFeatureBook, 2000); });
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
    const fill = await submitMarketOrderSafe(BFX_SYMBOL, -fresh.eth_quantity, "BTC");
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
      zscore_at_entry: 0, entry_spread_pct: fresh.entry_spread_pct, exit_spread_pct: null,
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
      emergencyFlatten(`Order book feed silent for ${Math.round(staleMs / 1000)}s while holding BTC`)
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

  console.log(`Starting LIVE BTC ML Predictor (15s, ${CONF_THRESHOLD * 100}% confidence entry, plain trail exit) worker (${INSTANCE_ID}), enabled=${state.enabled}, mode=${state.mode}`);
  console.log(`REAL MONEY — locked logistic regression model (binance_imbalance + binance_venueGapPct) triggers a real buy on ${BFX_SYMBOL} when P(up in 15s)>=${CONF_THRESHOLD}. Seed $${SEED_USD}, compounding, plain trailing stop -${TRAIL_PCT}% below peak since entry. Orders + fills over WS, bid/ask from the real order book.`);
  connectBinance();
  connectFeatureBook();
  connectPublicBook(BFX_SYMBOL, () => { onBookUpdate().catch((err) => console.error("onBookUpdate error:", err)); });
  connectAuthenticated();
  setInterval(() => { onFeatureTick().catch((err) => console.error("onFeatureTick error:", err)); }, FEATURE_TICK_MS);
  startWatchdog();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
