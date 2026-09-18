// Worker 1 — filename/service kept for Render compatibility (5th internals swap: old VWAP+EMA DCA
// grid -> SOL Double-Crossover (paper) -> shelved Surfer-on-Bitfinex migration (never deployed) ->
// SOL/BTC Participation hybrid (archived 2026-09-17, see docs/archive/README_shelved_participation_bot.md)
// -> this, 2026-09-17). GitHub account migrated 2026-09-18, Render reconnected -- this comment
// line is the test marker for confirming auto-deploy actually fires through the new connection.
//
// SOL/BTC "size confirmation" strategy — PAPER ONLY, no real orders. Original trade-count pressure
// signal (U/W) gated by a 30-minute activity filter, with a separate tiny-trade (<0.1 SOL)
// pressure signal that lowers the entry threshold from 0.60 to 0.50 when small-trade direction
// agrees. Independently verified against the reference CSV replay (see chat, ~0.24% headline
// discrepancy) and separately verified event-for-event against a from-scratch reproduction on
// 50,000 real trade batches (100% match on every side/pending/swap decision).
//
// 2026-09-18: upgraded to the "protection" candidate — drawdown-gated asymmetric threshold
// tightening, an ER30 path-efficiency trail exit, 20s SOL-request expiry, and a failed-entry
// forced exit. This is the best-verified strategy found so far, including on a genuine
// out-of-sample window untouched by any tuning — see lib/solbtc-sizeconf-engine.ts for the
// mechanism-by-mechanism verification notes.
//
// Execution model: driven by Bitfinex's real-time public trade tape (lib/bitfinex-public-trades-ws.ts),
// NOT periodic polling — trades are buffered into same-millisecond batches exactly like the
// research CSVs, and fed through the engine as each batch closes. A 1-second wall-clock timer
// advances the 30-minute activity window across real UTC minute boundaries (forward-filling
// through minutes with zero trades) and periodically persists state.
//
// Cost model (2026-09-17, extended 2026-09-18): fill PRICE and TIMING still come from the trade
// tape exactly as verified against the reference formula (untouched) -- the COST deducted on each
// fill is the real live half-spread read off Bitfinex's public order book at the moment of the
// fill ((ask-bid)/(ask+bid)), via the same connectPublicBook() used by Worker 2. This same real
// cost now also feeds the engine's internal drawdown-tightening math (previously that used a
// separate flat assumption) -- one real number driving both what gets recorded AND how the
// strategy behaves, instead of two different cost assumptions. Falls back to the flat COST
// constant only if the book WS hasn't produced a snapshot yet (e.g. the first few seconds after
// boot) -- those fills are marked cost_pct=null in solbtc_sizeconf_trades so it's visible in the
// data which ones used a real measured spread.
//
// Known limitation: no historical backfill on restart. If the process is down, that gap in trade
// history and minute-activity data is simply missed (the engine picks back up live from wherever
// it left off) — acceptable for this feasibility test, not yet a production guarantee.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import os from "os";
import crypto from "crypto";
import { connectPublicTrades, tradesMessageAge, type Tick } from "../lib/bitfinex-public-trades-ws";
import { connectPublicBook, getBookBidAsk, isBookReady } from "../lib/bitfinex-trading-ws";
import {
  initialState, processBatch, closeMinute, COST,
  type EngineState, type Batch, type Side,
} from "../lib/solbtc-sizeconf-engine";
import {
  getSolbtcSizeconfState, updateSolbtcSizeconfState, recordSolbtcSizeconfTrade,
  logSolbtcSizeconfRun, type SolbtcSizeconfState,
} from "../lib/solbtc-sizeconf-db";

const SYMBOL = "tSOLBTC";
const TINY_SOL = 0.1;
const HEARTBEAT_MS = 10_000;
const LOCK_STALE_MS = 15_000;
const TICK_MS = 1_000; // wall-clock cadence for minute-boundary + persistence checks
const PERSIST_INTERVAL_MS = 2_000;
const RUN_LOG_INTERVAL_MS = 5 * 60_000;

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

function sideOf(s: string): Side { return s === "SOL" ? "SOL" : "BTC"; }

function engineFromRow(row: SolbtcSizeconfState): EngineState {
  return {
    side: sideOf(row.side), pending: row.pending ? sideOf(row.pending) : null,
    queuedTs: row.queued_ts, lastFillTs: row.last_fill_ts, pendingRequestQ: row.pending_request_q,
    U: row.u, W: row.w, Ut: row.ut, Wt: row.wt, lastTinyTs: row.last_tiny_ts,
    lastLogPrice: row.last_log_price, qLagPrev: row.q_lag_prev,
    respNum: row.resp_num, respDen: row.resp_den, respBuf: row.resp_buf ?? [],
    active: row.active, minuteBuf: row.minute_buf ?? [],
    windowMv: row.window_mv, windowSg: row.window_sg ?? 0, windowCt: row.window_ct,
    prevMinuteClose: row.prev_minute_close, er30: row.er30 ?? 1.0,
    logEquity: row.log_equity ?? 0, peakLogEquity: row.peak_log_equity ?? 0,
    tightened: row.tightened ?? false,
    peakSinceEntry: row.peak_since_entry, entryPrice: row.entry_price,
    entryFillTs: row.entry_fill_ts, entryReached10bps: row.entry_reached_10bps ?? false,
  };
}

function rowFromEngine(s: EngineState): Record<string, unknown> {
  return {
    side: s.side, pending: s.pending, queued_ts: s.queuedTs, last_fill_ts: s.lastFillTs,
    pending_request_q: s.pendingRequestQ,
    u: s.U, w: s.W, ut: s.Ut, wt: s.Wt, last_tiny_ts: s.lastTinyTs,
    last_log_price: s.lastLogPrice, q_lag_prev: s.qLagPrev,
    resp_num: s.respNum, resp_den: s.respDen, resp_buf: s.respBuf,
    active: s.active, minute_buf: s.minuteBuf,
    window_mv: s.windowMv, window_sg: s.windowSg, window_ct: s.windowCt,
    prev_minute_close: s.prevMinuteClose, er30: s.er30,
    log_equity: s.logEquity, peak_log_equity: s.peakLogEquity, tightened: s.tightened,
    peak_since_entry: s.peakSinceEntry, entry_price: s.entryPrice,
    entry_fill_ts: s.entryFillTs, entry_reached_10bps: s.entryReached10bps,
  };
}

let engine: EngineState = initialState();
let enabled = false;
let btcBalance = 1;
let solQty = 0;
let entryBtc: number | null = null;

let pendingBatch: Batch | null = null;
let lastClosedMinute: number | null = null;
let currentMinuteCount = 0;
let currentMinuteLastPrice: number | null = null;
let lastTickAt: number | null = null;

let dirty = false;
let lastPersist = 0;
let lastRunLog = 0;

async function acquireLock(): Promise<SolbtcSizeconfState | null> {
  const state = await getSolbtcSizeconfState();
  const heartbeatAge = state.lock_heartbeat ? Date.now() - new Date(state.lock_heartbeat).getTime() : Infinity;
  if (state.lock_owner && heartbeatAge < LOCK_STALE_MS) {
    console.error(`Refusing to start: lock held by ${state.lock_owner}, last heartbeat ${heartbeatAge}ms ago`);
    return null;
  }
  await updateSolbtcSizeconfState({ lock_owner: INSTANCE_ID, lock_heartbeat: new Date().toISOString() });
  console.log(`Lock acquired as ${INSTANCE_ID}`);
  return state;
}

async function heartbeat() {
  const fresh = await getSolbtcSizeconfState();
  if (fresh.lock_owner !== INSTANCE_ID) {
    console.error(`Lost lock to ${fresh.lock_owner} — another instance took over. Exiting.`);
    process.exit(1);
  }
  await updateSolbtcSizeconfState({ lock_heartbeat: new Date().toISOString() });
}

async function releaseLock() {
  try {
    const fresh = await getSolbtcSizeconfState();
    if (fresh.lock_owner === INSTANCE_ID) {
      await updateSolbtcSizeconfState({ lock_owner: null, lock_heartbeat: null });
      console.log("Lock released cleanly.");
    }
  } catch (err) { console.error("releaseLock failed:", err); }
}

// Real live half-spread at the moment of the fill, replacing the flat 0.02% assumption. Returns
// null (caller falls back to the flat COST constant) if the book WS hasn't snapshotted yet.
function liveCostPct(): number | null {
  if (!isBookReady()) return null;
  const { bid, ask } = getBookBidAsk();
  if (bid === null || ask === null || ask <= bid || bid <= 0) return null;
  return (ask - bid) / (ask + bid); // half-spread as a fraction of mid
}

async function applyFill(fill: { side: Side; fillPrice: number; signalTs: number; latencyS: number }, costPct: number | null) {
  const btcBefore = btcBalance, solBefore = solQty;
  const cost = costPct ?? COST;
  const signal_time = new Date(fill.signalTs * 1000).toISOString();
  const latencyNote = `latency=${fill.latencyS.toFixed(3)}s${fill.latencyS < 1.0 ? " *** BELOW 1s MINIMUM, INVESTIGATE ***" : ""}`;
  if (fill.side === "SOL") {
    const newSolQty = btcBalance * (1 - cost) / fill.fillPrice;
    entryBtc = btcBalance;
    btcBalance = 0; solQty = newSolQty;
    await recordSolbtcSizeconfTrade({
      side_after: "SOL", fill_price: fill.fillPrice, btc_before: btcBefore, sol_before: solBefore,
      btc_after: btcBalance, sol_after: solQty, pnl_btc: null, cost_pct: costPct,
      signal_time, latency_s: fill.latencyS,
    });
    console.log(`FILL -> SOL  price=${fill.fillPrice.toFixed(8)}  qty=${newSolQty.toFixed(6)}  cost=${(cost*100).toFixed(4)}%${costPct===null?" (fallback, no book yet)":" (live spread)"}  ${latencyNote}`);
  } else {
    const btcOut = solQty * fill.fillPrice * (1 - cost);
    const pnl = entryBtc !== null ? btcOut - entryBtc : null;
    btcBalance = btcOut; solQty = 0;
    await recordSolbtcSizeconfTrade({
      side_after: "BTC", fill_price: fill.fillPrice, btc_before: btcBefore, sol_before: solBefore,
      btc_after: btcBalance, sol_after: solQty, pnl_btc: pnl, cost_pct: costPct,
      signal_time, latency_s: fill.latencyS,
    });
    console.log(`FILL -> BTC  price=${fill.fillPrice.toFixed(8)}  btcOut=${btcOut.toFixed(8)}  pnl=${pnl?.toFixed(8)}  cost=${(cost*100).toFixed(4)}%${costPct===null?" (fallback, no book yet)":" (live spread)"}  ${latencyNote}`);
    entryBtc = null;
  }
}

// Real bug found 2026-09-17 via the backtest comparison: a batch used to only flush when a NEW,
// different-timestamp tick arrived -- meaning the most recent real trade always sat unprocessed
// until some future, unrelated trade happened to show up. On a thin pair like this, that future
// trade can be many minutes away (a real 8-minute gap caused a live fill to be recorded 8 minutes
// late, at a stale price, versus what a continuous backtest replay determined). Fixed by flushing
// on a short quiet-timer instead of waiting indefinitely for the next tick -- 300ms is far longer
// than any two real prints sharing the exact same millisecond would need, but short enough that a
// real trade is processed within a fraction of a second of happening, not whenever the next
// arbitrary future trade shows up.
const BATCH_FLUSH_QUIET_MS = 300;
let batchFlushTimer: NodeJS.Timeout | null = null;

function flushBatch() {
  if (batchFlushTimer) { clearTimeout(batchFlushTimer); batchFlushTimer = null; }
  if (!pendingBatch || !enabled) { pendingBatch = null; return; }
  const batch = pendingBatch;
  pendingBatch = null;
  // Real live half-spread, computed once and used consistently for BOTH the engine's internal
  // drawdown-tightening math and the recorded trade cost -- previously these could see two
  // different cost values (a separate liveCostPct() call inside applyFill, racing against book
  // updates between the two calls).
  const costPct = liveCostPct();
  const res = processBatch(engine, batch, costPct ?? COST);
  engine = res.state;
  dirty = true;
  if (res.fill) {
    applyFill(res.fill, costPct).catch((err) => console.error("applyFill failed:", err));
  }
}

function onTick(t: Tick) {
  if (!enabled) return;
  currentMinuteCount += 1;
  currentMinuteLastPrice = t.price;
  lastTickAt = Date.now();

  if (pendingBatch && pendingBatch.tsMs !== t.tsMs) flushBatch();

  if (!pendingBatch) {
    pendingBatch = {
      tsMs: t.tsMs, firstPrice: t.price, lastPrice: t.price,
      signedCount: 0, count: 0, tinySignedCount: 0, tinyCount: 0,
    };
  }
  const sign = Math.sign(t.amount);
  pendingBatch.lastPrice = t.price;
  pendingBatch.signedCount += sign;
  pendingBatch.count += 1;
  if (Math.abs(t.amount) < TINY_SOL) {
    pendingBatch.tinySignedCount += sign;
    pendingBatch.tinyCount += 1;
  }

  if (batchFlushTimer) clearTimeout(batchFlushTimer);
  batchFlushTimer = setTimeout(flushBatch, BATCH_FLUSH_QUIET_MS);
}

function advanceMinutes() {
  if (!enabled) return;
  const nowMinute = Math.floor(Date.now() / 60_000);
  if (lastClosedMinute === null) { lastClosedMinute = nowMinute - 1; return; } // don't retroactively close minutes before boot
  let closed = lastClosedMinute;
  while (closed < nowMinute - 1) {
    const closingMinute = closed + 1;
    const closePrice = currentMinuteLastPrice ?? (engine.lastLogPrice !== null ? Math.exp(engine.lastLogPrice) : null);
    if (closePrice !== null) {
      const count = closingMinute === Math.floor(Date.now() / 60_000) - 1 ? currentMinuteCount : 0;
      engine = closeMinute(engine, closePrice, count);
      dirty = true;
    }
    closed = closingMinute;
    currentMinuteCount = 0;
  }
  lastClosedMinute = closed;
}

async function persist() {
  const patch: Record<string, unknown> = {
    ...rowFromEngine(engine), btc_balance: btcBalance, sol_qty: solQty, entry_btc: entryBtc,
    last_closed_minute: lastClosedMinute, current_minute_count: currentMinuteCount,
    current_minute_last_price: currentMinuteLastPrice,
    last_tick_at: lastTickAt !== null ? new Date(lastTickAt).toISOString() : null,
  };
  await updateSolbtcSizeconfState(patch);
  dirty = false;
}

async function tick() {
  try {
    advanceMinutes();
    const now = Date.now();
    if (dirty && now - lastPersist > PERSIST_INTERVAL_MS) {
      await persist();
      lastPersist = now;
    }
    if (now - lastRunLog > RUN_LOG_INTERVAL_MS) {
      console.log(`STATUS side=${engine.side} pending=${engine.pending} active=${engine.active} `
        + `btc=${btcBalance.toFixed(8)} sol=${solQty.toFixed(6)} tradesWsAge=${tradesMessageAge()}ms`);
      await logSolbtcSizeconfRun({
        actions: [{ action: "STATUS", side: engine.side, pending: engine.pending, active: engine.active,
          btcBalance, solQty, tradesWsAgeMs: tradesMessageAge() }],
      });
      lastRunLog = now;
    }
  } catch (err) {
    console.error("tick error:", err);
  }
}

async function main() {
  const row = await acquireLock();
  if (!row) process.exit(1);

  enabled = row.enabled;
  btcBalance = row.btc_balance ?? 1;
  solQty = row.sol_qty ?? 0;
  entryBtc = row.entry_btc;
  lastClosedMinute = row.last_closed_minute;
  currentMinuteCount = row.current_minute_count ?? 0;
  currentMinuteLastPrice = row.current_minute_last_price;

  // fresh boot (never initialized) vs resuming from a saved state
  engine = row.last_log_price !== null ? engineFromRow(row) : initialState();

  const heartbeatTimer = setInterval(() => {
    heartbeat().catch((err) => console.error("heartbeat failed:", err));
  }, HEARTBEAT_MS);
  const tickTimer = setInterval(() => { tick(); }, TICK_MS);

  const shutdown = async () => {
    clearInterval(heartbeatTimer);
    clearInterval(tickTimer);
    if (pendingBatch) flushBatch(); // don't strand the last batch across a redeploy
    if (dirty) await persist().catch((err) => console.error("final persist failed:", err));
    await releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`Starting SOL/BTC Size-Confirmation PAPER worker (${INSTANCE_ID}), enabled=${enabled}.`);
  console.log(`PAPER ONLY — protection strategy: pressure + tiny-trade confirmation + activity gate + DD-tightening + ER30 trail + failed-entry exit, cost=${(COST*100).toFixed(3)}%/side, live WS trade tape.`);
  connectPublicTrades(SYMBOL, onTick);
  connectPublicBook(SYMBOL);
}

// react to enabled/disabled toggles from the dashboard without a restart
setInterval(async () => {
  try {
    const fresh = await getSolbtcSizeconfState();
    if (fresh.lock_owner === INSTANCE_ID && fresh.enabled !== enabled) {
      enabled = fresh.enabled;
      console.log(`enabled toggled -> ${enabled}`);
    }
  } catch (err) { console.error("enabled-poll failed:", err); }
}, 5_000);

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
