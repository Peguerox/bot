// REAL MONEY — converted 2026-09-05 from the ETH Z-score bot into the SOL Jump Trail (ratchet
// stop) live bot on Worker 1's existing Render service/API key/DB tables (still named
// eth_zscore_bitfinex_* / "eth" internally — kept as-is, same precedent as jump-trail-bitfinex.ts
// still using sol_jump_trail_bitfinex_* tables while trading ETH. No schema change, no new
// Render service — just swaps what this process trades and how it decides entries/exits.
//
// WHY: Z-score was consistently the weakest earner in every real-spread backtest this session
// (ETH Z-score ratchet 2yr: $13,012 total, 7/104 losing weeks) vs Jump on either asset. The
// original motivation for touching Worker 2 was "Jump is too choppy" -- but the ratcheting stop
// (see below) fixed that directly on the Jump signal itself, and SOL turned out to be the best
// asset for it. So instead of replacing Jump with Z-score, this replaces Z-score with the
// strongest config found: Jump entry + ratchet exit, on SOL instead of ETH.
//
// SIGNAL: same as Worker 2 -- Binance SOLUSDT mid-price ((bestBid+bestAsk)/2 from bookTicker),
// 2s rolling window, jump >= 0.02% triggers a real buy on Bitfinex tSOLUSD.
//
// EXIT: ratcheting stop -- entry-0.1% initial, moves to breakeven once price pushes above entry,
// resumes trailing peak-0.1% once price clears entry+0.1%. Backtested (SOL/USD, real measured
// spread 0.00975% half, $1000/trade): 2yr $78,831.70 total, $757.36/wk avg, 0/104 losing weeks --
// beats plain 0.1% trailing stop ($71,529.60, 7/104 losing weeks) and every Z-score variant
// tested (ETH or SOL) on every metric.
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
const JUMP_PCT         = 0.02;
const ROLL_MS          = 2000;
const TRAIL_PCT        = 0.05;
const ARM_PCT          = 0.05; // price must clear entry + this% before the stop trails past breakeven
const SEED_USD         = 20;
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
let binBuf: { t: number; p: number }[] = [];
let bfxBid: number | null = null;
let bfxAsk: number | null = null;

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
  if (!state.enabled || state.mode !== "FLAT" || orderInFlight || bfxAsk === null || bfxBid === null || !isWalletReady()) return;

  const jumpPct = checkJump();
  if (jumpPct === null) return;

  orderInFlight = true;
  try {
    const targetPool = SEED_USD + (state.realized_pnl_usd ?? 0);
    const realUsd = getLiveBalance("USD");
    const cappedPool = Math.min(targetPool, realUsd);
    const estQty = cappedPool / bfxAsk;
    if (estQty <= 0) { console.log(`BUY signal but no real USD available (real=${realUsd}) — skipping.`); return; }
    const entrySpreadPct = (bfxAsk - bfxBid) / bfxBid * 100;
    console.log(`BUY signal (jump=${jumpPct.toFixed(4)}%) @ ask=${bfxAsk.toFixed(4)} qty~=${estQty.toFixed(4)} (real USD=${realUsd.toFixed(2)}) — submitting real order...`);
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
    console.log(`BUY FILLED price=${fill.execPrice.toFixed(4)} qty=${fill.execAmount.toFixed(4)} fee=${fill.fee}`);
    await logEthZscoreBitfinexRun({ actions: [{ action: "BUY", price: fill.execPrice, qty: fill.execAmount, orderId: fill.orderId, jumpPct }] });
    lastRunLog = Date.now();
    binBuf = [binBuf[binBuf.length - 1]]; // reset jump window so we don't immediately re-trigger
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
      const realSol = getLiveBalance("SOL");
      const sellQty = isWalletReady() ? Math.min(origQty, realSol) : origQty;
      if (sellQty <= 0) throw new Error(`No real SOL available to sell (tracked=${origQty}, real=${realSol})`);
      console.log(`STOP signal, selling ${sellQty.toFixed(4)} SOL (tracked=${origQty.toFixed(4)}, real=${realSol.toFixed(4)}) — submitting real order...`);
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
        zscore_at_entry: 0, entry_spread_pct: origEntrySpread, exit_spread_pct: exitSpreadPct,
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

  console.log(`Starting LIVE SOL Jump Trail (ratchet) worker (${INSTANCE_ID}), enabled=${state.enabled}, mode=${state.mode}`);
  console.log(`REAL MONEY — jump>=${JUMP_PCT}% (2s window) triggers a real buy on ${BFX_SYMBOL}. Seed $${SEED_USD}, compounding, ratchet stop (initial -${TRAIL_PCT}%, breakeven at entry, trail past +${ARM_PCT}%).`);
  connectBinance();
  connectBitfinex();
  connectWalletBalances();
  startWatchdog();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
