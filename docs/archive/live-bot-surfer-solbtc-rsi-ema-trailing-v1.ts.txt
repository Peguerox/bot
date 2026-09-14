// The Surfer — SOL/BTC rotation on Binance.US
// Signal : RSI(14) on 15m SOLBTC
//   cross UP through 30  → arm buy  SOL (BTC → SOL)
//   cross DOWN through 70 → arm sell SOL (SOL → BTC)
// Filter : 12h EMA(7/25) in live-mode (forming candle adjusted with current price)
//   EMA7 > EMA25 = bullish  → confirm buy  when armed (also requires EMA7 sloping up — Filter #3)
//   EMA7 < EMA25 = bearish  → confirm sell when armed
// Exit   : trailing stop — once peak gain >= 6%, sell if price falls back 7.5pp from the
//          peak — fires ahead of the RSI/EMA trend-reversal exit on winning trades.
//          Backtested +666.7% vs +495.5% (slope filter alone) over ~5yr.
// Execution: limit orders with price chasing every minute (maker, 0% fee)
// Capital  : all free BTC in account; hold indefinitely between signals

import { schedules } from "@trigger.dev/sdk/v3";
import {
  getKlines, getPrice, getFreeBalance, getOrder, cancelOrder,
  placeLimitBuySol, placeLimitSellSol,
} from "../lib/binance";
import {
  getSurferState, updateSurferState, recordSurferTrade, logSurferRun,
} from "../lib/surfer-db";

const SYMBOL         = "SOLBTC";
const RSI_LOW        = 30;
const RSI_HIGH       = 70;
const MA_FAST        = 7;
const MA_SLOW        = 25;
const TREND_INTERVAL = "12h";
const C15_LIMIT      = 110;   // fetch 110 15m candles; last one forming, use 109 closed
const C12H_LIMIT     = 100;   // fetch 100 12h candles; EMA(25) needs warmup (74 extra periods → seed weight ~0.2%)
const MIN_NOTIONAL   = 0.0001; // SOLBTC min notional in BTC

const TRAIL_ARM_PCT  = 6;      // trailing stop only active once peak gain reaches this
const TRAIL_PP        = 7.5;   // trail distance (percentage points from peak)

type Candle = { time: number; close: number };

function roundSolPrice(p: number): number {
  return Math.round(p * 1e7) / 1e7;
}

function floorSolQty(q: number): number {
  return Math.floor(q * 100) / 100;
}

// Matches backtest's calcSMA — seeded SMA then EMA decay (k = 2/(period+1))
function calcEMA(candles: Candle[], period: number): number[] {
  const k   = 2 / (period + 1);
  const out: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period) return out;
  out[period - 1] = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  for (let i = period; i < candles.length; i++) {
    out[i] = candles[i].close * k + out[i - 1] * (1 - k);
  }
  return out;
}

// Matches backtest's calcRSI — Wilder smoothed RSI(14)
function calcRSI(candles: Candle[], period = 14): number[] {
  const rsi: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d > 0) avgGain += d; else avgLoss += -d;
  }
  avgGain /= period;
  avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    rsi[i]  = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

export const surferSolBtcBot = schedules.task({
  id:          "live-bot-surfer-solbtc-1m",
  cron:        "*/5 * * * *",
  maxDuration: 55,

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
      // ── Fetch market data in parallel ──────────────────────────────────────
      const [raw15, raw12h, livePrice] = await Promise.all([
        getKlines(SYMBOL, "15m",         C15_LIMIT),
        getKlines(SYMBOL, TREND_INTERVAL, C12H_LIMIT),
        getPrice(SYMBOL),
      ]);

      // Exclude the forming (last) candle — use only fully closed candles
      const c15:  Candle[] = raw15.slice(0, -1).map((c: any) => ({ time: c.time, close: c.close }));
      const c12h: Candle[] = raw12h.slice(0, -1).map((c: any) => ({ time: c.time, close: c.close }));

      // ── 15m RSI ────────────────────────────────────────────────────────────
      const rsiArr    = calcRSI(c15);
      const curRSI    = rsiArr[rsiArr.length - 1];
      const prevRSI   = rsiArr[rsiArr.length - 2];
      const lastCandleTs = c15[c15.length - 1].time;

      // ── 12h EMA — liveMode: adjust forming candle with current 15m price ──
      // Matches backtest: liveEMA = closedEMA + (livePrice - lastClose12h) / period
      const ema7Arr     = calcEMA(c12h, MA_FAST);
      const ema25Arr    = calcEMA(c12h, MA_SLOW);
      const lastEma7    = ema7Arr[ema7Arr.length - 1];
      const prevEma7    = ema7Arr[ema7Arr.length - 2];
      const lastEma25   = ema25Arr[ema25Arr.length - 1];
      const lastClose12h = c12h[c12h.length - 1].close;
      const delta        = livePrice - lastClose12h;
      const liveEma7     = lastEma7  + delta / MA_FAST;
      const liveEma25    = lastEma25 + delta / MA_SLOW;
      const emaBullish   = !isNaN(liveEma7) && !isNaN(liveEma25) && liveEma7 > liveEma25;
      const emaSloping   = !isNaN(prevEma7)  && liveEma7 > prevEma7;  // Filter #3 — matches SOLUSDT bot; backtested +523% vs +381% over 5yr

      // ── Track peak unrealized gain since entry (for the trailing stop) ────
      let bestPct = state.best_pct ?? 0;
      let curPct = 0;
      let trailHit = false;
      if (state.mode === "SOL" && state.entry_price) {
        curPct = (livePrice - state.entry_price) / state.entry_price * 100;
        if (curPct > bestPct) {
          bestPct = curPct;
          await updateSurferState({ best_pct: bestPct });
        }
        if (bestPct >= TRAIL_ARM_PCT && bestPct - curPct >= TRAIL_PP) trailHit = true;
      }

      log.push({
        action: "CHECK",
        mode: state.mode, status: state.status,
        rsi: curRSI?.toFixed(2), emaBullish, emaSloping, price: livePrice,
        armed_sol: state.armed_for_sol, armed_btc: state.armed_for_btc,
        curPct: curPct.toFixed(2), bestPct: bestPct.toFixed(2), trailHit,
      });

      // ── Local arm state — may be updated inline this run ──────────────────
      let armedForSol = state.armed_for_sol;
      let armedForBtc = state.armed_for_btc;

      // ── New 15m candle: check for RSI cross and update arm ────────────────
      const isNewCandle = lastCandleTs > (state.last_candle_ts ?? 0);
      if (isNewCandle && !isNaN(curRSI) && !isNaN(prevRSI)) {
        const candleUpdates: Record<string, unknown> = { last_candle_ts: lastCandleTs };

        if (state.status === "idle" && state.mode === "BTC"
            && prevRSI < RSI_LOW && curRSI >= RSI_LOW && !armedForSol) {
          armedForSol = true;
          candleUpdates.armed_for_sol = true;
          log.push({ action: "ARM_BUY", prevRSI: prevRSI.toFixed(2), curRSI: curRSI.toFixed(2) });
        }

        if (state.status === "idle" && state.mode === "SOL"
            && prevRSI > RSI_HIGH && curRSI <= RSI_HIGH && !armedForBtc) {
          armedForBtc = true;
          candleUpdates.armed_for_btc = true;
          log.push({ action: "ARM_SELL", prevRSI: prevRSI.toFixed(2), curRSI: curRSI.toFixed(2) });
        }

        await updateSurferState(candleUpdates);
      }

      // ── Signal fire: arm + trend confirmed → start limit chase ────────────

      if (state.status === "idle" && state.mode === "BTC" && armedForSol && emaBullish && emaSloping) {
        const btcFree = await getFreeBalance("BTC");
        const solQty  = floorSolQty(btcFree / livePrice);
        if (solQty >= 0.01 && solQty * livePrice >= MIN_NOTIONAL) {
          const order = await placeLimitBuySol(SYMBOL, solQty, livePrice);
          await updateSurferState({
            status:        "chasing_buy",
            armed_for_sol: false,
            chase_order_id: order.orderId,
            chase_price:   roundSolPrice(livePrice),
            entry_btc:     btcFree,
            entry_time:    new Date().toISOString(),
          });
          log.push({ action: "START_BUY", price: livePrice, qty: solQty, btcFree });
          armedForSol = false;
        } else {
          log.push({ action: "SKIP_BUY", reason: "below_min", btcFree, solQty });
        }
      }

      const trendSellOk = armedForBtc && !emaBullish;
      if (state.status === "idle" && state.mode === "SOL" && (trailHit || trendSellOk)) {
        const solQty = floorSolQty(state.sol_quantity ?? 0);
        if (solQty >= 0.01) {
          const order = await placeLimitSellSol(SYMBOL, solQty, livePrice);
          log.push({ action: "SELL_TRIGGER", reason: trailHit ? "trail" : "trend" });
          await updateSurferState({
            status:        "chasing_sell",
            armed_for_btc: false,
            chase_order_id: order.orderId,
            chase_price:   roundSolPrice(livePrice),
          });
          log.push({ action: "START_SELL", price: livePrice, qty: solQty });
          armedForBtc = false;
        } else {
          log.push({ action: "SKIP_SELL", reason: "no_sol", solQty });
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
            status:        "idle",
            mode:          "SOL",
            sol_quantity:  solFilled,
            entry_price:   fillPrice,
            entry_btc:     btcSpent,
            chase_order_id: null,
            chase_price:   null,
            best_pct:      0,
          });
          log.push({ action: "BUY_FILLED", price: fillPrice, qty: solFilled, btcSpent });

        } else if (order.status === "CANCELED" || order.status === "EXPIRED") {
          // Return to idle; arm stays set so it fires again next candle if trend still agrees
          await updateSurferState({ status: "idle", chase_order_id: null, chase_price: null });
          log.push({ action: "BUY_CANCELED" });

        } else {
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
                  status: "idle", mode: "SOL",
                  sol_quantity: solFilled, entry_price: fillPrice, entry_btc: btcSpent,
                  chase_order_id: null, chase_price: null, best_pct: 0,
                });
                log.push({ action: "BUY_FILLED_ON_CANCEL", price: fillPrice, qty: solFilled });
                cancelOk = false;
              }
            }
            if (cancelOk) {
              const btcFree = await getFreeBalance("BTC");
              const solQty  = floorSolQty(btcFree / newPrice);
              const newOrder = await placeLimitBuySol(SYMBOL, solQty, newPrice);
              await updateSurferState({ chase_order_id: newOrder.orderId, chase_price: newPrice });
              log.push({ action: "BUY_REPRICE", from: state.chase_price, to: newPrice });
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
            status:        "idle",
            mode:          "BTC",
            sol_quantity:  null,
            entry_price:   null,
            entry_btc:     null,
            entry_time:    null,
            chase_order_id: null,
            chase_price:   null,
            armed_for_btc: false,
          });
          await recordSurferTrade({
            buy_price:    state.entry_price!,
            sell_price:   exitPrice,
            sol_quantity: state.sol_quantity!,
            btc_in:       state.entry_btc!,
            btc_out:      btcOut,
            pnl_btc:      pnlBtc,
            pnl_pct:      pnlPct,
            entry_time:   state.entry_time!,
            result:       "SELL",
          });
          log.push({ action: "SELL_FILLED", price: exitPrice, btcOut, pnlBtc, pnlPct });

        } else if (order.status === "CANCELED" || order.status === "EXPIRED") {
          await updateSurferState({ status: "idle", chase_order_id: null, chase_price: null });
          log.push({ action: "SELL_CANCELED" });

        } else {
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
                  status: "idle", mode: "BTC", sol_quantity: null,
                  entry_price: null, entry_btc: null, entry_time: null,
                  chase_order_id: null, chase_price: null, armed_for_btc: false,
                });
                await recordSurferTrade({
                  buy_price: state.entry_price!, sell_price: exitPrice,
                  sol_quantity: state.sol_quantity!, btc_in: state.entry_btc!,
                  btc_out: btcOut, pnl_btc: pnlBtc, pnl_pct: pnlPct,
                  entry_time: state.entry_time!, result: "SELL",
                });
                log.push({ action: "SELL_FILLED_ON_CANCEL", price: exitPrice, pnlBtc });
                cancelOk = false;
              }
            }
            if (cancelOk) {
              const newOrder = await placeLimitSellSol(SYMBOL, state.sol_quantity!, newPrice);
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
