import { schedules } from "@trigger.dev/sdk/v3";
import {
  getKlines, placeMarketBuy, placeMarketSell, getFreeBalance,
} from "../lib/binance";
import { calcZScore, TP_PCT, SL_PCT, MAX_HOLD } from "../lib/strategy";
import {
  getXlmPosition, openXlmPosition, incrementXlmHold,
  setXlmChasing, updateXlmChaseFloor, closeXlmPosition,
  logXlmRun, getXlmSettings, setXlmPendingSell, getXlmPnLSum,
  setXlmBaseline, updateXlmBalance,
} from "../lib/xlm-live-db";

const SYMBOL       = "XLMUSDT";
const ALLOCATION   = 25;
const CHASE_OFFSET = 0.0005;
const CANDLES      = 50;
const Z_THRESH     = 1.5;   // more signals than ATOM bot's Z=2

function roundPrice(p: number) { return Math.round(p * 100000) / 100000; }  // 5 decimals for XLM
function floorQty(q: number)   { return Math.floor(q); }                     // XLM step size = 1

export const xlmLiveBot = schedules.task({
  id:          "live-bot-xlm-1m",
  cron:        "* * * * *",
  maxDuration: 55,

  run: async () => {
    const log: object[] = [];

    let settings;
    try {
      settings = await getXlmSettings();
    } catch (err) {
      await logXlmRun({ actions: [{ action: "ERROR", stage: "settings", error: String(err) }] });
      return { ok: false };
    }
    if (!settings?.enabled) return { ok: false, reason: "disabled" };

    // Fetch real USDT balance and publish bot allocation
    let usdtFree = 0;
    try {
      usdtFree = await getFreeBalance("USDT");
      let baseline = settings.baseline_usdt ?? 0;
      if (baseline === 0) {
        baseline = usdtFree - ALLOCATION;
        await setXlmBaseline(baseline);
      }
      await updateXlmBalance(Math.max(0, usdtFree - baseline));
    } catch (err) {
      log.push({ action: "ERROR", stage: "balance", error: String(err) });
      await logXlmRun({ actions: log });
      return { ok: false };
    }

    // Sell All — triggered by dashboard button
    if (settings.pending_sell) {
      try {
        const xlmFree = await getFreeBalance("XLM");
        if (xlmFree >= 1) {
          const qty = floorQty(xlmFree);
          await placeMarketSell(SYMBOL, qty);
          log.push({ action: "SELL_ALL", qty });
        }
        const newUsdt = await getFreeBalance("USDT");
        await setXlmBaseline(newUsdt - ALLOCATION);
        await updateXlmBalance(ALLOCATION);
        await setXlmPendingSell(false);
      } catch (err) {
        log.push({ action: "ERROR", stage: "sell_all", error: String(err) });
      }
      await logXlmRun({ actions: log });
      return { ok: true, actions: log };
    }

    const t0 = Date.now();

    try {
      const [btcCandles, altCandles] = await Promise.all([
        getKlines("BTCUSDT", "1m", CANDLES).then(c => c.slice(0, -1)),
        getKlines(SYMBOL,    "1m", CANDLES).then(c => c.slice(0, -1)),
      ]);

      const price = altCandles[altCandles.length - 1].close;
      const z     = calcZScore(btcCandles, altCandles);
      const pos   = await getXlmPosition();

      if (pos) {

        if (pos.status === "open") {
          if (price >= pos.tp) {
            const exitOrder = await placeMarketSell(SYMBOL, pos.quantity);
            const exitPrice = parseFloat(exitOrder.cummulativeQuoteQty) / parseFloat(exitOrder.executedQty);
            const pnl = (exitPrice - pos.entry_price) * pos.quantity;
            await closeXlmPosition(pos.id, { exit_price: exitPrice, pnl, result: "TP" });
            log.push({ action: "TP", exit: exitPrice, pnl: pnl.toFixed(4) });

          } else if (price <= pos.sl) {
            const exitOrder = await placeMarketSell(SYMBOL, pos.quantity);
            const exitPrice = parseFloat(exitOrder.cummulativeQuoteQty) / parseFloat(exitOrder.executedQty);
            const pnl = (exitPrice - pos.entry_price) * pos.quantity;
            await closeXlmPosition(pos.id, { exit_price: exitPrice, pnl, result: "SL" });
            log.push({ action: "SL", exit: exitPrice, pnl: pnl.toFixed(4) });

          } else if (pos.hold_count + 1 >= MAX_HOLD) {
            const chaseFloor = roundPrice(price * (1 - CHASE_OFFSET));
            await setXlmChasing(pos.id, chaseFloor);
            log.push({ action: "START_CHASE", price, chaseFloor });

          } else {
            await incrementXlmHold(pos.id, pos.hold_count);
            log.push({ action: "HOLD", hold: pos.hold_count + 1, price, tp: pos.tp, sl: pos.sl });
          }

        } else if (pos.status === "chasing") {
          const chaseFloor = pos.chase_price;

          if (price <= chaseFloor) {
            const exitOrder = await placeMarketSell(SYMBOL, pos.quantity);
            const exitPrice = parseFloat(exitOrder.cummulativeQuoteQty) / parseFloat(exitOrder.executedQty);
            const pnl = (exitPrice - pos.entry_price) * pos.quantity;
            await closeXlmPosition(pos.id, { exit_price: exitPrice, pnl, result: "CHASE_EXIT" });
            log.push({ action: "CHASE_EXIT", exit: exitPrice, pnl: pnl.toFixed(4) });

          } else {
            const newFloor = roundPrice(price * (1 - CHASE_OFFSET));
            if (newFloor > chaseFloor) {
              await updateXlmChaseFloor(pos.id, newFloor);
              log.push({ action: "CHASE_UP", price, newFloor });
            } else {
              log.push({ action: "CHASE_HOLD", price, chaseFloor });
            }
          }
        }

      } else {
        if (z <= -Z_THRESH) {
          const pnlSum = await getXlmPnLSum();
          const availableCapital = Math.max(0, ALLOCATION + pnlSum);
          const estQty = floorQty(availableCapital / price);
          if (estQty >= 1) {
            const buyOrder  = await placeMarketBuy(SYMBOL, estQty);
            const fillPrice = parseFloat(buyOrder.cummulativeQuoteQty) / parseFloat(buyOrder.executedQty);
            const filledQty = floorQty(await getFreeBalance("XLM"));
            const tp        = roundPrice(fillPrice * (1 + TP_PCT));
            const sl        = roundPrice(fillPrice * (1 - SL_PCT));
            await openXlmPosition({ symbol: SYMBOL, entry_price: fillPrice, sl, tp, quantity: filledQty, z_score: z });
            log.push({ action: "OPEN", entry: fillPrice, qty: filledQty, tp, sl, z: z.toFixed(3), elapsed_ms: Date.now() - t0 });
          }
        } else {
          log.push({ action: "WATCH", z: z.toFixed(3), price });
        }
      }

    } catch (err) {
      log.push({ action: "ERROR", stage: "trading", error: String(err) });
    }

    await logXlmRun({ actions: log });
    console.log("XLM live bot run:", JSON.stringify(log, null, 2));
    return { ok: true, actions: log };
  },
});
