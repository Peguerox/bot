// REAL MONEY — converted 2026-09-03 from the single-venue Binance-jump strategy to the
// exact-zero cross-venue gap strategy (the one proven out on the paper bot,
// server/jump-trail-bitfinex.ts). The single-venue jump signal (0.02→0.01→0.02→0.03% tried)
// kept getting killed by real order slippage on Bitfinex's thin SOL/USD book — see the
// -0.43% anomalous-fill investigation. Moving to the more promising paper result instead.
//
// SIGNAL: continuously compare Binance's real ask (bookTicker) to Bitfinex's real ask
// (ticker channel). Enter LONG on Bitfinex the instant the gap is EXACTLY zero
// (gapPct === 0, no tolerance band — confirmed via a real frequency check that the gap moves
// in discrete steps, so exact equality is achievable, not absurdly strict). Long-only (spot
// can't short without margin).
//
// SETTINGS: same as the paper bot for a fair live comparison — SL_PCT=0.1% trailing stop on
// Bitfinex's real bid, no TP. Seed $20 (real money; paper bot uses $100 for its own tracking).
//
// REAL MONEY MECHANICS: entry sizes off Bitfinex's real ask, exit/stop triggers off Bitfinex's
// real bid — both via the "ticker" WS channel (true bid/ask), not an estimate. Actual
// execution price/quantity always comes from the real Bitfinex fill via lib/bitfinex-auth.ts.
//
// SINGLE-INSTANCE GUARANTEE: critical with real orders — claims a lock row (lock_owner/
// lock_heartbeat) on startup, refuses to trade if another instance's heartbeat is fresh, releases
// the lock cleanly on shutdown.
//
// INFRA NOTE: needs BOTH a Binance WS connection (signal) and a Bitfinex WS connection
// (signal + execution). Binance's global WS feed returns HTTP 451 from Render's US regions —
// this service must run in a non-US region (Frankfurt/Singapore).
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import WebSocket from "ws";
import os from "os";
import crypto from "crypto";
import {
  getSolTrailContinuousState, updateSolTrailContinuousState, recordSolTrailContinuousTrade,
  logSolTrailContinuousRun, type SolTrailContinuousState,
} from "../lib/sol-trail-continuous-db";
import { submitMarketOrder } from "../lib/bitfinex-auth";

const BFX_SYMBOL       = "tSOLUSD";
const SL_PCT           = 0.1;    // matches the paper bot's setting, for a fair live comparison
const SEED_USD         = 20;
const HEARTBEAT_MS     = 10_000;
const LOCK_STALE_MS    = 30_000;
const DB_WRITE_THROTTLE_MS = 2_000;
const RUN_LOG_INTERVAL_MS  = 5 * 60_000;

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

let state: SolTrailContinuousState;
let lastDbWrite = 0;
let lastRunLog = 0;
let orderInFlight = false;
let binanceAsk: number | null = null;
let bfxBid: number | null = null;
let bfxAsk: number | null = null;
let currentTradeGapPct: number | null = null;

async function acquireLock(): Promise<boolean> {
  state = await getSolTrailContinuousState();
  const heartbeatAge = state.lock_heartbeat ? Date.now() - new Date(state.lock_heartbeat).getTime() : Infinity;
  if (state.lock_owner && heartbeatAge < LOCK_STALE_MS) {
    console.error(`Refusing to start: lock held by ${state.lock_owner}, last heartbeat ${heartbeatAge}ms ago`);
    return false;
  }
  await updateSolTrailContinuousState({ lock_owner: INSTANCE_ID, lock_heartbeat: new Date().toISOString() });
  console.log(`Lock acquired as ${INSTANCE_ID}`);
  return true;
}

async function heartbeat() {
  const fresh = await getSolTrailContinuousState();
  if (fresh.lock_owner !== INSTANCE_ID) {
    console.error(`Lost lock to ${fresh.lock_owner} — another instance took over. Exiting.`);
    process.exit(1);
  }
  state.enabled = fresh.enabled;
  await updateSolTrailContinuousState({ lock_heartbeat: new Date().toISOString() });
}

async function releaseLock() {
  try {
    const fresh = await getSolTrailContinuousState();
    if (fresh.lock_owner === INSTANCE_ID) {
      await updateSolTrailContinuousState({ lock_owner: null, lock_heartbeat: null });
      console.log("Lock released cleanly.");
    }
  } catch (err) {
    console.error("releaseLock failed:", err);
  }
}

async function checkEntry() {
  if (!state.enabled || state.mode !== "USD" || orderInFlight || binanceAsk === null || bfxAsk === null) return;
  const gapPct = (binanceAsk - bfxAsk) / bfxAsk * 100;
  if (gapPct !== 0) return;

  orderInFlight = true;
  try {
    const targetPool = SEED_USD + (state.realized_pnl_usd ?? 0);
    const estQty = targetPool / bfxAsk; // real live ask, no estimate
    console.log(`BUY signal (gap=${gapPct.toFixed(4)}%) @ ask=${bfxAsk.toFixed(4)} qty~=${estQty.toFixed(4)} — submitting real order...`);
    const fill = await submitMarketOrder(BFX_SYMBOL, estQty);
    currentTradeGapPct = gapPct;
    const patch = {
      mode: "SOL" as const, sol_quantity: fill.execAmount, entry_price: fill.execPrice,
      entry_time: new Date().toISOString(), usd_balance: 0,
      peak_price: fill.execPrice, stop_price: fill.execPrice * (1 - SL_PCT / 100),
    };
    state = { ...state, ...patch };
    await updateSolTrailContinuousState(patch);
    lastDbWrite = Date.now();
    console.log(`BUY FILLED price=${fill.execPrice.toFixed(4)} qty=${fill.execAmount.toFixed(4)} fee=${fill.fee}`);
    await logSolTrailContinuousRun({ actions: [{ action: "BUY", price: fill.execPrice, qty: fill.execAmount, orderId: fill.orderId, gapPct }] });
    lastRunLog = Date.now();
  } catch (err) {
    console.error("BUY order failed:", err);
    await logSolTrailContinuousRun({ actions: [{ action: "ERROR", stage: "buy", error: String(err) }] });
  } finally {
    orderInFlight = false;
  }
}

async function onBfxTicker(bid: number, ask: number) {
  bfxBid = bid;
  bfxAsk = ask;
  if (!state.enabled || orderInFlight) return;

  if (state.mode !== "SOL") {
    await checkEntry();
    return;
  }

  const effSell = bid; // real live bid, no estimate — what a market sell would actually receive
  const peak = state.peak_price ?? state.entry_price!;
  const stop = state.stop_price ?? peak * (1 - SL_PCT / 100);

  if (effSell <= stop) {
    orderInFlight = true;
    try {
      const origEntryPrice = state.entry_price!;
      const origSolQty = state.sol_quantity!;
      const origEntryTime = state.entry_time!;
      const gapPct = currentTradeGapPct ?? 0;
      currentTradeGapPct = null;
      console.log(`STOP signal, selling ${origSolQty.toFixed(4)} SOL — submitting real order...`);
      const fill = await submitMarketOrder(BFX_SYMBOL, -origSolQty);
      const usdOut = fill.execPrice * Math.abs(fill.execAmount);
      const usdIn  = origEntryPrice * origSolQty;
      const pnlUsd = usdOut - usdIn;
      const pnlPct = (pnlUsd / usdIn) * 100;

      const patch = {
        mode: "USD" as const, sol_quantity: null, entry_price: null, entry_time: null,
        usd_balance: usdOut, peak_price: null, stop_price: null,
      };
      state = { ...state, ...patch };
      await updateSolTrailContinuousState(patch);
      await recordSolTrailContinuousTrade({
        entry_price: origEntryPrice, exit_price: fill.execPrice, sol_quantity: origSolQty,
        usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct, entry_time: origEntryTime,
      });
      lastDbWrite = Date.now();
      console.log(`STOP FILLED price=${fill.execPrice.toFixed(4)} pnlUsd=${pnlUsd.toFixed(4)} pnlPct=${pnlPct.toFixed(4)}`);
      await logSolTrailContinuousRun({ actions: [{ action: "STOP_FILLED", price: fill.execPrice, pnlUsd, pnlPct, orderId: fill.orderId, gapPct }] });
      lastRunLog = Date.now();
    } catch (err) {
      console.error("SELL order failed:", err);
      await logSolTrailContinuousRun({ actions: [{ action: "ERROR", stage: "sell", error: String(err) }] });
    } finally {
      orderInFlight = false;
    }
    return;
  } else if (effSell > peak) {
    state = { ...state, peak_price: effSell, stop_price: effSell * (1 - SL_PCT / 100) };
    if (Date.now() - lastDbWrite > DB_WRITE_THROTTLE_MS) {
      await updateSolTrailContinuousState({ peak_price: state.peak_price, stop_price: state.stop_price });
      lastDbWrite = Date.now();
    }
  }

  if (Date.now() - lastRunLog > RUN_LOG_INTERVAL_MS) {
    await logSolTrailContinuousRun({
      actions: [{ action: "STATUS", mode: state.mode, bid, ask, peak: state.peak_price, stop: state.stop_price }],
    });
    lastRunLog = Date.now();
  }
}

function connectBinance() {
  const ws = new WebSocket("wss://stream.binance.com:9443/ws/solusdt@bookTicker");
  ws.on("open", () => console.log("Binance bookTicker WS connected (real bid/ask)"));
  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      const ask = parseFloat(msg.a);
      if (ask) { binanceAsk = ask; checkEntry().catch((err) => console.error("checkEntry error:", err)); }
    } catch {}
  });
  ws.on("error", (e) => console.error("Binance WS error:", e));
  ws.on("close", () => { console.log("Binance WS closed, reconnecting in 2s..."); setTimeout(connectBinance, 2000); });
  return ws;
}

function connectBitfinex() {
  const ws = new WebSocket("wss://api-pub.bitfinex.com/ws/2");
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
    queue = queue.then(() => onBfxTicker(bid, ask)).catch((err) => console.error("onBfxTicker error:", err));
  });

  ws.on("error", (err) => console.error("Bitfinex WS error:", err));
  ws.on("close", () => { console.log("Bitfinex WS closed, reconnecting in 2s..."); setTimeout(connectBitfinex, 2000); });
  return ws;
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

  console.log(`Starting LIVE Jump Trail worker (${INSTANCE_ID}), enabled=${state.enabled}, mode=${state.mode}`);
  console.log(`REAL MONEY — signal: Binance ask - Bitfinex ask == exactly 0. Seed $${SEED_USD}, compounding, SL=${SL_PCT}%.`);
  connectBinance();
  connectBitfinex();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
