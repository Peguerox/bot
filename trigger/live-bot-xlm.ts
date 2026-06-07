import { schedules } from "@trigger.dev/sdk/v3";
import {
  getKlines, getFreeBalance, getOrder, getPrice, cancelOrder, cancelAllOrders,
  placeMarketSell, placeLimitBuyXlm, placeLimitSellXlm, placeStopLimitSellXlm,
} from "../lib/binance";
import { calcZScore, TP_PCT, SL_PCT, MAX_HOLD } from "../lib/strategy";
import {
  getXlmPosition, openXlmPendingEntry, setXlmEntryFilled,
  incrementXlmHold, setXlmChasing, updateXlmChaseFloor, closeXlmPosition,
  logXlmRun, getXlmSettings, setXlmPendingSell, getXlmPnLSum,
  setXlmBaseline, updateXlmBalance,
} from "../lib/xlm-live-db";

const SYMBOL       = "XLMUSDT";
const ALLOCATION   = 25;
const CHASE_OFFSET = 0.0005;
const CANDLES      = 50;
const Z_THRESH     = 1.5;
const SL_SLIP      = 0.002;   // limit price 0.2% below stop to ensure fill
const RESCUE_SLIP  = 0.0001;  // rescue limit sell 0.01% below live price

function roundPrice(p: number) { return Math.round(p * 100000) / 100000; }
function floorQty(q: number)   { return Math.floor(q); }
function sleep(ms: number)     { return new Promise(r => setTimeout(r, ms)); }

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
        try { await cancelAllOrders(SYMBOL); } catch {}
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

    try {
      const [btcCandles, altCandles] = await Promise.all([
        getKlines("BTCUSDT", "1m", CANDLES).then(c => c.slice(0, -1)),
        getKlines(SYMBOL,    "1m", CANDLES).then(c => c.slice(0, -1)),
      ]);

      const price = altCandles[altCandles.length - 1].close;
      const z     = calcZScore(btcCandles, altCandles);
      const pos   = await getXlmPosition();

      if (pos) {

        // ── Waiting for limit buy to fill ──────────────────────────────────────
        if (pos.status === "pending_entry") {
          let filled = false;
          for (let attempt = 0; attempt < 4 && !filled; attempt++) {
            if (attempt > 0) await sleep(10000);
            const order = await getOrder(SYMBOL, pos.entry_order_id);
            if (order.status === "FILLED") {
              const fillPrice    = parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty);
              const filledQty    = floorQty(parseFloat(order.executedQty));
              const currentPrice = await getPrice(SYMBOL);
              const tp           = roundPrice(currentPrice * (1 + TP_PCT));
              const sl           = roundPrice(currentPrice * (1 - SL_PCT));
              const slLimit   = roundPrice(sl * (1 - SL_SLIP));
              const [tpOrder, slOrder] = await Promise.all([
                placeLimitSellXlm(SYMBOL, filledQty, tp),
                placeStopLimitSellXlm(SYMBOL, filledQty, sl, slLimit),
              ]);
              await setXlmEntryFilled(pos.id, {
                entry_price: fillPrice,
                quantity:    filledQty,
                tp,
                sl,
                tp_order_id: tpOrder.orderId,
                sl_order_id: slOrder.orderId,
              });
              log.push({ action: "ENTRY_FILLED", entry: fillPrice, qty: filledQty, tp, sl });
              filled = true;
            }
          }
          if (!filled) log.push({ action: "PENDING_FILL", orderId: pos.entry_order_id });

        // ── Hold phase: check if TP or SL limit order filled ──────────────────
        } else if (pos.status === "open") {
          const [tpOrder, slOrder, livePrice] = await Promise.all([
            getOrder(SYMBOL, pos.tp_order_id),
            getOrder(SYMBOL, pos.sl_order_id),
            getPrice(SYMBOL),
          ]);

          if (tpOrder.status === "FILLED") {
            try { await cancelOrder(SYMBOL, pos.sl_order_id); } catch {}
            const exitPrice = parseFloat(tpOrder.cummulativeQuoteQty) / parseFloat(tpOrder.executedQty);
            const pnl = (exitPrice - pos.entry_price) * pos.quantity;
            await closeXlmPosition(pos.id, { exit_price: exitPrice, pnl, result: "TP" });
            log.push({ action: "TP", exit: exitPrice, pnl: pnl.toFixed(4) });

          } else if (slOrder.status === "FILLED") {
            try { await cancelOrder(SYMBOL, pos.tp_order_id); } catch {}
            const exitPrice = parseFloat(slOrder.cummulativeQuoteQty) / parseFloat(slOrder.executedQty);
            const pnl = (exitPrice - pos.entry_price) * pos.quantity;
            await closeXlmPosition(pos.id, { exit_price: exitPrice, pnl, result: "SL" });
            log.push({ action: "SL", exit: exitPrice, pnl: pnl.toFixed(4) });

          } else if (livePrice < pos.sl) {
            try { await cancelAllOrders(SYMBOL); } catch {}
            const rescuePrice = roundPrice(livePrice * (1 - RESCUE_SLIP));
            const rescueOrder = await placeLimitSellXlm(SYMBOL, pos.quantity, rescuePrice);
            await setXlmChasing(pos.id, rescuePrice, rescueOrder.orderId);
            log.push({ action: "STUCK_RESCUE", livePrice, sl: pos.sl, rescuePrice });

          } else if (pos.hold_count + 1 >= MAX_HOLD) {
            await Promise.all([
              cancelOrder(SYMBOL, pos.tp_order_id),
              cancelOrder(SYMBOL, pos.sl_order_id),
            ]);
            const livePrice   = await getPrice(SYMBOL);
            const chaseFloor  = roundPrice(livePrice * (1 - CHASE_OFFSET));
            const chaseSlOrder = await placeStopLimitSellXlm(
              SYMBOL, pos.quantity, chaseFloor, roundPrice(chaseFloor * (1 - SL_SLIP))
            );
            await setXlmChasing(pos.id, chaseFloor, chaseSlOrder.orderId);
            log.push({ action: "START_CHASE", livePrice, chaseFloor });

          } else {
            await incrementXlmHold(pos.id, pos.hold_count);
            log.push({ action: "HOLD", hold: pos.hold_count + 1, price, tp: pos.tp, sl: pos.sl });
          }

        // ── Chase phase: trailing stop-loss-limit ──────────────────────────────
        } else if (pos.status === "chasing") {
          const slOrder = await getOrder(SYMBOL, pos.sl_order_id);

          if (slOrder.status === "FILLED") {
            const exitPrice = parseFloat(slOrder.cummulativeQuoteQty) / parseFloat(slOrder.executedQty);
            const pnl = (exitPrice - pos.entry_price) * pos.quantity;
            await closeXlmPosition(pos.id, { exit_price: exitPrice, pnl, result: "CHASE_EXIT" });
            log.push({ action: "CHASE_EXIT", exit: exitPrice, pnl: pnl.toFixed(4) });

          } else {
            const livePrice = await getPrice(SYMBOL);

            if (livePrice < pos.chase_price) {
              try { await cancelAllOrders(SYMBOL); } catch {}
              const rescuePrice = roundPrice(livePrice * (1 - RESCUE_SLIP));
              const rescueOrder = await placeLimitSellXlm(SYMBOL, pos.quantity, rescuePrice);
              await updateXlmChaseFloor(pos.id, rescuePrice, rescueOrder.orderId);
              log.push({ action: "STUCK_RESCUE_CHASE", livePrice, chaseFloor: pos.chase_price, rescuePrice });

            } else {
              const newFloor = roundPrice(livePrice * (1 - CHASE_OFFSET));
              if (newFloor > pos.chase_price) {
                await cancelOrder(SYMBOL, pos.sl_order_id);
                const newSlOrder = await placeStopLimitSellXlm(
                  SYMBOL, pos.quantity, newFloor, roundPrice(newFloor * (1 - SL_SLIP))
                );
                await updateXlmChaseFloor(pos.id, newFloor, newSlOrder.orderId);
                log.push({ action: "CHASE_UP", livePrice, newFloor });
              } else {
                log.push({ action: "CHASE_HOLD", livePrice, chaseFloor: pos.chase_price });
              }
            }
          }
        }

      } else {
        // ── No position: look for entry signal ────────────────────────────────
        if (z <= -Z_THRESH) {
          const pnlSum           = await getXlmPnLSum();
          const availableCapital = Math.min(Math.max(0, ALLOCATION + pnlSum), usdtFree);
          const qty              = floorQty(availableCapital / price);
          if (qty >= 1) {
            const limitOrder = await placeLimitBuyXlm(SYMBOL, qty, roundPrice(price));
            await openXlmPendingEntry({ symbol: SYMBOL, entry_order_id: limitOrder.orderId, quantity: qty, z_score: z });
            log.push({ action: "LIMIT_BUY_PLACED", qty, price: roundPrice(price), orderId: limitOrder.orderId, z: z.toFixed(3) });
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
