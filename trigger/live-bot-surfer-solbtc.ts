// The Surfer — SOL/BTC buffered rotation (v2), replacing the old RSI+EMA+trailing-stop strategy
// on 2026-09-14. Old strategy archived verbatim at
// docs/archive/live-bot-surfer-solbtc-rsi-ema-trailing-v1.ts.txt -- revert by copying it back
// over this file (same task id, same cron, same DB tables) if this one needs to be rolled back.
//
// Full research + independent verification: docs/solbtc_buffered_rotation.md. Backtested on real
// Bitfinex SOL/BTC 1-min data: ~5.5x BTC over 4.94yr (source report claims 6.5x -- reproduced
// trade count/win-rate/best-worst-trip almost exactly, final compounding a bit lower, likely a
// same-bar-close vs next-bar-open execution timing difference), 1.74x BTC over the most recent 2
// years -- which becomes +121.6% in USD terms once BTC's own price move is folded in, versus the
// old strategy's real 2yr backtest of only 1.08x BTC (+45.5% USD, almost entirely just BTC's own
// price rising, not real coin-count skill: 43 trades, 30.2% win rate).
//
// You hold either BTC or SOL, never dollars. The goal is ending with more coins (BTC-equivalent),
// not dollars -- the USD outcome is this multiplied by whatever BTC does in the meantime.
//
// Signal: R_t = SOLBTC close (how many BTC one SOL costs).
//   H_t = highest PRIOR close in 6190 min (~4.3 days)   -- excludes the current candle
//   L_t = lowest  PRIOR close in 2200 min (~36.7 hours) -- excludes the current candle
//   C_t = last observed close at/before t-747min (~12h27m)
// ENTRY (BTC -> SOL): R_t > 1.0025*H_t (break the 4.3-day high by a buffer) AND R_t > C_t.
// WHILE IN SOL: track anchor A (R at entry fill) and peak P = max(P, R_t); g = P/A - 1.
// EXIT (SOL -> BTC), requires R_t < C_t AND any of:
//   R_t/A < 0.91                     failed campaign, always available
//   g < 18%:  R_t < 0.998*L_t         buffered fast stop
//   g >= 18%: R_t <= A*(1+0.85*g)     give back 15% of peak gain
// Execution: full conversion (all BTC or all SOL), maker limit-order chase (0% fee), same pattern
// as the prior strategy. One decision per NEW closed 1-min candle, not every cron tick.
import { schedules } from "@trigger.dev/sdk/v3";
import {
  getKlinesRange, getPrice, getFreeBalance, getOrder, cancelOrder,
  placeLimitBuySol, placeLimitSellSol,
} from "../lib/binance";
import {
  getSurferState, updateSurferState, recordSurferTrade, logSurferRun,
} from "../lib/surfer-db";

const SYMBOL = "SOLBTC";
const BUF_UP = 0.0025, BUF_DN = 0.0020;
const ARM = 0.18, GIVEBACK = 0.15, FAIL = 0.09;
const H_WINDOW_MIN = 6190;
const L_WINDOW_MIN = 2200;
const C_LAG_MIN = 747;
const FETCH_PAD_MIN = 30; // small safety margin beyond the largest window

// This account holds real BTC/SOL for purposes entirely unrelated to Surfer (a large separate
// holding, confirmed 2026-09-14). Surfer's own capital is this seed plus its own compounding
// realized P&L -- NEVER "whatever free balance happens to be sitting in the account." Real free
// balance is only ever used as a safety ceiling (min(tradingCapital, free)), never as the primary
// size. A near-miss on 2026-09-14 (a one-off manual script, not this file) sold 123 SOL instead of
// an intended 0.8 SOL by using raw free balance directly -- this constant and the cap below exist
// specifically so that class of bug can't happen here.
const SEED_BTC = 0.00075241; // matches every other paper-turned-live bot's $50-equivalent seed

function tradingCapitalBtc(state: { realized_pnl_btc?: number | null }): number {
  return SEED_BTC + (state.realized_pnl_btc ?? 0);
}

function roundSolPrice(p: number): number {
  return Math.round(p * 1e7) / 1e7;
}
function floorSolQty(q: number): number {
  return Math.floor(q * 100) / 100;
}

type Candle = { time: number; close: number };

function computeHLC(closed: Candle[]) {
  const lastTs = closed[closed.length - 1].time;
  const prior = closed.slice(0, -1); // strictly before the latest closed candle, matches the reference impl's [t-window, t) exclusivity
  const cutoffH = lastTs - H_WINDOW_MIN * 60_000;
  const cutoffL = lastTs - L_WINDOW_MIN * 60_000;
  const cutoffC = lastTs - C_LAG_MIN * 60_000;

  const forH = prior.filter((c) => c.time >= cutoffH);
  const forL = prior.filter((c) => c.time >= cutoffL);
  const H = forH.length ? Math.max(...forH.map((c) => c.close)) : NaN;
  const L = forL.length ? Math.min(...forL.map((c) => c.close)) : NaN;

  let C = NaN;
  for (let i = prior.length - 1; i >= 0; i--) {
    if (prior[i].time <= cutoffC) { C = prior[i].close; break; }
  }
  return { H, L, C, R: closed[closed.length - 1].close, lastTs };
}

export const surferSolBtcBot = schedules.task({
  id:          "live-bot-surfer-solbtc-1m",
  cron:        "*/5 * * * *",
  maxDuration: 120,

  run: async () => {
    const log: object[] = [];

    let state;
    try {
      state = await getSurferState();
    } catch (err) {
      await logSurferRun({ actions: [{ action: "ERROR", stage: "state", error: String(err) }] });
      return { ok: false };
    }
    if (!state.enabled) return { ok: false, reason: "disabled" };

    try {
      const nowMs = Date.now();
      const startMs = nowMs - (H_WINDOW_MIN + FETCH_PAD_MIN) * 60_000;
      const candles = await getKlinesRange(SYMBOL, "1m", startMs, nowMs);
      const closed = candles.slice(0, -1); // drop the still-forming candle

      if (closed.length < H_WINDOW_MIN) {
        log.push({ action: "WAIT_HISTORY", have: closed.length, need: H_WINDOW_MIN });
        await logSurferRun({ actions: log });
        return { ok: true, reason: "insufficient history" };
      }

      const { H, L, C, R, lastTs } = computeHLC(closed);
      const isNewCandle = lastTs > (state.last_candle_ts ?? 0);

      let anchor = state.anchor ?? null;
      let peak = state.peak ?? null;
      const g = state.mode === "SOL" && anchor ? (peak ?? anchor) / anchor - 1 : null;

      log.push({
        action: "CHECK", mode: state.mode, status: state.status,
        R, H, L, C, anchor, peak, g: g?.toFixed(4), isNewCandle,
      });

      if (isNewCandle) {
        const updates: Record<string, unknown> = { last_candle_ts: lastTs };

        if (state.mode === "SOL" && anchor !== null) {
          const newPeak = Math.max(peak ?? anchor, R);
          if (newPeak !== peak) { peak = newPeak; updates.peak = newPeak; }
        }

        await updateSurferState(updates);

        // ── Entry: BTC -> SOL ──────────────────────────────────────────────
        if (state.status === "idle" && state.mode === "BTC") {
          const breakout = R > H * (1 + BUF_UP);
          const confirmed = breakout && R > C;
          if (confirmed) {
            const btcFree = await getFreeBalance("BTC");
            const btcToSpend = Math.min(tradingCapitalBtc(state), btcFree);
            const solQty = floorSolQty(btcToSpend / R);
            if (solQty >= 0.01 && solQty * R >= 0.0001) {
              const order = await placeLimitBuySol(SYMBOL, solQty, R);
              await updateSurferState({
                status: "chasing_buy", chase_order_id: order.orderId, chase_price: roundSolPrice(R),
                entry_btc: btcToSpend, entry_time: new Date().toISOString(),
              });
              log.push({ action: "START_BUY", price: R, qty: solQty, btcToSpend, btcFree, H, C });
            } else {
              log.push({ action: "SKIP_BUY", reason: "below_min", btcToSpend, btcFree, solQty });
            }
          }
        }

        // ── Exit: SOL -> BTC ───────────────────────────────────────────────
        if (state.status === "idle" && state.mode === "SOL" && anchor !== null) {
          const M = R / anchor;
          const gg = (peak ?? anchor) / anchor - 1;
          let triggered = false;
          let reason = "";
          if (M < 1 - FAIL) { triggered = true; reason = "failed_campaign"; }
          else if (gg >= ARM) { if (M <= 1 + (1 - GIVEBACK) * gg) { triggered = true; reason = "giveback"; } }
          else if (R < L * (1 - BUF_DN)) { triggered = true; reason = "buffered_stop"; }

          if (triggered && R < C) {
            const solFree = await getFreeBalance("SOL");
            const trackedQty = state.sol_quantity ?? 0;
            const solQty = floorSolQty(Math.min(trackedQty, solFree));
            if (solQty >= 0.01) {
              const order = await placeLimitSellSol(SYMBOL, solQty, R);
              log.push({ action: "SELL_TRIGGER", reason, M: M.toFixed(4), g: gg.toFixed(4) });
              await updateSurferState({
                status: "chasing_sell", chase_order_id: order.orderId, chase_price: roundSolPrice(R),
              });
            } else {
              log.push({ action: "SKIP_SELL", reason: "no_sol", trackedQty, solFree });
            }
          }
        }
      }

      // ── Chase: manage open BUY limit order ────────────────────────────────
      if (state.status === "chasing_buy") {
        const order = await getOrder(SYMBOL, state.chase_order_id!);

        if (order.status === "FILLED") {
          const fillPrice = parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty);
          const solFilled = floorSolQty(parseFloat(order.executedQty));
          const btcSpent  = parseFloat(order.cummulativeQuoteQty);
          await updateSurferState({
            status: "idle", mode: "SOL", sol_quantity: solFilled, entry_price: fillPrice,
            entry_btc: btcSpent, chase_order_id: null, chase_price: null,
            anchor: fillPrice, peak: fillPrice,
          });
          log.push({ action: "BUY_FILLED", price: fillPrice, qty: solFilled, btcSpent });

        } else if (order.status === "CANCELED" || order.status === "EXPIRED") {
          await updateSurferState({ status: "idle", chase_order_id: null, chase_price: null });
          log.push({ action: "BUY_CANCELED" });

        } else {
          const livePrice = await getPrice(SYMBOL);
          const newPrice = roundSolPrice(livePrice);
          if (newPrice !== state.chase_price) {
            let cancelOk = true;
            try {
              await cancelOrder(SYMBOL, state.chase_order_id!);
            } catch {
              const check = await getOrder(SYMBOL, state.chase_order_id!);
              if (check.status === "FILLED") {
                const fillPrice = parseFloat(check.cummulativeQuoteQty) / parseFloat(check.executedQty);
                const solFilled = floorSolQty(parseFloat(check.executedQty));
                const btcSpent  = parseFloat(check.cummulativeQuoteQty);
                await updateSurferState({
                  status: "idle", mode: "SOL", sol_quantity: solFilled, entry_price: fillPrice,
                  entry_btc: btcSpent, chase_order_id: null, chase_price: null,
                  anchor: fillPrice, peak: fillPrice,
                });
                log.push({ action: "BUY_FILLED_ON_CANCEL", price: fillPrice, qty: solFilled });
                cancelOk = false;
              }
            }
            if (cancelOk) {
              const btcFree = await getFreeBalance("BTC");
              const btcToSpend = Math.min(tradingCapitalBtc(state), btcFree);
              const solQty  = floorSolQty(btcToSpend / newPrice);
              const newOrder = await placeLimitBuySol(SYMBOL, solQty, newPrice);
              await updateSurferState({ chase_order_id: newOrder.orderId, chase_price: newPrice, entry_btc: btcToSpend });
              log.push({ action: "BUY_REPRICE", from: state.chase_price, to: newPrice, btcToSpend });
            }
          } else {
            log.push({ action: "BUY_WAIT", price: livePrice });
          }
        }
      }

      // ── Chase: manage open SELL limit order ───────────────────────────────
      if (state.status === "chasing_sell") {
        const order = await getOrder(SYMBOL, state.chase_order_id!);

        if (order.status === "FILLED") {
          const exitPrice = parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty);
          const btcOut    = parseFloat(order.cummulativeQuoteQty);
          const pnlBtc    = btcOut - (state.entry_btc ?? 0);
          const pnlPct    = (state.entry_btc ?? 0) > 0 ? (pnlBtc / state.entry_btc!) * 100 : 0;
          await updateSurferState({
            status: "idle", mode: "BTC", sol_quantity: null, entry_price: null, entry_btc: null,
            entry_time: null, chase_order_id: null, chase_price: null, anchor: null, peak: null,
          });
          await recordSurferTrade({
            buy_price: state.entry_price!, sell_price: exitPrice, sol_quantity: state.sol_quantity!,
            btc_in: state.entry_btc!, btc_out: btcOut, pnl_btc: pnlBtc, pnl_pct: pnlPct,
            entry_time: state.entry_time!, result: "SELL",
          });
          log.push({ action: "SELL_FILLED", price: exitPrice, btcOut, pnlBtc, pnlPct });

        } else if (order.status === "CANCELED" || order.status === "EXPIRED") {
          await updateSurferState({ status: "idle", chase_order_id: null, chase_price: null });
          log.push({ action: "SELL_CANCELED" });

        } else {
          const livePrice = await getPrice(SYMBOL);
          const newPrice = roundSolPrice(livePrice);
          if (newPrice !== state.chase_price) {
            let cancelOk = true;
            try {
              await cancelOrder(SYMBOL, state.chase_order_id!);
            } catch {
              const check = await getOrder(SYMBOL, state.chase_order_id!);
              if (check.status === "FILLED") {
                const exitPrice = parseFloat(check.cummulativeQuoteQty) / parseFloat(check.executedQty);
                const btcOut    = parseFloat(check.cummulativeQuoteQty);
                const pnlBtc    = btcOut - (state.entry_btc ?? 0);
                const pnlPct    = (state.entry_btc ?? 0) > 0 ? (pnlBtc / state.entry_btc!) * 100 : 0;
                await updateSurferState({
                  status: "idle", mode: "BTC", sol_quantity: null, entry_price: null, entry_btc: null,
                  entry_time: null, chase_order_id: null, chase_price: null, anchor: null, peak: null,
                });
                await recordSurferTrade({
                  buy_price: state.entry_price!, sell_price: exitPrice, sol_quantity: state.sol_quantity!,
                  btc_in: state.entry_btc!, btc_out: btcOut, pnl_btc: pnlBtc, pnl_pct: pnlPct,
                  entry_time: state.entry_time!, result: "SELL",
                });
                log.push({ action: "SELL_FILLED_ON_CANCEL", price: exitPrice, pnlBtc });
                cancelOk = false;
              }
            }
            if (cancelOk) {
              const solFree = await getFreeBalance("SOL");
              const trackedQty = state.sol_quantity ?? 0;
              const solQty = floorSolQty(Math.min(trackedQty, solFree));
              const newOrder = await placeLimitSellSol(SYMBOL, solQty, newPrice);
              await updateSurferState({ chase_order_id: newOrder.orderId, chase_price: newPrice });
              log.push({ action: "SELL_REPRICE", from: state.chase_price, to: newPrice });
            }
          } else {
            log.push({ action: "SELL_WAIT", price: livePrice });
          }
        }
      }

    } catch (err) {
      log.push({ action: "ERROR", stage: "trading", error: String(err) });
    }

    await logSurferRun({ actions: log });
    return { ok: true, actions: log };
  },
});
