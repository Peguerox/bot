// Paper bot — SOL/FDUSD trailing-stop-only. Same strategy and entry cadence as
// live-bot-sol-trail.ts (every 1-min bar, no TP, 0.1% trailing stop, $100 seed, compounds) —
// the only difference is how the in-position trail is monitored: instead of a single price
// check per minute, this opens a short (~50s) WebSocket burst each minute to catch the true
// peak and exit near-instantly instead of once a minute. Paper only: no real orders, no API
// key needed (public stream), tracks hypothetical balance.
//
// WORST-CASE SPREAD MODEL (2026-09-02): entry and every peak/stop check use the real measured
// Binance SOLFDUSD half-spread (~0.0051%, i.e. ask on entry, bid throughout the hold) instead of
// the raw trade-tick price — otherwise this simulates a frictionless best-case fill that a real
// taker execution could never actually get. Entry price is bumped up (ask-adjusted); peak
// tracking and the stop trigger use the tick price bumped down (bid-adjusted), continuously,
// not just at the final exit — same fix applied to the Bitfinex backtests this session.
//
// ARCHITECTURE NOTE: an earlier version of this idea used long-lived (~23min) WebSocket
// sessions on a 25-min cron, reconnecting between sessions. That caused two real, repeated
// bugs — see BOT_BUGS_CHECKLIST.md — a tick-race producing duplicate trades, and (worse)
// multiple overlapping sessions from redeploys never actually dying, both racing on the same
// DB row. This version avoids that whole class of bug by design: every run is short (~50s,
// well under the 55s budget every other bot already uses) and fully self-contained within one
// 1-min cron tick, exactly like every other bot in this codebase. No cross-invocation session
// state, no lock needed — there's nothing that can leak between runs to race against.
import { schedules } from "@trigger.dev/sdk/v3";
import WebSocket from "ws";
import { getKlinesGlobal, getPriceGlobal } from "../lib/binance";
import {
  getSolTrailChaseState, updateSolTrailChaseState, recordSolTrailChaseTrade, logSolTrailChaseRun,
  type SolTrailChaseState,
} from "../lib/sol-trail-chase-db";

const SYMBOL      = "SOLFDUSD";
const SL_PCT      = 0.1;
const SEED_USD    = 100;   // starting size — compounds from here, not a ceiling
const CHASE_MS    = 50 * 1000; // stay comfortably under the 55s run budget
const HALF_SPREAD_PCT = 0.0051; // real measured Binance SOLFDUSD half-spread

type Candle = { time: number; close: number };

function entryFill(price: number): number { return price * (1 + HALF_SPREAD_PCT / 100); } // ask-adjusted
function exitFill(price: number): number { return price * (1 - HALF_SPREAD_PCT / 100); }  // bid-adjusted

// Opens a short WebSocket burst, tracks the trailing stop tick-by-tick, exits immediately on
// breach. Ticks are processed through a serial queue — one at a time — so a burst of messages
// can't race each other the way the old design's concurrent handlers did.
async function chase(startState: SolTrailChaseState, log: object[]): Promise<SolTrailChaseState> {
  let state = startState;
  let ticks = 0;
  let queue: Promise<void> = Promise.resolve();

  log.push({ action: "CHASE_START", peak: state.peak_price, stop: state.stop_price });

  await new Promise<void>((resolve) => {
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${SYMBOL.toLowerCase()}@trade`);
    const endTimer = setTimeout(() => { try { ws.close(); } catch { /* already closed */ } }, CHASE_MS);

    ws.on("message", (raw: Buffer) => {
      ticks++;
      let price: number;
      try {
        const msg = JSON.parse(raw.toString());
        price = parseFloat(msg.p);
        if (!price || isNaN(price)) return;
      } catch { return; }

      queue = queue.then(async () => {
        if (state.mode !== "SOL") return; // already exited earlier this burst

        const effSell = exitFill(price); // worst-case sell price at this tick — used for both peak-tracking and the stop check
        const peak = state.peak_price ?? state.entry_price!;
        const stop = state.stop_price ?? peak * (1 - SL_PCT / 100);

        if (effSell <= stop) {
          const exitPrice = stop; // already bid-consistent, no further adjustment
          const usdOut = state.sol_quantity! * exitPrice;
          const usdIn  = state.entry_price! * state.sol_quantity!;
          const pnlUsd = usdOut - usdIn;
          const pnlPct = (pnlUsd / usdIn) * 100;

          await updateSolTrailChaseState({
            mode: "USD", sol_quantity: null, entry_price: null, entry_time: null,
            usd_balance: usdOut, peak_price: null, stop_price: null,
          });
          await recordSolTrailChaseTrade({
            entry_price: state.entry_price!, exit_price: exitPrice, sol_quantity: state.sol_quantity!,
            usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct, entry_time: state.entry_time!,
          });
          log.push({ action: "STOP_FILLED", price: exitPrice, pnlUsd: pnlUsd.toFixed(4), pnlPct: pnlPct.toFixed(4) });
          state = await getSolTrailChaseState();
          try { ws.close(); } catch { /* already closed */ }

        } else if (effSell > peak) {
          const newStop = effSell * (1 - SL_PCT / 100);
          log.push({ action: "TRAIL_UP", from: stop, to: newStop, peak: effSell });
          state = { ...state, peak_price: effSell, stop_price: newStop };
        }
      }).catch((err) => log.push({ action: "ERROR", stage: "chase", error: String(err) }));
    });

    ws.on("error", (err) => log.push({ action: "ERROR", stage: "ws", error: String(err) }));
    ws.on("close", () => {
      clearTimeout(endTimer);
      queue.finally(resolve);
    });
  });

  // Persist the final peak/stop once at the end of the burst if still holding — matches every
  // other bot's once-a-minute persistence cadence, not a new, more fragile pattern.
  if (state.mode === "SOL") {
    await updateSolTrailChaseState({ peak_price: state.peak_price, stop_price: state.stop_price });
  }
  log.push({ action: "CHASE_END", ticks, peak: state.peak_price, stop: state.stop_price });
  return state;
}

export const paperBotSolTrailChase = schedules.task({
  id:          "paper-bot-sol-trail-chase-1m",
  cron:        "*/1 * * * *",
  maxDuration: 55,

  run: async () => {
    const log: object[] = [];

    let state = await getSolTrailChaseState();
    if (!state.enabled) return { ok: false, reason: "disabled" };

    try {
      const [raw1, livePrice] = await Promise.all([
        getKlinesGlobal(SYMBOL, "1m", 5),
        getPriceGlobal(SYMBOL),
      ]);
      const c1: Candle[] = raw1.slice(0, -1).map((c) => ({ time: c.time, close: c.close }));
      const lastCandleTs = c1[c1.length - 1].time;
      const isNewCandle = lastCandleTs > (state.last_candle_ts ?? 0);

      log.push({ action: "CHECK", mode: state.mode, price: livePrice });

      // ── Entry: flat, new 1-min candle → buy at live price (paper, unconditional) ──
      if (isNewCandle) {
        await updateSolTrailChaseState({ last_candle_ts: lastCandleTs });

        if (state.mode === "USD") {
          const targetPool = SEED_USD + (state.realized_pnl_usd ?? 0);
          const entryPrice = entryFill(livePrice); // ask-adjusted — worse than the raw tick, on purpose
          const solQty = targetPool / entryPrice;
          const initialPeak = exitFill(livePrice); // best sell price achievable right after entry
          await updateSolTrailChaseState({
            mode: "SOL", sol_quantity: solQty, entry_price: entryPrice,
            entry_time: new Date().toISOString(), usd_balance: 0,
            peak_price: initialPeak, stop_price: initialPeak * (1 - SL_PCT / 100),
          });
          log.push({ action: "BUY", price: entryPrice, qty: solQty });
          state = await getSolTrailChaseState();
        }
      }

      // ── Chase: holding → short WebSocket burst instead of a single price check ──
      if (state.mode === "SOL") {
        state = await chase(state, log);
      }

    } catch (err) {
      log.push({ action: "ERROR", stage: "trading", error: String(err) });
    }

    await logSolTrailChaseRun({ actions: log });
    return { ok: true };
  },
});
