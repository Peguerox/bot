// Worker 1 — filename/service kept for Render compatibility (4th internals swap: old VWAP+EMA DCA
// grid -> SOL Double-Crossover (paper, 2026-09-13) -> shelved Surfer-on-Bitfinex migration (built,
// never deployed, see docs/archive/README_shelved_surfer_bitfinex_migration.md) -> this,
// 2026-09-16).
//
// SOL/BTC "participation" hybrid strategy — PAPER ONLY, no real orders. Combines a fast CUSUM
// regime detector with a slower trend + price-confirmation signal, switching between them based
// on how reliable the fast signal's own recent track record has been (so it doesn't trade
// constantly the way the pure fast CUSUM does — 182-9,907 swaps/year instead of 24,000-54,000).
// Ported line-for-line from a verified C++ research engine (matched its published results to 6
// decimal places on real Bitfinex data) — see lib/solbtc-participation-engine.ts, independently
// re-verified against the same reference engine over a fresh 20,000-row slice before this file
// was written (every state variable matched to float64 precision).
//
// Cost: 0.02%/side deducted from the paper balance on every swap — deliberately more
// conservative than the measured real Bitfinex spread (~0.01555%/side); at 0.02% the most recent
// year's backtest is right at the edge (was -8.35% at exactly 0.02% in the original SOLBTC-only
// backtest; the current parameters here are unaffected by that since this file always uses 0.02%).
//
// Execution model: polls Bitfinex's real public 1-minute SOLBTC candles every 20s (well inside
// the strategy's 1-minute decision granularity) and feeds any newly-closed candles through the
// engine in order. Fills are simulated at the next candle's OPEN once that candle has real volume
// (fill_mode=1 in the reference engine) — not the current price, not a guess.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import os from "os";
import crypto from "crypto";
import { getBitfinexCandlesOHLCV } from "../lib/bitfinex";
import {
  stepMinute, initialState, COST, type EngineState, type Candle, type Side,
} from "../lib/solbtc-participation-engine";
import {
  getSolbtcParticipationState, updateSolbtcParticipationState, recordSolbtcParticipationTrade,
  logSolbtcParticipationRun, type SolbtcParticipationState,
} from "../lib/solbtc-participation-db";

const SYMBOL = "tSOLBTC";
const POLL_INTERVAL_MS = 20_000;
const CANDLE_LIMIT = 200; // real trades are sparse (gaps up to 14+ min observed) -- fetch generously
const HEARTBEAT_MS = 10_000;
const LOCK_STALE_MS = 15_000;
const RUN_LOG_INTERVAL_MS = 5 * 60_000;

const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

function sideOf(s: string): Side { return s === "SOL" ? "SOL" : "BTC"; }

function stateFromRow(row: SolbtcParticipationState): EngineState {
  return {
    side: sideOf(row.side), pending: row.pending ? sideOf(row.pending) : null,
    virtualSide: sideOf(row.virtual_side), virtualPending: row.virtual_pending ? sideOf(row.virtual_pending) : null,
    base: sideOf(row.base), v: row.v, sUp: row.s_up, sDown: row.s_down,
    d: row.d, scoreV: row.score_v, m: row.m, scoreT: row.score_t,
    orientation: row.orientation === -1 ? -1 : 1,
    fastEwma: row.fast_ewma, slowEwma: row.slow_ewma, trendVariance: row.trend_variance,
    trend: row.trend === 1 ? 1 : 0, priceOk: row.price_ok === 1 ? 1 : 0, fastMode: row.fast_mode === 1 ? 1 : 0,
    lastLogPrice: row.last_log_price,
  };
}

function rowFromState(s: EngineState): Record<string, unknown> {
  return {
    side: s.side, pending: s.pending, virtual_side: s.virtualSide, virtual_pending: s.virtualPending,
    base: s.base, v: s.v, s_up: s.sUp, s_down: s.sDown,
    d: s.d, score_v: s.scoreV, m: s.m, score_t: s.scoreT, orientation: s.orientation,
    fast_ewma: s.fastEwma, slow_ewma: s.slowEwma, trend_variance: s.trendVariance,
    trend: s.trend, price_ok: s.priceOk, fast_mode: s.fastMode, last_log_price: s.lastLogPrice,
  };
}

let entryBtc: number | null = null; // BTC value at the moment we entered SOL, for PnL on the return leg
let lastRunLog = 0;

async function acquireLock(): Promise<SolbtcParticipationState | null> {
  const state = await getSolbtcParticipationState();
  const heartbeatAge = state.lock_heartbeat ? Date.now() - new Date(state.lock_heartbeat).getTime() : Infinity;
  if (state.lock_owner && heartbeatAge < LOCK_STALE_MS) {
    console.error(`Refusing to start: lock held by ${state.lock_owner}, last heartbeat ${heartbeatAge}ms ago`);
    return null;
  }
  await updateSolbtcParticipationState({ lock_owner: INSTANCE_ID, lock_heartbeat: new Date().toISOString() });
  console.log(`Lock acquired as ${INSTANCE_ID}`);
  return state;
}

async function heartbeat() {
  const fresh = await getSolbtcParticipationState();
  if (fresh.lock_owner !== INSTANCE_ID) {
    console.error(`Lost lock to ${fresh.lock_owner} — another instance took over. Exiting.`);
    process.exit(1);
  }
  await updateSolbtcParticipationState({ lock_heartbeat: new Date().toISOString() });
}

async function releaseLock() {
  try {
    const fresh = await getSolbtcParticipationState();
    if (fresh.lock_owner === INSTANCE_ID) {
      await updateSolbtcParticipationState({ lock_owner: null, lock_heartbeat: null });
      console.log("Lock released cleanly.");
    }
  } catch (err) { console.error("releaseLock failed:", err); }
}

async function processCandle(row: SolbtcParticipationState, candle: Candle): Promise<SolbtcParticipationState> {
  const engineState = stateFromRow(row);
  const { state: next, actualFill } = stepMinute(engineState, candle);

  const patch: Record<string, unknown> = { ...rowFromState(next), last_candle_ts: candle.openTimeMs };

  let btcBalance = row.btc_balance;
  let solQty = row.sol_qty;

  if (actualFill) {
    const fillPrice = actualFill.fillPrice;
    if (actualFill.side === "SOL") {
      // BTC -> SOL: SOL = BTC*(1-cost)/price
      const newSolQty = btcBalance * (1 - COST) / fillPrice;
      entryBtc = btcBalance;
      const btcBefore = btcBalance, solBefore = solQty;
      btcBalance = 0; solQty = newSolQty;
      patch.btc_balance = btcBalance; patch.sol_qty = solQty;
      await recordSolbtcParticipationTrade({
        side_after: "SOL", fill_price: fillPrice, btc_before: btcBefore, sol_before: solBefore,
        btc_after: btcBalance, sol_after: solQty, pnl_btc: null,
      });
      console.log(`FILL -> SOL  price=${fillPrice.toFixed(8)}  qty=${newSolQty.toFixed(6)}`);
    } else {
      // SOL -> BTC: BTC = SOL*price*(1-cost)
      const btcOut = solQty * fillPrice * (1 - COST);
      const pnl = entryBtc !== null ? btcOut - entryBtc : null;
      const btcBefore = btcBalance, solBefore = solQty;
      btcBalance = btcOut; solQty = 0;
      patch.btc_balance = btcBalance; patch.sol_qty = solQty;
      await recordSolbtcParticipationTrade({
        side_after: "BTC", fill_price: fillPrice, btc_before: btcBefore, sol_before: solBefore,
        btc_after: btcBalance, sol_after: solQty, pnl_btc: pnl,
      });
      console.log(`FILL -> BTC  price=${fillPrice.toFixed(8)}  btcOut=${btcOut.toFixed(8)}  pnl=${pnl?.toFixed(8)}`);
      entryBtc = null;
    }
  }

  await updateSolbtcParticipationState(patch);
  return { ...row, ...patch, btc_balance: btcBalance, sol_qty: solQty } as SolbtcParticipationState;
}

async function checkOnce() {
  let row: SolbtcParticipationState;
  try {
    row = await getSolbtcParticipationState();
  } catch (err) {
    await logSolbtcParticipationRun({ actions: [{ action: "ERROR", stage: "state", error: String(err) }] }).catch(() => {});
    return;
  }
  if (!row.enabled) return;

  try {
    // Bitfinex's candle history is SPARSE -- it only returns a row for a minute where a real
    // trade happened (confirmed: SOLBTC regularly goes 5-14+ minutes between trades). The
    // verified formula requires stepping through EVERY clock minute, forward-filling the last
    // known close through quiet gaps (same "filled one-minute grid" methodology the reference
    // engine's spec requires -- flat minutes still decay the CUSUM volatility/score EWMAs and
    // still land on hourly/15-min review boundaries). Fetching sparse candles and only
    // processing the ones that exist would silently skip those boundaries and diverge from the
    // verified backtest. So: build the full continuous grid here, synthesizing flat/zero-volume
    // candles for any minute Bitfinex didn't report a trade for.
    const currentMinuteFloor = Math.floor(Date.now() / 60_000) * 60_000;
    const raw = await getBitfinexCandlesOHLCV(SYMBOL, "1m", CANDLE_LIMIT);
    const closedReal = raw.filter((c) => c.time < currentMinuteFloor); // definitely-closed real trades
    const byMinute = new Map(closedReal.map((c) => [c.time, c]));

    if (row.last_candle_ts === null && closedReal.length > 0) {
      // very first boot: seed lastLogPrice/fastEwma/slowEwma from the first available close,
      // matching initialState(), then process everything AFTER that seed candle.
      const seed = closedReal[0];
      await updateSolbtcParticipationState({
        ...rowFromState(initialState(seed.close)), last_candle_ts: seed.time,
      });
      row = await getSolbtcParticipationState();
    }

    let current = row;
    let lastKnownClose = current.last_log_price !== null ? Math.exp(current.last_log_price) : closedReal[0]?.close;
    if (lastKnownClose !== undefined && current.last_candle_ts !== null) {
      for (let t = current.last_candle_ts + 60_000; t < currentMinuteFloor; t += 60_000) {
        const real = byMinute.get(t);
        const candle: Candle = real
          ? { openTimeMs: t, open: real.open, close: real.close, volume: real.volume }
          : { openTimeMs: t, open: lastKnownClose, close: lastKnownClose, volume: 0 };
        current = await processCandle(current, candle);
        lastKnownClose = candle.close;
      }
    }

    if (Date.now() - lastRunLog > RUN_LOG_INTERVAL_MS) {
      const latest = closedReal[closedReal.length - 1];
      console.log(`STATUS side=${current.side} base=${current.base} orient=${current.orientation} fastMode=${current.fast_mode} trend=${current.trend} price=${latest?.close}`);
      await logSolbtcParticipationRun({
        actions: [{ action: "STATUS", side: current.side, base: current.base, orientation: current.orientation,
          fastMode: current.fast_mode, trend: current.trend, priceOk: current.price_ok,
          btcBalance: current.btc_balance, solQty: current.sol_qty, price: latest?.close }],
      });
      lastRunLog = Date.now();
    }
  } catch (err) {
    console.error("checkOnce error:", err);
    await logSolbtcParticipationRun({ actions: [{ action: "ERROR", stage: "check", error: String(err) }] }).catch(() => {});
  }
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

  console.log(`Starting SOL/BTC Participation PAPER worker (${INSTANCE_ID}), enabled=${got.enabled}.`);
  console.log(`PAPER ONLY — fast CUSUM + slow trend + price-confirmation controller, cost=${(COST*100).toFixed(3)}%/side, polling Bitfinex every 20s.`);
  checkOnce().catch((err) => console.error(err));
  setInterval(() => { checkOnce().catch((err) => console.error(err)); }, POLL_INTERVAL_MS);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
