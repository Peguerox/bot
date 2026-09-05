// REAL MONEY — converted 2026-09-04 from the book-volume research logger into the ETH Jump
// Trail live bot: watch Binance ETHUSDT for a fast cumulative move (real tick data, 2s rolling
// window — the true version of the signal, not the 1-min close-to-close approximation used for
// backtesting since historical tick data isn't available), buy on Bitfinex on the thesis it
// follows with a short lag, manage with a 0.1% trailing stop.
//
// BACKTEST (1yr, Binance ETHUSDT -> Bitfinex tETHUSD, 1-min-close approximation of the jump
// signal, worst-case-consistent spread/fill methodology): at ETH's real measured spread
// (~0.004% half-spread), every threshold tested (0.02-0.05%) was strongly positive (+1115% to
// +1237%). Even at a middling 0.01% half-spread assumption, still solidly positive (+567-592%).
// Only failed at a conservative 0.02% half-spread. JUMP_PCT=0.02% had the STRONGEST returns of
// the sweep at the spread levels closest to ETH's real one (+1237.26% at 0.004%, +566.68% at
// 0.01%) — it was the least robust of the four at the hypothetical conservative 0.02% spread
// case (-690.16%, the worst of the four there), but since live spread has been running well
// under that danger zone, picked it for the stronger real-world numbers over the theoretical
// robustness of the higher thresholds.
//
// SIGNAL: Binance's own mid-price ((bestBid+bestAsk)/2 from the bookTicker stream, not raw last-
// trade price) — mid-price is the standard reference for signal generation, avoids biasing the
// jump calculation toward whichever side of the spread the last print happened to hit. Execution
// still costs realistically against Bitfinex's real ask (buy) / bid (sell), unchanged.
// as the original SOL jump-trail bot earlier this session, just on ETH now.
// EXIT: 0.1% trailing stop on Bitfinex's real bid, no take-profit, re-entry only after a fresh
// jump signal (not always-in like the pure-trail bot).
//
// SINGLE-INSTANCE GUARANTEE + WATCHDOG: same proven pattern as continuous-trail-bitfinex.ts —
// lock row with heartbeat, emergency-flatten via a fresh REST price if the Bitfinex ticker goes
// silent while holding.
//
// SHARED-WALLET FIX 2026-09-04: this bot and continuous-trail-bitfinex.ts (ETH Pure Trail) both
// trade real ETH on the SAME Bitfinex account — intentional, both run concurrently. But each
// bot's internal sol_quantity/USD tracking only reflects its OWN trades, not the other bot's,
// so the two can drift out of sync with the real combined wallet balance. This caused a real
// incident: a sell failed repeatedly for 2+ minutes with "not enough exchange balance" because
// the tracked quantity (0.0079017) didn't match the real wallet (0.00788837) after the other
// bot's concurrent trading. Fix: query the real wallet balance immediately before every buy/sell
// and cap the order size to whatever's actually available, instead of trusting internal state.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import WebSocket from "ws";
import os from "os";
import crypto from "crypto";
import {
  getSolJumpTrailBitfinexState, updateSolJumpTrailBitfinexState, recordSolJumpTrailBitfinexTrade,
  logSolJumpTrailBitfinexRun, recordSolJumpTrailBitfinexTick, type SolJumpTrailBitfinexState,
} from "../lib/sol-jump-trail-bitfinex-db";
import { submitMarketOrder, submitMarketOrderSafe } from "../lib/bitfinex-auth";
import { connectWalletBalances, getLiveBalance, isWalletReady } from "../lib/bitfinex-wallet-ws";

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
const BFX_STALE_MS         = 15_000;
const BFX_EMERGENCY_MS     = 25_000;

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

let state: SolJumpTrailBitfinexState;
let lastDbWrite = 0;
let lastRunLog = 0;
let lastBfxMessageTime = Date.now();
let bfxWs: WebSocket | null = null;
let emergencyInProgress = false;
let orderInFlight = false;
let binBuf: { t: number; p: number }[] = [];
let bfxBid: number | null = null;
let bfxAsk: number | null = null;

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
    // an order is actively being submitted/settled — don't clobber in-memory state mid-flight,
    // just keep the enabled flag current.
    state.enabled = fresh.enabled;
  } else {
    // no order in flight: DB is authoritative. Re-sync everything so any external change
    // (manual flatten/reset, dashboard pause) takes effect immediately instead of being
    // invisible until this process restarts.
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
// peak-0.1% once price clears entry+0.1%. Backtested 2yr real spread: +13% total$ vs plain
// trailing stop, losing weeks 4/104 vs 14/104 on this Jump signal.
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
  if (!state.enabled || state.mode !== "FLAT" || orderInFlight || bfxAsk === null || !isWalletReady()) return;

  const jumpPct = checkJump();
  if (jumpPct === null) return;

  orderInFlight = true;
  try {
    const targetPool = SEED_USD + (state.realized_pnl_usd ?? 0);
    const realUsd = getLiveBalance("USD");
    const cappedPool = Math.min(targetPool, realUsd);
    const estQty = cappedPool / bfxAsk;
    if (estQty <= 0) { console.log(`BUY signal but no real USD available (real=${realUsd}) — skipping.`); return; }
    console.log(`BUY signal (jump=${jumpPct.toFixed(4)}%) @ ask=${bfxAsk.toFixed(4)} qty~=${estQty.toFixed(4)} (real USD=${realUsd.toFixed(2)}) — submitting real order...`);
    const fill = await submitMarketOrder(BFX_SYMBOL, estQty);
    const extreme = fill.execPrice;
    const stop = computeStop(fill.execPrice, extreme);
    const patch = {
      mode: "LONG" as const, sol_quantity: fill.execAmount, entry_price: fill.execPrice,
      entry_time: new Date().toISOString(), usd_balance: 0,
      extreme_price: extreme, stop_price: stop,
    };
    state = { ...state, ...patch };
    await updateSolJumpTrailBitfinexState(patch);
    lastDbWrite = Date.now();
    console.log(`BUY FILLED price=${fill.execPrice.toFixed(4)} qty=${fill.execAmount.toFixed(4)} fee=${fill.fee}`);
    await logSolJumpTrailBitfinexRun({ actions: [{ action: "BUY", price: fill.execPrice, qty: fill.execAmount, orderId: fill.orderId, jumpPct }] });
    lastRunLog = Date.now();
    binBuf = [binBuf[binBuf.length - 1]]; // reset jump window so we don't immediately re-trigger
  } catch (err) {
    console.error("BUY order failed:", err);
    await logSolJumpTrailBitfinexRun({ actions: [{ action: "ERROR", stage: "buy", error: String(err) }] });
  } finally {
    orderInFlight = false;
  }
}

async function onBfxTicker(bid: number, ask: number) {
  bfxBid = bid;
  bfxAsk = ask;
  if (!state.enabled || orderInFlight || state.mode !== "LONG") return;

  recordSolJumpTrailBitfinexTick(state.entry_time!, bid).catch((err) => console.error("recordTick error:", err));

  const entryPrice = state.entry_price!;
  const extreme = state.extreme_price ?? entryPrice;
  const stop = state.stop_price ?? computeStop(entryPrice, extreme);

  if (bid <= stop) {
    orderInFlight = true;
    try {
      const origEntryPrice = state.entry_price!;
      const origQty = state.sol_quantity!;
      const origEntryTime = state.entry_time!;
      const realEth = getLiveBalance("ETH");
      const sellQty = isWalletReady() ? Math.min(origQty, realEth) : origQty;
      if (sellQty <= 0) throw new Error(`No real ETH available to sell (tracked=${origQty}, real=${realEth})`);
      console.log(`STOP signal, selling ${sellQty.toFixed(4)} ETH (tracked=${origQty.toFixed(4)}, real=${realEth.toFixed(4)}) — submitting real order...`);
      const fill = await submitMarketOrder(BFX_SYMBOL, -sellQty);
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
      console.log(`STOP FILLED price=${fill.execPrice.toFixed(4)} pnlUsd=${pnlUsd.toFixed(4)} pnlPct=${pnlPct.toFixed(4)}`);
      await logSolJumpTrailBitfinexRun({ actions: [{ action: "EXIT", direction: "LONG", price: fill.execPrice, pnlUsd, pnlPct, orderId: fill.orderId }] });
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

  console.log(`Starting LIVE ETH Jump Trail worker (${INSTANCE_ID}), enabled=${state.enabled}, mode=${state.mode}`);
  console.log(`REAL MONEY — jump>=${JUMP_PCT}% (2s window) triggers a real buy on ${BFX_SYMBOL}. Seed $${SEED_USD}, compounding, trail=${TRAIL_PCT}%.`);
  connectBinance();
  connectBitfinex();
  connectWalletBalances();
  startWatchdog();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
