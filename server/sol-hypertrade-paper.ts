// PAPER TRADING — SOL hypertrading continuous-grid DCA, variable-rate formula, Worker 2.
//
// No real orders, no real money. Runs against Bitfinex's live public order book (WebSocket) so
// fills use the REAL bid/ask spread at the moment of each trade, not an assumed slippage %.
// Position sizing is UNLIMITED (uncapped DCA depth) — see lib/sol-hypertrade-config.ts for the
// formula and docs/hypertrade_variable_rate_formula_ORIGINAL.md for the derivation. Independently
// re-verified: max level ever reached was 9 on both Binance Global (5yr) and Bitfinex (2yr), real
// bare reserve $2,535.17 per $100 base bet (zero cushion), zero cycles closed at a realized loss
// in either test. Deployed reserve is 30x, one level of margin beyond the bare historical max --
// see lib/sol-hypertrade-config.ts and docs/hypertrade_formula_database.md.
//
// STRATEGY (continuous grid, no directional entry signal): always in a position, re-enter
// immediately after every close. Unlike the earlier fixed-multiplier version, purchase size,
// DCA drop gap, and take-profit target all vary by level (see lib/sol-hypertrade-config.ts):
//   - size multiplier starts at ~1.66x and decays toward 1x as levels stack
//   - drop gap starts at ~8.03% and widens slowly, so depth requires a real crash
//   - TP target starts at ~1.52% and shrinks toward a 0.05% floor as levels stack, so a deep
//     rescue only needs a small bounce to exit, not a full recovery
//
// COMPOUNDING: base bet size = current balance (SEED_USD + realized P&L) / RESERVE_DIVISOR, so
// the position size grows with the account and the worst-case reserve requirement always scales
// with what's actually available — confirmed self-sufficient in backtest across 2,087 cycles.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import os from "os";
import crypto from "crypto";
import {
  getSolHypertradePaperState, updateSolHypertradePaperState, recordSolHypertradePaperTrade,
  logSolHypertradePaperRun, type SolHypertradePaperState, type HypertradePosition,
} from "../lib/sol-hypertrade-paper-db";
import { connectPublicBook, getBookBidAsk, isBookReady, bookMessageAge } from "../lib/bitfinex-trading-ws";
import { multForLevel, dropPctForLevel, tpPctForLevel, RESERVE_DIVISOR, SEED_USD } from "../lib/sol-hypertrade-config";

const BFX_SYMBOL = "tSOLUSD";
const HEARTBEAT_MS = 10_000;
const LOCK_STALE_MS = 15_000; // 1.5x heartbeat -- see the Render redeploy crash-loop incident on Worker 1
const DB_WRITE_THROTTLE_MS = 2_000;
const RUN_LOG_INTERVAL_MS = 5 * 60_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const BOOK_STALE_MS = 15_000;

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

let state: SolHypertradePaperState;
let positions: HypertradePosition[] = [];
let lastDbWrite = 0;
let lastRunLog = 0;
let processing = false;

function currentBaseSizeUsd(): number {
  const balance = SEED_USD + (state.realized_pnl_usd ?? 0);
  return balance / RESERVE_DIVISOR;
}

async function acquireLock(): Promise<boolean> {
  state = await getSolHypertradePaperState();
  const heartbeatAge = state.lock_heartbeat ? Date.now() - new Date(state.lock_heartbeat).getTime() : Infinity;
  if (state.lock_owner && heartbeatAge < LOCK_STALE_MS) {
    console.error(`Refusing to start: lock held by ${state.lock_owner}, last heartbeat ${heartbeatAge}ms ago`);
    return false;
  }
  await updateSolHypertradePaperState({ lock_owner: INSTANCE_ID, lock_heartbeat: new Date().toISOString() });
  positions = (state.positions as HypertradePosition[]) ?? [];
  console.log(`Lock acquired as ${INSTANCE_ID}`);
  return true;
}

async function releaseLock() {
  try {
    const fresh = await getSolHypertradePaperState();
    if (fresh.lock_owner === INSTANCE_ID) {
      await updateSolHypertradePaperState({ lock_owner: null, lock_heartbeat: null });
      console.log("Lock released cleanly.");
    }
  } catch (err) { console.error("releaseLock failed:", err); }
}

async function heartbeat() {
  const fresh = await getSolHypertradePaperState();
  if (fresh.lock_owner !== INSTANCE_ID) {
    console.error(`Lost lock to ${fresh.lock_owner} — another instance took over. Exiting.`);
    process.exit(1);
  }
  if (!processing) {
    state = fresh;
    positions = (fresh.positions as HypertradePosition[]) ?? [];
  } else {
    state = { ...state, enabled: fresh.enabled };
  }
  await updateSolHypertradePaperState({ lock_heartbeat: new Date().toISOString() });
}

function totalQty(): number {
  return positions.reduce((sum, p) => sum + p.sol_qty, 0);
}

function tpExitPrice(): number {
  const t = tpPctForLevel(state.level);
  const avgCost = state.total_cost / totalQty();
  return avgCost * (1 + t / 100);
}

function nextDcaTrigger(): number {
  const d = dropPctForLevel(state.level + 1);
  return state.last_entry_price! * (1 - d / 100);
}

async function enterFresh(ask: number) {
  const baseSize = currentBaseSizeUsd();
  const solQty = baseSize / ask;
  positions = [{ price: ask, usd_size: baseSize, sol_qty: solQty }];
  const patch = {
    positions, total_cost: baseSize, level: 1, last_entry_price: ask,
    tp_target: baseSize * (1 + tpPctForLevel(1) / 100), cycle_start_time: new Date().toISOString(),
  };
  state = { ...state, ...patch };
  await updateSolHypertradePaperState(patch);
  lastDbWrite = Date.now();
  console.log(`ENTRY level=1 price=${ask.toFixed(4)} size=$${baseSize.toFixed(2)}`);
  await logSolHypertradePaperRun({ actions: [{ action: "ENTRY", level: 1, price: ask, size: baseSize }] });
}

async function dcaAdd(ask: number) {
  const newLevel = state.level + 1;
  const lastLegSize = positions[positions.length - 1].usd_size;
  const nextSize = lastLegSize * multForLevel(newLevel);
  const solQty = nextSize / ask;
  positions.push({ price: ask, usd_size: nextSize, sol_qty: solQty });
  const newCost = state.total_cost + nextSize;
  const patch = {
    positions, total_cost: newCost, level: newLevel, last_entry_price: ask,
    tp_target: newCost * (1 + tpPctForLevel(newLevel) / 100),
    max_level_ever: Math.max(state.max_level_ever, newLevel),
    max_cost_ever: Math.max(state.max_cost_ever, newCost),
  };
  state = { ...state, ...patch };
  await updateSolHypertradePaperState(patch);
  lastDbWrite = Date.now();
  console.log(`DCA level=${newLevel} price=${ask.toFixed(4)} size=$${nextSize.toFixed(2)} totalCost=$${newCost.toFixed(2)}`);
  await logSolHypertradePaperRun({ actions: [{ action: "DCA", level: newLevel, price: ask, size: nextSize, totalCost: newCost }] });
}

async function exitCycle(bid: number) {
  const qty = totalQty();
  const proceeds = qty * bid;
  const pnlUsd = proceeds - state.total_cost;
  const pnlPct = (pnlUsd / state.total_cost) * 100;
  const entryTime = state.cycle_start_time!;
  const barsHeldMs = Date.now() - new Date(entryTime).getTime();
  const levels = state.level;

  await recordSolHypertradePaperTrade({
    levels, total_cost: state.total_cost, proceeds, pnl_usd: pnlUsd, pnl_pct: pnlPct,
    entry_time: entryTime, bars_held_ms: barsHeldMs,
  });
  // realized_pnl_usd is bumped inside recordSolHypertradePaperTrade -- refresh state so the next
  // cycle's compounded base size reflects the new balance
  state = await getSolHypertradePaperState();
  console.log(`EXIT levels=${levels} price=${bid.toFixed(4)} pnlUsd=${pnlUsd.toFixed(2)} pnlPct=${pnlPct.toFixed(2)}% newBalance=$${(SEED_USD + state.realized_pnl_usd).toFixed(2)}`);
  await logSolHypertradePaperRun({ actions: [{ action: "EXIT", levels, price: bid, pnlUsd, pnlPct, newBalance: SEED_USD + state.realized_pnl_usd }] });
  lastRunLog = Date.now();

  // continuous grid: immediately re-enter at the same tick's ask
  const { ask } = getBookBidAsk();
  if (ask !== null) await enterFresh(ask);
}

async function onBookUpdate() {
  if (!state.enabled || processing) return;
  const { bid, ask } = getBookBidAsk();
  if (bid === null || ask === null) return;

  processing = true;
  try {
    if (state.level === 0) {
      await enterFresh(ask);
      return;
    }

    // adverse fills first (DCA), then favorable (TP) -- matches the backtest's tie-break, though
    // on live ticks this is just a processing-order choice, not an OHLC approximation anymore
    while (ask <= nextDcaTrigger()) {
      await dcaAdd(ask);
    }

    if (bid >= tpExitPrice()) {
      await exitCycle(bid);
      return;
    }

    if (Date.now() - lastRunLog > RUN_LOG_INTERVAL_MS) {
      const distToDca = ((bid / nextDcaTrigger()) - 1) * 100;
      const distToTp = ((tpExitPrice() / bid) - 1) * 100;
      console.log(`STATUS level=${state.level} bid=${bid.toFixed(4)} ask=${ask.toFixed(4)} distToNextDCA=${distToDca.toFixed(3)}% distToTP=${distToTp.toFixed(3)}%`);
      await logSolHypertradePaperRun({
        actions: [{ action: "STATUS", level: state.level, bid, ask, totalCost: state.total_cost, tpExitPrice: tpExitPrice(), distToDca, distToTp }],
      });
      lastRunLog = Date.now();
    }
  } catch (err) {
    console.error("onBookUpdate error:", err);
  } finally {
    processing = false;
  }
}

function startWatchdog() {
  setInterval(() => {
    const staleMs = bookMessageAge();
    if (staleMs >= BOOK_STALE_MS) {
      console.error(`Watchdog: order book feed silent for ${Math.round(staleMs / 1000)}s.`);
    }
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

  console.log(`Starting SOL Hypertrade PAPER worker (${INSTANCE_ID}), enabled=${state.enabled}, level=${state.level}`);
  console.log(`PAPER ONLY — no real orders. Variable-rate formula (decaying multiplier, widening DCA gap, shrinking TP), unlimited depth, compounding base=$${currentBaseSizeUsd().toFixed(2)}, real bid/ask fills from Bitfinex's live book.`);
  connectPublicBook(BFX_SYMBOL, () => { onBookUpdate().catch((err) => console.error("onBookUpdate error:", err)); });
  startWatchdog();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
