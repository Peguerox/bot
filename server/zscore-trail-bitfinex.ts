// REAL MONEY — BTC Jump Trail (raw), Worker 1's existing Render service/API key/DB tables (still
// named eth_zscore_bitfinex_* internally -- kept as-is, same precedent used throughout this
// session). Converted 2026-09-07 from SOL Z-score.
//
// STRATEGY: the original, best-backtested raw Jump design (jump>=0.02% in a 2s rolling window,
// plain 0.1% trailing stop, no ratchet/OCO, no take-profit, re-entry only after a fresh signal
// while flat) -- the exact same design that backtested +1237% on ETH/1yr. Now on BTC instead:
// real measured spread 0.00772% half (sampled directly from Bitfinex's live ticker, not assumed),
// 2yr backtest on that real spread: $15,742.80 total (fixed $1000/trade), 39.7% win rate,
// 31/104 losing weeks -- solidly positive, and BTC's win rate was higher than most of tonight's
// Z-score configs.
//
// EXECUTION: reuses the proven WS-native path from tonight's rewrite (lib/bitfinex-trading-ws.ts)
// -- orders over the authenticated WS, fills accumulated across every `te` partial-fill event
// (fixed after a real stuck-position incident on Worker 2), bid/ask from the real order book, not
// the throttled ticker. Same latency logging as both other live bots.
//
// SIGNAL: Binance BTCUSDT's own mid-price ((bestBid+bestAsk)/2 from bookTicker), not raw
// last-trade price -- same reasoning as every other live bot this session (avoids biasing the
// jump calc toward whichever side of the spread the last print hit).
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

const BFX_SYMBOL       = "tBTCUSD";
const BINANCE_WS       = "wss://stream.binance.com:9443/ws/btcusdt@bookTicker";
const JUMP_PCT         = 0.02;
const ROLL_MS          = 2000;
const TRAIL_PCT        = 0.1; // plain trailing stop, no ratchet/OCO -- the original raw Jump design
const SEED_USD         = 20;
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
let binBuf: { t: number; p: number }[] = [];

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

function checkJump(): number | null {
  if (binBuf.length < 2) return null;
  const now = binBuf[binBuf.length - 1];
  while (binBuf.length > 1 && now.t - binBuf[0].t > ROLL_MS) binBuf.shift();
  const old = binBuf[0];
  const pct = (now.p - old.p) / old.p * 100;
  return pct >= JUMP_PCT ? pct : null; // long-only — spot can't short without margin
}

async function onBinTick(price: number) {
  binBuf.push({ t: Date.now(), p: price });

  const jumpPct = checkJump();
  if (jumpPct === null) return;
  const signalTime = Date.now();

  // Real signal from here on -- log WHY we don't act on it, instead of silently returning, so a
  // signal that never results in a trade is never a mystery.
  if (!state.enabled || state.mode !== "FLAT" || orderInFlight) return; // expected/routine, not worth logging
  function logSkip(reason: string) {
    if (Date.now() - lastSkipLog > SKIP_LOG_THROTTLE_MS) {
      console.log(`SIGNAL SKIPPED (jump=${jumpPct!.toFixed(4)}%): ${reason}`);
      logEthZscoreBitfinexRun({ actions: [{ action: "SKIPPED", jumpPct, reason }] }).catch(() => {});
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
    console.log(`BUY signal (jump=${jumpPct.toFixed(4)}%) @ ask=${bfxAsk.toFixed(4)} qty~=${estQty.toFixed(6)} (real USD=${realUsd.toFixed(2)}) — submitting real order...`);
    const fill = await submitMarketOrderFast(BFX_SYMBOL, estQty);
    const totalLatencyMs = Date.now() - signalTime;
    const patch = {
      mode: "LONG" as const, eth_quantity: fill.execAmount, entry_price: fill.execPrice,
      entry_time: new Date().toISOString(), usd_balance: 0,
      extreme_price: fill.execPrice, stop_price: fill.execPrice * (1 - TRAIL_PCT / 100), entry_spread_pct: entrySpreadPct,
    };
    state = { ...state, ...patch };
    await updateEthZscoreBitfinexState(patch);
    lastDbWrite = Date.now();
    console.log(`BUY FILLED price=${fill.execPrice.toFixed(4)} qty=${fill.execAmount.toFixed(6)} fee=${fill.fee} jump=${jumpPct.toFixed(4)}% fillLatencyMs=${fill.latencyMs} totalLatencyMs=${totalLatencyMs}`);
    await logEthZscoreBitfinexRun({ actions: [{ action: "BUY", price: fill.execPrice, qty: fill.execAmount, orderId: fill.orderId, jumpPct, fillLatencyMs: fill.latencyMs, totalLatencyMs }] });
    lastRunLog = Date.now();
    binBuf = [binBuf[binBuf.length - 1]]; // reset jump window so we don't immediately re-trigger
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

  const extreme = state.extreme_price ?? state.entry_price!;
  const stop = state.stop_price ?? extreme * (1 - TRAIL_PCT / 100);

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
    state = { ...state, extreme_price: bid, stop_price: bid * (1 - TRAIL_PCT / 100) };
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

  console.log(`Starting LIVE BTC Jump Trail (raw, WS execution) worker (${INSTANCE_ID}), enabled=${state.enabled}, mode=${state.mode}`);
  console.log(`REAL MONEY — jump>=${JUMP_PCT}% (2s window) triggers a real buy on ${BFX_SYMBOL}. Seed $${SEED_USD}, compounding, plain trailing stop ${TRAIL_PCT}%, no ratchet/OCO. Orders + fills over WS, bid/ask from the real order book.`);
  connectBinance();
  connectPublicBook(BFX_SYMBOL, () => { onBookUpdate().catch((err) => console.error("onBookUpdate error:", err)); });
  connectAuthenticated();
  startWatchdog();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
