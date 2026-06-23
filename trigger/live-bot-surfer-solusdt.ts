// Surfer USDT — SOL/USDT rotation on Binance.US
// Entry : RSI(14) on 15m SOLUSDT crosses UP through 30 → arm
//         EMA7 > EMA25 on 12h (liveMode) AND EMA7 sloping up → BUY
// Exit  : EMA7 < EMA25 on 12h (liveMode) AND RSI(14) 15m < 50 → SELL
// Capital: $50 USDT. No TP/SL. Holds indefinitely between signals.

import { schedules } from "@trigger.dev/sdk/v3";
import {
  getKlines, getPrice, getFreeBalance, getOrder, cancelOrder,
  placeLimitBuySolUsdt, placeLimitSellSolUsdt,
} from "../lib/binance";
import {
  getSurferUsdtState, updateSurferUsdtState, recordSurferUsdtTrade, logSurferUsdtRun,
} from "../lib/surfer-usdt-db";

const SYMBOL           = "SOLUSDT";
const RSI_LOW          = 30;
const MA_FAST          = 7;
const MA_SLOW          = 25;
const TREND_INTERVAL   = "12h";
const C15_LIMIT        = 110;
const C12H_LIMIT       = 100;
const MIN_NOTIONAL     = 10;   // SOLUSDT min notional in USD

type Candle = { time: number; close: number };

function roundPrice(p: number): number {
  return Math.round(p * 100) / 100;
}

function floorQty(q: number): number {
  return Math.floor(q * 100) / 100;
}

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

export const surferSolUsdtBot = schedules.task({
  id:          "live-bot-surfer-solusdt-1m",
  cron:        "*/5 * * * *",
  maxDuration: 55,

  run: async () => {
    const log: object[] = [];

    let state;
    try {
      state = await getSurferUsdtState();
    } catch (err) {
      await logSurferUsdtRun({ actions: [{ action: "ERROR", stage: "state", error: String(err) }] });
      return { ok: false };
    }
    if (!state.enabled) return { ok: false, reason: "disabled" };

    try {
      // ── Fetch market data ──────────────────────────────────────────────────
      const [raw15, raw12h, livePrice] = await Promise.all([
        getKlines(SYMBOL, "15m",         C15_LIMIT),
        getKlines(SYMBOL, TREND_INTERVAL, C12H_LIMIT),
        getPrice(SYMBOL),
      ]);

      // Exclude the forming candle — use only fully closed candles
      const c15:  Candle[] = raw15.slice(0, -1).map((c: any) => ({ time: c.time, close: c.close }));
      const c12h: Candle[] = raw12h.slice(0, -1).map((c: any) => ({ time: c.time, close: c.close }));

      // ── 15m RSI ────────────────────────────────────────────────────────────
      const rsiArr       = calcRSI(c15);
      const curRSI       = rsiArr[rsiArr.length - 1];
      const prevRSI      = rsiArr[rsiArr.length - 2];
      const lastCandleTs = c15[c15.length - 1].time;

      // ── 12h EMA — liveMode: adjust forming candle with current price ───────
      // liveEma = closedEma + (livePrice - lastClose12h) / period
      const ema7Arr      = calcEMA(c12h, MA_FAST);
      const ema25Arr     = calcEMA(c12h, MA_SLOW);
      const lastEma7     = ema7Arr[ema7Arr.length - 1];
      const prevEma7     = ema7Arr[ema7Arr.length - 2];
      const lastEma25    = ema25Arr[ema25Arr.length - 1];
      const lastClose12h = c12h[c12h.length - 1].close;
      const delta        = livePrice - lastClose12h;
      const liveEma7     = lastEma7  + delta / MA_FAST;
      const liveEma25    = lastEma25 + delta / MA_SLOW;
      const emaBullish   = !isNaN(liveEma7) && !isNaN(liveEma25) && liveEma7 > liveEma25;
      const emaSloping   = !isNaN(prevEma7)  && liveEma7 > prevEma7;  // Filter #3

      log.push({
        action: "CHECK",
        mode: state.mode, status: state.status,
        rsi: curRSI?.toFixed(2), emaBullish, emaSloping, price: livePrice,
        armed_sol: state.armed_for_sol,
      });

      let armedForSol = state.armed_for_sol;

      // ── New 15m candle: check RSI cross up through 30 → arm buy ───────────
      const isNewCandle = lastCandleTs > (state.last_candle_ts ?? 0);
      if (isNewCandle && !isNaN(curRSI) && !isNaN(prevRSI)) {
        const candleUpdates: Record<string, unknown> = { last_candle_ts: lastCandleTs };

        if (state.status === "idle" && state.mode === "USDT"
            && prevRSI < RSI_LOW && curRSI >= RSI_LOW && !armedForSol) {
          armedForSol = true;
          candleUpdates.armed_for_sol = true;
          log.push({ action: "ARM_BUY", prevRSI: prevRSI.toFixed(2), curRSI: curRSI.toFixed(2) });
        }

        await updateSurferUsdtState(candleUpdates);
      }

      // ── Fire buy: armed + EMA bullish + EMA7 sloping up (Filter #3) ───────
      if (state.status === "idle" && state.mode === "USDT" && armedForSol && emaBullish && emaSloping) {
        const usdtFree  = await getFreeBalance("USDT");
        const usdtToUse = Math.min(usdtFree, state.usdt_balance);  // compound: use bot's own tracked balance
        const solQty    = floorQty(usdtToUse / livePrice);
        if (solQty >= 0.01 && solQty * livePrice >= MIN_NOTIONAL) {
          const order = await placeLimitBuySolUsdt(SYMBOL, solQty, livePrice);
          await updateSurferUsdtState({
            status:         "chasing_buy",
            armed_for_sol:  false,
            chase_order_id: order.orderId,
            chase_price:    roundPrice(livePrice),
            entry_usdt:     usdtToUse,
            entry_time:     new Date().toISOString(),
          });
          log.push({ action: "START_BUY", price: livePrice, qty: solQty, usdtFree: usdtToUse });
          armedForSol = false;
        } else {
          log.push({ action: "SKIP_BUY", reason: "below_min", usdtFree: usdtToUse, solQty });
        }
      }

      // ── Fire sell: EMA bearish + RSI < 50 (no arming needed) ─────────────
      if (state.status === "idle" && state.mode === "SOL" && !emaBullish && curRSI < 50) {
        const solQty = floorQty(state.sol_quantity ?? 0);
        if (solQty >= 0.01) {
          const order = await placeLimitSellSolUsdt(SYMBOL, solQty, livePrice);
          await updateSurferUsdtState({
            status:         "chasing_sell",
            chase_order_id: order.orderId,
            chase_price:    roundPrice(livePrice),
          });
          log.push({ action: "START_SELL", price: livePrice, qty: solQty });
        } else {
          log.push({ action: "SKIP_SELL", reason: "no_sol", solQty });
        }
      }

      // ── Chase: manage open BUY limit order ────────────────────────────────
      if (state.status === "chasing_buy") {
        const order = await getOrder(SYMBOL, state.chase_order_id!);

        if (order.status === "FILLED") {
          const fillPrice = parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty);
          const solFilled = floorQty(parseFloat(order.executedQty));
          const usdtSpent = parseFloat(order.cummulativeQuoteQty);
          await updateSurferUsdtState({
            status:         "idle",
            mode:           "SOL",
            sol_quantity:   solFilled,
            entry_price:    fillPrice,
            entry_usdt:     usdtSpent,
            chase_order_id: null,
            chase_price:    null,
          });
          log.push({ action: "BUY_FILLED", price: fillPrice, qty: solFilled, usdtSpent });

        } else if (order.status === "CANCELED" || order.status === "EXPIRED") {
          await updateSurferUsdtState({ status: "idle", chase_order_id: null, chase_price: null });
          log.push({ action: "BUY_CANCELED" });

        } else {
          const newPrice = roundPrice(livePrice);
          if (newPrice !== state.chase_price) {
            let cancelOk = true;
            try {
              await cancelOrder(SYMBOL, state.chase_order_id!);
            } catch {
              const check = await getOrder(SYMBOL, state.chase_order_id!);
              if (check.status === "FILLED") {
                const fillPrice = parseFloat(check.cummulativeQuoteQty) / parseFloat(check.executedQty);
                const solFilled = floorQty(parseFloat(check.executedQty));
                const usdtSpent = parseFloat(check.cummulativeQuoteQty);
                await updateSurferUsdtState({
                  status: "idle", mode: "SOL",
                  sol_quantity: solFilled, entry_price: fillPrice, entry_usdt: usdtSpent,
                  chase_order_id: null, chase_price: null,
                });
                log.push({ action: "BUY_FILLED_ON_CANCEL", price: fillPrice, qty: solFilled });
                cancelOk = false;
              }
            }
            if (cancelOk) {
              const usdtFree  = await getFreeBalance("USDT");
              const usdtToUse = Math.min(usdtFree, state.entry_usdt ?? state.usdt_balance);
              const solQty    = floorQty(usdtToUse / newPrice);
              const newOrder  = await placeLimitBuySolUsdt(SYMBOL, solQty, newPrice);
              await updateSurferUsdtState({ chase_order_id: newOrder.orderId, chase_price: newPrice });
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
          const usdtOut   = parseFloat(order.cummulativeQuoteQty);
          const pnlUsdt   = usdtOut - (state.entry_usdt ?? 0);
          const pnlPct    = (state.entry_usdt ?? 0) > 0 ? (pnlUsdt / state.entry_usdt!) * 100 : 0;
          await updateSurferUsdtState({
            status:         "idle",
            mode:           "USDT",
            sol_quantity:   null,
            entry_price:    null,
            entry_usdt:     null,
            entry_time:     null,
            chase_order_id: null,
            chase_price:    null,
            usdt_balance:   usdtOut,   // compound: next trade uses actual proceeds
          });
          await recordSurferUsdtTrade({
            entry_price:  state.entry_price!,
            exit_price:   exitPrice,
            sol_quantity: state.sol_quantity!,
            usdt_in:      state.entry_usdt!,
            usdt_out:     usdtOut,
            pnl_usdt:     pnlUsdt,
            pnl_pct:      pnlPct,
            entry_time:   state.entry_time!,
          });
          log.push({ action: "SELL_FILLED", price: exitPrice, usdtOut, pnlUsdt, pnlPct });

        } else if (order.status === "CANCELED" || order.status === "EXPIRED") {
          await updateSurferUsdtState({ status: "idle", chase_order_id: null, chase_price: null });
          log.push({ action: "SELL_CANCELED" });

        } else {
          const newPrice = roundPrice(livePrice);
          if (newPrice !== state.chase_price) {
            let cancelOk = true;
            try {
              await cancelOrder(SYMBOL, state.chase_order_id!);
            } catch {
              const check = await getOrder(SYMBOL, state.chase_order_id!);
              if (check.status === "FILLED") {
                const exitPrice = parseFloat(check.cummulativeQuoteQty) / parseFloat(check.executedQty);
                const usdtOut   = parseFloat(check.cummulativeQuoteQty);
                const pnlUsdt   = usdtOut - (state.entry_usdt ?? 0);
                const pnlPct    = (state.entry_usdt ?? 0) > 0 ? (pnlUsdt / state.entry_usdt!) * 100 : 0;
                await updateSurferUsdtState({
                  status: "idle", mode: "USDT", sol_quantity: null,
                  entry_price: null, entry_usdt: null, entry_time: null,
                  chase_order_id: null, chase_price: null,
                  usdt_balance: usdtOut,   // compound: next trade uses actual proceeds
                });
                await recordSurferUsdtTrade({
                  entry_price: state.entry_price!, exit_price: exitPrice,
                  sol_quantity: state.sol_quantity!, usdt_in: state.entry_usdt!,
                  usdt_out: usdtOut, pnl_usdt: pnlUsdt, pnl_pct: pnlPct,
                  entry_time: state.entry_time!,
                });
                log.push({ action: "SELL_FILLED_ON_CANCEL", price: exitPrice, pnlUsdt });
                cancelOk = false;
              }
            }
            if (cancelOk) {
              const newOrder = await placeLimitSellSolUsdt(SYMBOL, state.sol_quantity!, newPrice);
              await updateSurferUsdtState({ chase_order_id: newOrder.orderId, chase_price: newPrice });
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

    await logSurferUsdtRun({ actions: log });
    return { ok: true, actions: log };
  },
});
