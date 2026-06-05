import { schedules } from "@trigger.dev/sdk/v3";
import {
  getKlines, getPrice, placeMarketBuy, placeMarketSell, getFreeBalance,
} from "../lib/binance";
import { calcZScore, Z_THRESH, TP_PCT, SL_PCT, MAX_HOLD } from "../lib/strategy";
import {
  getLivePosition, openLivePosition, incrementLiveHold,
  setLiveChasing, updateLiveChaseFloor, closeLivePosition,
  logLiveRun, getLiveSettings, updateLiveBalance,
} from "../lib/live-db";

const SYMBOL       = "ATOMUSDT";
const ALLOCATION   = 50;
const CHASE_OFFSET = 0.0005;   // 0.05% trailing floor
const CANDLES      = 50;

function roundPrice(p: number) { return Math.round(p * 1000) / 1000; }
function floorQty(q: number)   { return Math.floor(q * 100) / 100; }

export const liveBot = schedules.task({
  id:          "live-bot-atom-1m",
  cron:        "* * * * *",
  maxDuration: 55,

  run: async () => {
    const log: object[] = [];

    // Kill switch
    let settings;
    try {
      settings = await getLiveSettings();
    } catch (err) {
      await logLiveRun({ actions: [{ action: "ERROR", stage: "settings", error: String(err) }] });
      return { ok: false };
    }
    if (!settings?.enabled) return { ok: false, reason: "disabled" };

    // Real balance
    let usdtFree = 0;
    try {
      usdtFree = await getFreeBalance("USDT");
      await updateLiveBalance(usdtFree);
    } catch (err) {
      log.push({ action: "ERROR", stage: "balance", error: String(err) });
      await logLiveRun({ actions: log });
      return { ok: false };
    }

    try {
      const [btcCandles, altCandles, price] = await Promise.all([
        getKlines("BTCUSDT", "1m", CANDLES).then(c => c.slice(0, -1)),
        getKlines(SYMBOL,    "1m", CANDLES).then(c => c.slice(0, -1)),
        getPrice(SYMBOL),
      ]);

      const z   = calcZScore(btcCandles, altCandles);
      const pos = await getLivePosition();

      if (pos) {

        if (pos.status === "open") {
          if (price >= pos.tp) {
            const exitOrder = await placeMarketSell(SYMBOL, pos.quantity);
            const exitPrice = parseFloat(exitOrder.cummulativeQuoteQty) / parseFloat(exitOrder.executedQty);
            const pnl = (exitPrice - pos.entry_price) * pos.quantity;
            await closeLivePosition(pos.id, { exit_price: exitPrice, pnl, result: "TP" });
            log.push({ action: "TP", exit: exitPrice, pnl: pnl.toFixed(4) });

          } else if (price <= pos.sl) {
            const exitOrder = await placeMarketSell(SYMBOL, pos.quantity);
            const exitPrice = parseFloat(exitOrder.cummulativeQuoteQty) / parseFloat(exitOrder.executedQty);
            const pnl = (exitPrice - pos.entry_price) * pos.quantity;
            await closeLivePosition(pos.id, { exit_price: exitPrice, pnl, result: "SL" });
            log.push({ action: "SL", exit: exitPrice, pnl: pnl.toFixed(4) });

          } else if (pos.hold_count + 1 >= MAX_HOLD) {
            const chaseFloor = roundPrice(price * (1 - CHASE_OFFSET));
            await setLiveChasing(pos.id, chaseFloor);
            log.push({ action: "START_CHASE", price, chaseFloor });

          } else {
            await incrementLiveHold(pos.id, pos.hold_count);
            log.push({ action: "HOLD", hold: pos.hold_count + 1, price, tp: pos.tp, sl: pos.sl });
          }

        } else if (pos.status === "chasing") {
          const chaseFloor = pos.chase_price;

          if (price <= chaseFloor) {
            const exitOrder = await placeMarketSell(SYMBOL, pos.quantity);
            const exitPrice = parseFloat(exitOrder.cummulativeQuoteQty) / parseFloat(exitOrder.executedQty);
            const pnl = (exitPrice - pos.entry_price) * pos.quantity;
            await closeLivePosition(pos.id, { exit_price: exitPrice, pnl, result: "CHASE_EXIT" });
            log.push({ action: "CHASE_EXIT", exit: exitPrice, pnl: pnl.toFixed(4) });

          } else {
            const newFloor = roundPrice(price * (1 - CHASE_OFFSET));
            if (newFloor > chaseFloor) {
              await updateLiveChaseFloor(pos.id, newFloor);
              log.push({ action: "CHASE_UP", price, newFloor });
            } else {
              log.push({ action: "CHASE_HOLD", price, chaseFloor });
            }
          }
        }

      } else {
        if (z <= -Z_THRESH) {
          const spend = Math.min(usdtFree, ALLOCATION);
          if (spend < 5) {
            log.push({ action: "SKIP_NO_FUNDS", balance: usdtFree });
          } else {
            const estQty = floorQty(spend / price);
            if (estQty * price >= 1) {
              const buyOrder  = await placeMarketBuy(SYMBOL, estQty);
              const fillPrice = parseFloat(buyOrder.cummulativeQuoteQty) / parseFloat(buyOrder.executedQty);
              const filledQty = floorQty(await getFreeBalance("ATOM"));
              const tp        = roundPrice(fillPrice * (1 + TP_PCT));
              const sl        = roundPrice(fillPrice * (1 - SL_PCT));
              await openLivePosition({ symbol: SYMBOL, entry_price: fillPrice, sl, tp, quantity: filledQty, z_score: z });
              log.push({ action: "OPEN", entry: fillPrice, qty: filledQty, tp, sl, z: z.toFixed(3) });
            }
          }
        } else {
          log.push({ action: "WATCH", z: z.toFixed(3), price });
        }
      }

    } catch (err) {
      log.push({ action: "ERROR", stage: "trading", error: String(err) });
    }

    await logLiveRun({ actions: log });
    console.log("Live bot run:", JSON.stringify(log, null, 2));
    return { ok: true, actions: log };
  },
});
