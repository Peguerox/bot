// REAL MONEY — SOL hypertrading continuous-grid DCA, variable-rate formula, Worker 2. Filename
// and DB tables (sol_hypertrade_paper_*) are historical from when this ran paper-only; kept
// as-is on the 2026-09-12 swap rather than renamed, same call made for Worker 1's real->paper
// conversion on the same day (see server/sol-dca-bitfinex.ts).
//
// Real money moved here FROM Worker 1 because this formula is the more thoroughly stress-tested
// of the two — see docs/hypertrade_formula_database.md and
// docs/hypertrade_sensitivity_good_bad_news.md for the full robustness case (0/48 coefficient-
// perturbation failures, 0/57 start-date failures at this reserve level, zero closed losses in
// every independent backtest run against it).
//
// Runs against Bitfinex's live public order book (WebSocket) for the best bid/ask, and the
// authenticated wallet+trading WS (lib/bitfinex-trading-ws.ts) for real balances and order
// submission/fills -- same WS-native execution path as Worker 1 used. Position sizing is
// UNLIMITED (uncapped DCA depth) -- see lib/sol-hypertrade-config.ts for the formula and
// docs/hypertrade_variable_rate_formula_ORIGINAL.md for the derivation. Independently re-verified:
// max level ever reached was 9 on both Binance Global (5yr) and Bitfinex (2yr), real bare reserve
// $2,535.17 per $100 base bet (zero cushion), zero cycles closed at a realized loss in either
// test. Deployed reserve is 35x, two levels of margin beyond the bare historical max.
//
// STRATEGY (continuous grid, no directional entry signal): always in a position, re-enter
// immediately after every close. Purchase size, DCA drop gap, and take-profit target all vary by
// level (see lib/sol-hypertrade-config.ts):
//   - size multiplier starts at ~1.66x and decays toward 1x as levels stack
//   - drop gap starts at ~8.03% and widens slowly, so depth requires a real crash
//   - TP target starts at ~1.52% and shrinks toward a 0.05% floor as levels stack, so a deep
//     rescue only needs a small bounce to exit, not a full recovery
//
// COMPOUNDING: base bet size = current balance (SEED_USD + realized P&L) / RESERVE_DIVISOR,
// capped to the real live USD/SOL wallet balance at order time (same shared-wallet-safe pattern
// as Worker 1) so a tracking drift or a concurrent real trade elsewhere on this account can never
// submit an order bigger than what's actually available.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import os from "os";
import crypto from "crypto";
import {
  getSolHypertradePaperState, updateSolHypertradePaperState, recordSolHypertradePaperTrade,
  logSolHypertradePaperRun, type SolHypertradePaperState, type HypertradePosition,
} from "../lib/sol-hypertrade-paper-db";
import { submitMarketOrderSafe } from "../lib/bitfinex-auth";
import {
  connectPublicBook, getBookBidAsk, isBookReady, bookMessageAge,
  connectAuthenticated, getLiveBalance, isWalletReady, submitMarketOrderFast,
} from "../lib/bitfinex-trading-ws";
import { multForLevel, dropPctForLevel, tpPctForLevel, RESERVE_DIVISOR, SEED_USD } from "../lib/sol-hypertrade-config";

const BFX_SYMBOL = "tSOLUSD";
const HEARTBEAT_MS = 10_000;
const LOCK_STALE_MS = 15_000; // 1.5x heartbeat -- see the Render redeploy crash-loop incident on Worker 1
const DB_WRITE_THROTTLE_MS = 2_000;
const RUN_LOG_INTERVAL_MS = 5 * 60_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const BOOK_STALE_MS = 15_000;
const BOOK_EMERGENCY_MS = 25_000;

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

let state: SolHypertradePaperState;
let positions: HypertradePosition[] = [];
let lastDbWrite = 0;
let lastRunLog = 0;
let processing = false;
let emergencyInProgress = false;

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
  const realUsd = getLiveBalance("USD");
  const cappedSize = Math.min(baseSize, realUsd);
  const qty = cappedSize / ask;
  if (qty <= 0) { console.log(`ENTRY due but no real USD available (real=${realUsd}) — skipping this tick.`); return; }

  console.log(`ENTRY level=1 @ ask=${ask.toFixed(4)} size=$${cappedSize.toFixed(2)} qty~=${qty.toFixed(6)} (real USD=${realUsd.toFixed(2)}) — submitting real order...`);
  const fill = await submitMarketOrderFast(BFX_SYMBOL, qty);
  const usdSize = fill.execPrice * Math.abs(fill.execAmount);
  positions = [{ price: fill.execPrice, usd_size: usdSize, sol_qty: Math.abs(fill.execAmount) }];
  const patch = {
    positions, total_cost: usdSize, level: 1, last_entry_price: fill.execPrice,
    tp_target: usdSize * (1 + tpPctForLevel(1) / 100), cycle_start_time: new Date().toISOString(),
    max_level_ever: Math.max(state.max_level_ever, 1),
    max_cost_ever: Math.max(state.max_cost_ever, usdSize),
  };
  state = { ...state, ...patch };
  await updateSolHypertradePaperState(patch);
  lastDbWrite = Date.now();
  console.log(`ENTRY FILLED price=${fill.execPrice.toFixed(4)} qty=${fill.execAmount.toFixed(6)} fee=${fill.fee} fillLatencyMs=${fill.latencyMs}`);
  await logSolHypertradePaperRun({ actions: [{ action: "ENTRY", level: 1, price: fill.execPrice, size: usdSize, fillLatencyMs: fill.latencyMs }] });
}

async function dcaAdd(ask: number) {
  const newLevel = state.level + 1;
  const lastLegSize = positions[positions.length - 1].usd_size;
  const nextSize = lastLegSize * multForLevel(newLevel);
  const realUsd = getLiveBalance("USD");
  const cappedSize = Math.min(nextSize, realUsd);
  const qty = cappedSize / ask;
  if (qty <= 0) { console.log(`DCA level=${newLevel} due but no real USD available (real=${realUsd}) — skipping this tick.`); return; }

  console.log(`DCA level=${newLevel} @ ask=${ask.toFixed(4)} size=$${cappedSize.toFixed(2)} qty~=${qty.toFixed(6)} (real USD=${realUsd.toFixed(2)}) — submitting real order...`);
  const fill = await submitMarketOrderFast(BFX_SYMBOL, qty);
  const usdSize = fill.execPrice * Math.abs(fill.execAmount);
  positions.push({ price: fill.execPrice, usd_size: usdSize, sol_qty: Math.abs(fill.execAmount) });
  const newCost = state.total_cost + usdSize;
  const patch = {
    positions, total_cost: newCost, level: newLevel, last_entry_price: fill.execPrice,
    tp_target: newCost * (1 + tpPctForLevel(newLevel) / 100),
    max_level_ever: Math.max(state.max_level_ever, newLevel),
    max_cost_ever: Math.max(state.max_cost_ever, newCost),
  };
  state = { ...state, ...patch };
  await updateSolHypertradePaperState(patch);
  lastDbWrite = Date.now();
  console.log(`DCA FILLED level=${newLevel} price=${fill.execPrice.toFixed(4)} qty=${fill.execAmount.toFixed(6)} totalCost=$${newCost.toFixed(2)} fillLatencyMs=${fill.latencyMs}`);
  await logSolHypertradePaperRun({ actions: [{ action: "DCA", level: newLevel, price: fill.execPrice, size: usdSize, totalCost: newCost, fillLatencyMs: fill.latencyMs }] });
}

async function exitCycle() {
  const trackedQty = totalQty();
  const realSol = getLiveBalance("SOL");
  const sellQty = isWalletReady() ? Math.min(trackedQty, realSol) : trackedQty;
  if (sellQty <= 0) throw new Error(`No real SOL available to sell (tracked=${trackedQty}, real=${realSol})`);

  const origTotalCost = state.total_cost;
  const entryTime = state.cycle_start_time!;
  const levels = state.level;

  console.log(`EXIT levels=${levels} selling ${sellQty.toFixed(6)} SOL (tracked=${trackedQty.toFixed(6)}, real=${realSol.toFixed(6)}) — submitting real order...`);
  const fill = await submitMarketOrderFast(BFX_SYMBOL, -sellQty);
  const proceeds = fill.execPrice * Math.abs(fill.execAmount);
  const pnlUsd = proceeds - origTotalCost;
  const pnlPct = (pnlUsd / origTotalCost) * 100;
  const barsHeldMs = Date.now() - new Date(entryTime).getTime();

  await recordSolHypertradePaperTrade({
    levels, total_cost: origTotalCost, proceeds, pnl_usd: pnlUsd, pnl_pct: pnlPct,
    entry_time: entryTime, bars_held_ms: barsHeldMs,
  });
  // realized_pnl_usd is bumped inside recordSolHypertradePaperTrade -- refresh state so the next
  // cycle's compounded base size reflects the new balance
  state = await getSolHypertradePaperState();
  console.log(`EXIT FILLED levels=${levels} price=${fill.execPrice.toFixed(4)} pnlUsd=${pnlUsd.toFixed(2)} pnlPct=${pnlPct.toFixed(2)}% newBalance=$${(SEED_USD + state.realized_pnl_usd).toFixed(2)} fillLatencyMs=${fill.latencyMs}`);
  await logSolHypertradePaperRun({ actions: [{ action: "EXIT", levels, price: fill.execPrice, pnlUsd, pnlPct, newBalance: SEED_USD + state.realized_pnl_usd, fillLatencyMs: fill.latencyMs }] });
  lastRunLog = Date.now();

  // continuous grid: immediately re-enter at the same tick's ask
  const { ask } = getBookBidAsk();
  if (ask !== null && isWalletReady()) await enterFresh(ask);
}

async function onBookUpdate() {
  if (!state.enabled || processing) return;
  const { bid, ask } = getBookBidAsk();
  if (bid === null || ask === null || !isWalletReady()) return;

  processing = true;
  try {
    if (state.level === 0) {
      await enterFresh(ask);
      return;
    }

    // adverse fills first (DCA), then favorable (TP) -- matches the backtest's tie-break, though
    // on live ticks this is just a processing-order choice, not an OHLC approximation anymore.
    // Guards against a real-USD shortfall turning this into an infinite loop: if dcaAdd can't
    // fill (no real balance available), level doesn't advance and nextDcaTrigger() never moves,
    // so the loop must break on a no-op instead of spinning forever.
    while (ask <= nextDcaTrigger()) {
      const levelBefore = state.level;
      await dcaAdd(ask);
      if (state.level === levelBefore) break;
    }

    if (bid >= tpExitPrice()) {
      await exitCycle();
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
    await logSolHypertradePaperRun({ actions: [{ action: "ERROR", stage: "onBookUpdate", error: String(err) }] }).catch(() => {});
  } finally {
    processing = false;
  }
}

// ---------- Watchdog: book feed staleness -> emergency flatten ----------

async function emergencyFlatten(reason: string) {
  if (emergencyInProgress) return;
  emergencyInProgress = true;
  try {
    console.error(`EMERGENCY FLATTEN triggered: ${reason}`);
    await logSolHypertradePaperRun({ actions: [{ action: "ERROR", stage: "watchdog", error: reason }] }).catch(() => {});
    const fresh = await getSolHypertradePaperState();
    if (fresh.level === 0 || fresh.positions.length === 0) {
      console.error("Watchdog: not holding per DB state, nothing to flatten.");
      return;
    }
    const qty = fresh.positions.reduce((s, p) => s + p.sol_qty, 0);
    const fill = await submitMarketOrderSafe(BFX_SYMBOL, -qty, "SOL");
    const proceeds = fill.execPrice * Math.abs(fill.execAmount);
    const pnlUsd = proceeds - fresh.total_cost;
    const pnlPct = (pnlUsd / fresh.total_cost) * 100;
    const barsHeldMs = Date.now() - new Date(fresh.cycle_start_time!).getTime();

    await updateSolHypertradePaperState({
      positions: [], total_cost: 0, level: 0, last_entry_price: null, tp_target: null,
      cycle_start_time: null, enabled: false,
    });
    await recordSolHypertradePaperTrade({
      levels: fresh.level, total_cost: fresh.total_cost, proceeds, pnl_usd: pnlUsd, pnl_pct: pnlPct,
      entry_time: fresh.cycle_start_time!, bars_held_ms: barsHeldMs,
    });
    console.error(`EMERGENCY FLATTEN complete @ ${fill.execPrice}, pnlPct=${pnlPct.toFixed(4)}. Bot paused (enabled=false).`);
    await logSolHypertradePaperRun({ actions: [{ action: "EXIT", levels: fresh.level, price: fill.execPrice, pnlUsd, pnlPct, emergency: true }] }).catch(() => {});
  } catch (err) {
    console.error("EMERGENCY FLATTEN FAILED:", err);
    await logSolHypertradePaperRun({ actions: [{ action: "ERROR", stage: "watchdog-flatten-failed", error: String(err) }] }).catch(() => {});
  } finally {
    process.exit(1);
  }
}

function startWatchdog() {
  setInterval(() => {
    const staleMs = bookMessageAge();
    if (staleMs < BOOK_STALE_MS) return;

    if (state.level > 0 && staleMs >= BOOK_EMERGENCY_MS && !emergencyInProgress) {
      emergencyFlatten(`Order book feed silent for ${Math.round(staleMs / 1000)}s while holding SOL`)
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

  console.log(`Starting SOL Hypertrade LIVE worker (${INSTANCE_ID}), enabled=${state.enabled}, level=${state.level}`);
  console.log(`REAL MONEY — Variable-rate formula (decaying multiplier, widening DCA gap, shrinking TP), unlimited depth, compounding base=$${currentBaseSizeUsd().toFixed(2)}, orders + fills over WS, bid/ask from the real order book.`);
  connectPublicBook(BFX_SYMBOL, () => { onBookUpdate().catch((err) => console.error("onBookUpdate error:", err)); });
  connectAuthenticated();
  startWatchdog();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
