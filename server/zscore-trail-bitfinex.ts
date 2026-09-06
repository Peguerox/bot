// REAL MONEY — converted 2026-09-05 (again) from SOL Jump Trail back to SOL Z-score, on Worker
// 1's existing Render service/API key/DB tables (still named eth_zscore_bitfinex_* internally --
// kept as-is, same precedent used throughout this session).
//
// WHY: Jump's entries are momentum bursts, and its failure mode is a fast reversal -- exactly the
// moment a market-order stop suffers the worst slippage (thin book at speed). Real trade audit
// this session found 9/34 SOL Jump trades and 5/26 ETH Jump trades slipped meaningfully past the
// modeled stop (SOL: 0.51 pct-points of total slippage across the session, ETH: 0.24). Z-score's
// mean-reversion entries don't chase a breakout, so the same execution risk doesn't apply on
// entry -- moving both workers back to Z-score to see if it holds up better in real execution,
// even though every backtest this session rated raw Jump higher on paper.
//
// SIGNAL: continuous rolling z-score against Binance SOLUSDT's own mid-price ((bestBid+bestAsk)/2
// from bookTicker), NOT raw last-trade price. Window = last 25 completed 1-minute mid-price
// closes, checked continuously in real time (not gated to candle close). Entry: z <= -2.0 while
// flat.
//
// EXIT: fixed OCO, SL=0.1% / TP=0.4% -- switched from the ratchet 2026-09-05 night after real
// trades showed wins averaging ~1.6-1.7x smaller than losses under the ratchet (small breakeven
// exits, rare big trail wins that mean-reversion entries don't reliably produce). Backtested 2yr
// real spread: ETH +$1,980 total (21.0% win rate, 41/104 losing weeks), SOL +$1,922 (20.8%,
// 32/104) -- both positive but far weaker than the ratchet's $13,012/7-losing-weeks on ETH.
// Requested anyway to see real-money behavior directly instead of trusting backtest numbers that
// have repeatedly overstated real performance this session.
//
// SINGLE-INSTANCE GUARANTEE + WATCHDOG + SHARED-WALLET FIX: same proven pattern as
// jump-trail-bitfinex.ts -- lock row with heartbeat, emergency-flatten via a fresh REST price if
// the Bitfinex ticker goes silent while holding, real live-balance check before every order.
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

const BFX_SYMBOL       = "tSOLUSD";
const BINANCE_WS       = "wss://stream.binance.com:9443/ws/solusdt@bookTicker";
const ZSCORE_WINDOW_MIN = 25;
const Z_ENTRY           = -2.0;
const SL_PCT           = 0.1;
const TP_PCT           = 0.2; // tighter TP, requested despite backtesting negative (2yr SOL: -$3,907, 93/104 losing weeks) to see real behavior
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
let lastSkipLog = 0;
const SKIP_LOG_THROTTLE_MS = 30_000;

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
  if (bfxAsk === null || bfxBid === null) { logSkip("Bitfinex ticker not connected yet (bfxAsk/bfxBid null)"); return; }
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
    const fill = await submitMarketOrder(BFX_SYMBOL, estQty);
    const slPrice = fill.execPrice * (1 - SL_PCT / 100);
    const tpPrice = fill.execPrice * (1 + TP_PCT / 100);
    const patch = {
      mode: "LONG" as const, eth_quantity: fill.execAmount, entry_price: fill.execPrice,
      entry_time: new Date().toISOString(), usd_balance: 0,
      extreme_price: tpPrice, stop_price: slPrice, entry_spread_pct: entrySpreadPct, // extreme_price repurposed to hold the fixed TP target (no ratchet)
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

  const slPrice = state.stop_price!;
  const tpPrice = state.extreme_price!; // repurposed to hold the fixed TP target (no ratchet)

  if (bid <= slPrice || bid >= tpPrice) {
    orderInFlight = true;
    try {
      const origEntryPrice = state.entry_price!;
      const origQty = state.eth_quantity!;
      const origEntryTime = state.entry_time!;
      const origEntrySpread = state.entry_spread_pct;
      const realSol = getLiveBalance("SOL");
      const sellQty = isWalletReady() ? Math.min(origQty, realSol) : origQty;
      if (sellQty <= 0) throw new Error(`No real SOL available to sell (tracked=${origQty}, real=${realSol})`);
      console.log(`${bid >= tpPrice ? "TP" : "SL"} signal, selling ${sellQty.toFixed(4)} SOL (tracked=${origQty.toFixed(4)}, real=${realSol.toFixed(4)}) — submitting real order...`);
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
      console.log(`EXIT FILLED price=${fill.execPrice.toFixed(4)} pnlUsd=${pnlUsd.toFixed(4)} pnlPct=${pnlPct.toFixed(4)}`);
      await logEthZscoreBitfinexRun({ actions: [{ action: "EXIT", price: fill.execPrice, pnlUsd, pnlPct, orderId: fill.orderId }] });
      lastRunLog = Date.now();
    } catch (err) {
      console.error("SELL order failed:", err);
      await logEthZscoreBitfinexRun({ actions: [{ action: "ERROR", stage: "sell", error: String(err) }] });
    } finally {
      orderInFlight = false;
    }
    return;
  }

  if (Date.now() - lastRunLog > RUN_LOG_INTERVAL_MS) {
    await logEthZscoreBitfinexRun({
      actions: [{ action: "STATUS", mode: state.mode, bid, ask, tp: tpPrice, sl: slPrice }],
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
    const staleMs = Date.now() - lastBfxMessageTime;
    if (staleMs < BFX_STALE_MS) return;

    if (state.mode === "LONG" && staleMs >= BFX_EMERGENCY_MS && !emergencyInProgress) {
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

  console.log(`Starting LIVE SOL Z-score (ratchet) worker (${INSTANCE_ID}), enabled=${state.enabled}, mode=${state.mode}`);
  console.log(`REAL MONEY — z<=${Z_ENTRY} (${ZSCORE_WINDOW_MIN}min rolling window) triggers a real buy on ${BFX_SYMBOL}. Seed $${SEED_USD}, compounding, fixed OCO (SL=-${SL_PCT}%, TP=+${TP_PCT}%, no ratchet).`);
  connectBinance();
  connectBitfinex();
  connectWalletBalances();
  startWatchdog();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
// redeploy nudge 2026-09-06T17:47:09Z
