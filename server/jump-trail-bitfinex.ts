// REAL MONEY — ETH Jump Trail + ratchet, replacing Z-score + fixed OCO (0.1%/0.2%) on
// 2026-09-07.
//
// WHY: real trading confirmed Worker 2's OCO exit was tracking its own backtest 2.18x worse
// (real -3.046% vs backtest -1.400% over the same window) while Worker 1's Jump+ratchet on BTC
// tracked almost exactly (real -1.624% vs backtest -1.658%, verified independently trade-by-
// trade). OCO's fixed SL is where a real trade already showed -0.216% loss against an intended
// -0.1% stop -- structurally the most exposed exit to a fast market gap. A trailing/ratchet exit
// doesn't have that fixed-price-target fragility. Switching Worker 2 to the same Jump+ratchet
// design already proven on Worker 1, on ETH -- the strongest backtest of the whole session.
//
// STRATEGY: jump>=0.02% in a 2s rolling window, ratcheting stop exit (SL=ARM=0.1%): entry-0.1%
// initial stop, moves to breakeven once price clears entry, resumes trailing peak-0.1% once price
// clears entry+0.1%. 2yr backtest, real spread 0.0072% half: $58,825.85 total (fixed $1000/trade),
// 33.8% win rate, 2/104 losing weeks -- the strongest number of any config tested this session.
//
// EXECUTION: reuses the proven WS-native path (lib/bitfinex-trading-ws.ts) -- orders over the
// authenticated WS, fills accumulated across every `te` partial-fill event, bid/ask from the real
// order book, not the throttled ticker. Same latency logging as both other live bots.
//
// SIGNAL: Binance ETHUSDT's own mid-price ((bestBid+bestAsk)/2 from bookTicker), not raw
// last-trade price -- avoids biasing the jump calc toward whichever side of the spread the last
// print hit.
//
// DB: reuses Worker 2's existing Render service/API key/DB tables (still named
// sol_jump_trail_bitfinex_* internally -- same precedent as every other worker this session).
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import WebSocket from "ws";
import os from "os";
import crypto from "crypto";
import {
  getSolJumpTrailBitfinexState, updateSolJumpTrailBitfinexState, recordSolJumpTrailBitfinexTrade,
  logSolJumpTrailBitfinexRun, type SolJumpTrailBitfinexState,
} from "../lib/sol-jump-trail-bitfinex-db";
import { submitMarketOrderSafe } from "../lib/bitfinex-auth";
import {
  connectPublicBook, getBookBidAsk, isBookReady, bookMessageAge,
  connectAuthenticated, getLiveBalance, isWalletReady, submitMarketOrderFast,
} from "../lib/bitfinex-trading-ws";

const BFX_SYMBOL       = "tETHUSD";
const BINANCE_WS       = "wss://stream.binance.com:9443/ws/ethusdt@bookTicker";
const JUMP_PCT         = 0.02;
const ROLL_MS          = 2000;
const TRAIL_PCT        = 0.1;
const ARM_PCT          = 0.1; // price must clear entry + this% before the stop trails past breakeven
const SEED_USD         = 20;
const HEARTBEAT_MS     = 10_000;
const LOCK_STALE_MS    = 30_000;
const DB_WRITE_THROTTLE_MS = 2_000;
const RUN_LOG_INTERVAL_MS  = 5 * 60_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const BOOK_STALE_MS        = 15_000;
const BOOK_EMERGENCY_MS    = 25_000;

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

let state: SolJumpTrailBitfinexState;
let lastDbWrite = 0;
let lastRunLog = 0;
let lastSkipLog = 0;
const SKIP_LOG_THROTTLE_MS = 30_000;
let orderInFlight = false;
let emergencyInProgress = false;
let binBuf: { t: number; p: number }[] = [];

async function acquireLock(): Promise<boolean> {
  state = await getSolJumpTrailBitfinexState();
  const heartbeatAge = state.lock_heartbeat ? Date.now() - new Date(state.lock_heartbeat).getTime() : Infinity;
  if (state.lock_owner && heartbeatAge < LOCK_STALE_MS) {
    console.error(`Refusing to start: lock held by ${state.lock_owner}, last heartbeat ${heartbeatAge}ms ago`);
    return false;
  }
  await updateSolJumpTrailBitfinexState({ lock_owner: INSTANCE_ID, lock_heartbeat: new Date().toISOString() });
  console.log(`Lock acquired as ${INSTANCE_ID}`);
  return true;
}

async function heartbeat() {
  const fresh = await getSolJumpTrailBitfinexState();
  if (fresh.lock_owner !== INSTANCE_ID) {
    console.error(`Lost lock to ${fresh.lock_owner} — another instance took over. Exiting.`);
    process.exit(1);
  }
  if (orderInFlight) {
    state.enabled = fresh.enabled;
  } else {
    state = fresh;
  }
  await updateSolJumpTrailBitfinexState({ lock_heartbeat: new Date().toISOString() });
}

async function releaseLock() {
  try {
    const fresh = await getSolJumpTrailBitfinexState();
    if (fresh.lock_owner === INSTANCE_ID) {
      await updateSolJumpTrailBitfinexState({ lock_owner: null, lock_heartbeat: null });
      console.log("Lock released cleanly.");
    }
  } catch (err) { console.error("releaseLock failed:", err); }
}

// Ratcheting stop: entry-0.1% until price pushes above entry (then breakeven), then trailing
// peak-0.1% once price clears entry+0.1%.
function computeStop(entryPrice: number, extremePrice: number): number {
  const armThreshold = entryPrice * (1 + ARM_PCT / 100);
  if (extremePrice >= armThreshold) return extremePrice * (1 - TRAIL_PCT / 100);
  if (extremePrice > entryPrice) return entryPrice;
  return entryPrice * (1 - TRAIL_PCT / 100);
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
      logSolJumpTrailBitfinexRun({ actions: [{ action: "SKIPPED", jumpPct, reason }] }).catch(() => {});
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
    console.log(`BUY signal (jump=${jumpPct.toFixed(4)}%) @ ask=${bfxAsk.toFixed(4)} qty~=${estQty.toFixed(6)} (real USD=${realUsd.toFixed(2)}) — submitting real order...`);
    const fill = await submitMarketOrderFast(BFX_SYMBOL, estQty);
    const totalLatencyMs = Date.now() - signalTime;
    const patch = {
      mode: "LONG" as const, sol_quantity: fill.execAmount, entry_price: fill.execPrice,
      entry_time: new Date().toISOString(), usd_balance: 0,
      extreme_price: fill.execPrice, stop_price: computeStop(fill.execPrice, fill.execPrice),
    };
    state = { ...state, ...patch };
    await updateSolJumpTrailBitfinexState(patch);
    lastDbWrite = Date.now();
    console.log(`BUY FILLED price=${fill.execPrice.toFixed(4)} qty=${fill.execAmount.toFixed(6)} fee=${fill.fee} jump=${jumpPct.toFixed(4)}% fillLatencyMs=${fill.latencyMs} totalLatencyMs=${totalLatencyMs}`);
    await logSolJumpTrailBitfinexRun({ actions: [{ action: "BUY", price: fill.execPrice, qty: fill.execAmount, orderId: fill.orderId, jumpPct, fillLatencyMs: fill.latencyMs, totalLatencyMs }] });
    lastRunLog = Date.now();
    binBuf = [binBuf[binBuf.length - 1]]; // reset jump window so we don't immediately re-trigger
  } catch (err) {
    console.error("BUY order failed:", err);
    await logSolJumpTrailBitfinexRun({ actions: [{ action: "ERROR", stage: "buy", error: String(err) }] });
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
      const origQty = state.sol_quantity!;
      const origEntryTime = state.entry_time!;
      const realEth = getLiveBalance("ETH");
      const sellQty = isWalletReady() ? Math.min(origQty, realEth) : origQty;
      if (sellQty <= 0) throw new Error(`No real ETH available to sell (tracked=${origQty}, real=${realEth})`);
      console.log(`STOP signal, selling ${sellQty.toFixed(6)} ETH (tracked=${origQty.toFixed(6)}, real=${realEth.toFixed(6)}) — submitting real order...`);
      const fill = await submitMarketOrderFast(BFX_SYMBOL, -sellQty);
      const totalLatencyMs = Date.now() - signalTime;
      const usdOut = fill.execPrice * Math.abs(fill.execAmount);
      const usdIn  = origEntryPrice * Math.abs(fill.execAmount);
      const pnlUsd = usdOut - usdIn;
      const pnlPct = (pnlUsd / usdIn) * 100;

      const patch = {
        mode: "FLAT" as const, sol_quantity: null, entry_price: null, entry_time: null,
        usd_balance: usdOut, extreme_price: null, stop_price: null,
      };
      state = { ...state, ...patch };
      await updateSolJumpTrailBitfinexState(patch);
      await recordSolJumpTrailBitfinexTrade({
        direction: "LONG", entry_price: origEntryPrice, exit_price: fill.execPrice, sol_quantity: Math.abs(fill.execAmount),
        usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct, entry_time: origEntryTime,
        jump_pct: 0,
      });
      lastDbWrite = Date.now();
      console.log(`STOP FILLED price=${fill.execPrice.toFixed(4)} pnlUsd=${pnlUsd.toFixed(4)} pnlPct=${pnlPct.toFixed(4)} fillLatencyMs=${fill.latencyMs} totalLatencyMs=${totalLatencyMs}`);
      await logSolJumpTrailBitfinexRun({ actions: [{ action: "EXIT", direction: "LONG", price: fill.execPrice, pnlUsd, pnlPct, orderId: fill.orderId, fillLatencyMs: fill.latencyMs, totalLatencyMs }] });
      lastRunLog = Date.now();
    } catch (err) {
      console.error("SELL order failed:", err);
      await logSolJumpTrailBitfinexRun({ actions: [{ action: "ERROR", stage: "sell", error: String(err) }] });
    } finally {
      orderInFlight = false;
    }
    return;
  } else if (bid > extreme) {
    state = { ...state, extreme_price: bid, stop_price: computeStop(entryPrice, bid) };
    if (Date.now() - lastDbWrite > DB_WRITE_THROTTLE_MS) {
      await updateSolJumpTrailBitfinexState({ extreme_price: state.extreme_price, stop_price: state.stop_price });
      lastDbWrite = Date.now();
    }
  }

  if (Date.now() - lastRunLog > RUN_LOG_INTERVAL_MS) {
    await logSolJumpTrailBitfinexRun({
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
    await logSolJumpTrailBitfinexRun({ actions: [{ action: "ERROR", stage: "watchdog", error: reason }] }).catch(() => {});
    const fresh = await getSolJumpTrailBitfinexState();
    if (fresh.mode !== "LONG" || !fresh.sol_quantity) {
      console.error("Watchdog: not holding per DB state, nothing to flatten.");
      return;
    }
    const fill = await submitMarketOrderSafe(BFX_SYMBOL, -fresh.sol_quantity, "ETH");
    const usdOut = fill.execPrice * Math.abs(fill.execAmount);
    const usdIn = fresh.entry_price! * fresh.sol_quantity;
    const pnlUsd = usdOut - usdIn;
    const pnlPct = (pnlUsd / usdIn) * 100;
    await updateSolJumpTrailBitfinexState({
      mode: "FLAT", sol_quantity: null, entry_price: null, entry_time: null,
      usd_balance: usdOut, extreme_price: null, stop_price: null, enabled: false,
    });
    await recordSolJumpTrailBitfinexTrade({
      direction: "LONG", entry_price: fresh.entry_price!, exit_price: fill.execPrice, sol_quantity: fresh.sol_quantity,
      usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct, entry_time: fresh.entry_time!,
      jump_pct: 0,
    });
    console.error(`EMERGENCY FLATTEN complete @ ${fill.execPrice}, pnlPct=${pnlPct.toFixed(4)}. Bot paused (enabled=false).`);
    await logSolJumpTrailBitfinexRun({ actions: [{ action: "EXIT", direction: "LONG", price: fill.execPrice, pnlUsd, pnlPct, orderId: fill.orderId, emergency: true }] }).catch(() => {});
  } catch (err) {
    console.error("EMERGENCY FLATTEN FAILED:", err);
    await logSolJumpTrailBitfinexRun({ actions: [{ action: "ERROR", stage: "watchdog-flatten-failed", error: String(err) }] }).catch(() => {});
  } finally {
    process.exit(1);
  }
}

function startWatchdog() {
  setInterval(() => {
    const staleMs = bookMessageAge();
    if (staleMs < BOOK_STALE_MS) return;

    if (state.mode === "LONG" && staleMs >= BOOK_EMERGENCY_MS && !emergencyInProgress) {
      emergencyFlatten(`Order book feed silent for ${Math.round(staleMs / 1000)}s while holding ETH`)
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

  console.log(`Starting LIVE ETH Jump Trail (ratchet, WS execution) worker (${INSTANCE_ID}), enabled=${state.enabled}, mode=${state.mode}`);
  console.log(`REAL MONEY — jump>=${JUMP_PCT}% (2s window) triggers a real buy on ${BFX_SYMBOL}. Seed $${SEED_USD}, compounding, ratchet stop (initial -${TRAIL_PCT}%, breakeven at entry, trail past +${ARM_PCT}%). Orders + fills over WS, bid/ask from the real order book.`);
  connectBinance();
  connectPublicBook(BFX_SYMBOL, () => { onBookUpdate().catch((err) => console.error("onBookUpdate error:", err)); });
  connectAuthenticated();
  startWatchdog();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
