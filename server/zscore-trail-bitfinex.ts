// REAL MONEY (once enabled — starts disabled) — ETH Z-score live bot.
//
// SIGNAL: continuous rolling z-score against Binance ETHUSDT's own mid-price ((bestBid+bestAsk)/2
// from the bookTicker stream, not raw last-trade price -- mid-price is the standard reference for
// signal generation, avoids biasing the z-score toward whichever side of the spread the last
// print hit). Window = the last 25 completed 1-minute mid-price closes (~same lookback as the
// original SOLFDUSD paper bot's 5x5min design), but instead of only checking once per 5-min
// candle close, this checks the LIVE price continuously in real time — reacts the moment z
// crosses the threshold instead of waiting for the next candle. Entry: z <= -2.0 (price 2
// std-devs below its recent mean) while flat. Execution still costs realistically against
// Bitfinex's real ask (buy) / bid (sell), unchanged.
//
// EXIT: 0.1% trailing stop on Bitfinex's real bid — NOT the original fixed TP+1.0%/SL-0.1% OCO.
// Backtested both on ETH/Bitfinex with real spread (1yr): OCO only made $745 total at a 10.3% win
// rate (the tight -0.1% SL eats ~14% of its own distance to spread on a real venue, unlike the
// 0%-fee FDUSD pair the OCO was designed for); the trailing exit made $2,878 at 36.6% win rate,
// less than half the losing weeks. Trailing exit is the one actually worth running for real.
//
// 1yr backtest comparison (fixed $1000/trade, real spread, TRAIL=0.1%) vs the live Jump Trail bot:
//   Jump Trail: $8,834.87 total, 17/52 losing weeks
//   Z-score:    $2,878.55 total,  8/52 losing weeks
// Jump earns more; z-score is far steadier (less than half the bad weeks). Built as an
// alternative/replacement candidate, not yet decided which one runs for real.
//
// Same proven infra as jump-trail-bitfinex.ts: single-instance lock+heartbeat, watchdog,
// emergency-flatten, submitMarketOrderSafe (shared-wallet-safe retry).
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import WebSocket from "ws";
import os from "os";
import crypto from "crypto";
import {
  getEthZscoreBitfinexState, updateEthZscoreBitfinexState, recordEthZscoreBitfinexTrade,
  logEthZscoreBitfinexRun, type EthZscoreBitfinexState,
} from "../lib/eth-zscore-bitfinex-db";
import { submitMarketOrder, submitMarketOrderSafe } from "../lib/bitfinex-auth";
import { connectWalletBalances, getLiveBalance, isWalletReady } from "../lib/bitfinex-wallet-ws";

const BFX_SYMBOL       = "tETHUSD";
const BINANCE_WS       = "wss://stream.binance.com:9443/ws/ethusdt@bookTicker";
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
const BFX_STALE_MS         = 15_000;
const BFX_EMERGENCY_MS     = 25_000;

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

let state: EthZscoreBitfinexState;
let lastDbWrite = 0;
let lastRunLog = 0;
let lastBfxMessageTime = Date.now();
let bfxWs: WebSocket | null = null;
let emergencyInProgress = false;
let orderInFlight = false;
let bfxBid: number | null = null;
let bfxAsk: number | null = null;

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
// peak-0.1% once price clears entry+0.1%. Backtested 2yr real spread: +5% total$ vs plain
// trailing stop on this Z-score signal, losing weeks 7/104 vs 8/104.
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

  if (!state.enabled || state.mode !== "FLAT" || orderInFlight || bfxAsk === null || bfxBid === null || !isWalletReady()) return;

  const z = calcZ(price);
  if (z === null || z > Z_ENTRY) return;

  orderInFlight = true;
  try {
    const targetPool = SEED_USD + (state.realized_pnl_usd ?? 0);
    const realUsd = getLiveBalance("USD");
    const cappedPool = Math.min(targetPool, realUsd);
    const estQty = cappedPool / bfxAsk;
    if (estQty <= 0) { console.log(`BUY signal but no real USD available (real=${realUsd}) — skipping.`); return; }
    const entrySpreadPct = (bfxAsk - bfxBid) / bfxBid * 100;
    console.log(`BUY signal (z=${z.toFixed(3)}) @ ask=${bfxAsk.toFixed(4)} qty~=${estQty.toFixed(4)} (real USD=${realUsd.toFixed(2)}) — submitting real order...`);
    const fill = await submitMarketOrder(BFX_SYMBOL, estQty);
    const extreme = fill.execPrice;
    const stop = computeStop(fill.execPrice, extreme);
    const patch = {
      mode: "LONG" as const, eth_quantity: fill.execAmount, entry_price: fill.execPrice,
      entry_time: new Date().toISOString(), usd_balance: 0,
      extreme_price: extreme, stop_price: stop, entry_spread_pct: entrySpreadPct,
    };
    state = { ...state, ...patch };
    await updateEthZscoreBitfinexState(patch);
    lastDbWrite = Date.now();
    console.log(`BUY FILLED price=${fill.execPrice.toFixed(4)} qty=${fill.execAmount.toFixed(4)} fee=${fill.fee} z=${z.toFixed(3)}`);
    await logEthZscoreBitfinexRun({ actions: [{ action: "BUY", price: fill.execPrice, qty: fill.execAmount, orderId: fill.orderId, z }] });
    lastRunLog = Date.now();
  } catch (err) {
    console.error("BUY order failed:", err);
    await logEthZscoreBitfinexRun({ actions: [{ action: "ERROR", stage: "buy", error: String(err) }] });
  } finally {
    orderInFlight = false;
  }
}

async function onBfxTicker(bid: number, ask: number) {
  bfxBid = bid;
  bfxAsk = ask;
  if (!state.enabled || orderInFlight || state.mode !== "LONG") return;

  const entryPrice = state.entry_price!;
  const extreme = state.extreme_price ?? entryPrice;
  const stop = state.stop_price ?? computeStop(entryPrice, extreme);

  if (bid <= stop) {
    orderInFlight = true;
    try {
      const origEntryPrice = state.entry_price!;
      const origQty = state.eth_quantity!;
      const origEntryTime = state.entry_time!;
      const origEntrySpread = state.entry_spread_pct;
      const realEth = getLiveBalance("ETH");
      const sellQty = isWalletReady() ? Math.min(origQty, realEth) : origQty;
      if (sellQty <= 0) throw new Error(`No real ETH available to sell (tracked=${origQty}, real=${realEth})`);
      console.log(`STOP signal, selling ${sellQty.toFixed(4)} ETH (tracked=${origQty.toFixed(4)}, real=${realEth.toFixed(4)}) — submitting real order...`);
      const fill = await submitMarketOrder(BFX_SYMBOL, -sellQty);
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
      console.log(`STOP FILLED price=${fill.execPrice.toFixed(4)} pnlUsd=${pnlUsd.toFixed(4)} pnlPct=${pnlPct.toFixed(4)}`);
      await logEthZscoreBitfinexRun({ actions: [{ action: "EXIT", price: fill.execPrice, pnlUsd, pnlPct, orderId: fill.orderId }] });
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
    await logEthZscoreBitfinexRun({ actions: [{ action: "ERROR", stage: "watchdog", error: reason }] }).catch(() => {});
    const fresh = await getEthZscoreBitfinexState();
    if (fresh.mode !== "LONG" || !fresh.eth_quantity) {
      console.error("Watchdog: not holding per DB state, nothing to flatten.");
      return;
    }
    const fill = await submitMarketOrderSafe(BFX_SYMBOL, -fresh.eth_quantity, "ETH");
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
    const staleMs = Date.now() - lastBfxMessageTime;
    if (staleMs < BFX_STALE_MS) return;

    if (state.mode === "LONG" && staleMs >= BFX_EMERGENCY_MS && !emergencyInProgress) {
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

  console.log(`Starting LIVE ETH Z-score worker (${INSTANCE_ID}), enabled=${state.enabled}, mode=${state.mode}`);
  console.log(`REAL MONEY (once enabled) — z<=${Z_ENTRY} (${ZSCORE_WINDOW_MIN}min rolling window) triggers a real buy on ${BFX_SYMBOL}. Seed $${SEED_USD}, compounding, trail=${TRAIL_PCT}%.`);
  connectBinance();
  connectBitfinex();
  connectWalletBalances();
  startWatchdog();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
