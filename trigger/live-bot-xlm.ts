import { schedules } from "@trigger.dev/sdk/v3";
import {
  getKlines, getFreeBalance, getOrder, getPrice, cancelOrder, cancelAllOrders,
  placeMarketSellXlm, placeLimitBuyXlm, placeLimitSellXlm, placeStopLimitSellXlm, placeOcoSellXlm,
} from "../lib/binance";
import { calcZScore, TP_PCT, SL_PCT, MAX_HOLD } from "../lib/strategy";
import {
  getXlmPosition, openXlmPendingEntry, setXlmEntryFilled,
  incrementXlmHold, setXlmChasing, updateXlmChaseFloor, closeXlmPosition,
  logXlmRun, getXlmSettings, setXlmPendingSell,
  setXlmBaseline, updateXlmBalance, updateXlmTotal, addXlmPnl,
} from "../lib/xlm-live-db";

const SYMBOL       = "XLMUSDT";
const ALLOCATION   = 25;
const CHASE_OFFSET = 0.001;
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
      await updateXlmTotal(usdtFree);
      // Init balance once if never set
      if (!settings.usdt_balance || settings.usdt_balance === 0) {
        await updateXlmBalance(ALLOCATION);
      }
    } catch (err) {
      log.push({ action: "ERROR", stage: "balance", error: String(err) });
      await logXlmRun({ actions: log });
      return { ok: false };
    }

    // Sell All — triggered by dashboard button
    if (settings.pending_sell) {
      try {
        try { await cancelAllOrders(SYMBOL); } catch {}
        const xlmFree  = await getFreeBalance("XLM");
        const xlmPrice = await getPrice(SYMBOL);
        const qty      = floorQty(xlmFree);
        if (qty >= 1 && qty * xlmPrice >= 1.1) {
          await placeMarketSellXlm(SYMBOL, qty);
          log.push({ action: "SELL_ALL", qty });
        } else {
          log.push({ action: "SELL_ALL_SKIP", xlmFree, reason: "below MIN_NOTIONAL" });
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
          for (let attempt = 0; attempt < 10 && !filled; attempt++) {
            if (attempt > 0) await sleep(5000);
            const order = await getOrder(SYMBOL, pos.entry_order_id);
            if (order.status === "FILLED") {
              const fillPrice    = parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty);
              const filledQty    = floorQty(parseFloat(order.executedQty));
              const tp           = roundPrice(fillPrice * (1 + TP_PCT));
              const sl           = roundPrice(fillPrice * (1 - SL_PCT));
              const slLimit  = roundPrice(sl * (1 - SL_SLIP));
              try { await cancelAllOrders(SYMBOL); } catch {}
              const oco      = await placeOcoSellXlm(SYMBOL, filledQty, tp, sl, slLimit);
              // SL = the stop-type order; TP = everything else (LIMIT_MAKER or TAKE_PROFIT_LIMIT)
              const slReport = oco.orderReports.find(r => r.type === "STOP_LOSS_LIMIT" || r.type === "STOP_LOSS");
              const tpReport = oco.orderReports.find(r => r !== slReport);
              await setXlmEntryFilled(pos.id, {
                entry_price: fillPrice,
                quantity:    filledQty,
                tp,
                sl,
                tp_order_id: tpReport!.orderId,
                sl_order_id: slReport!.orderId,
              });
              log.push({ action: "ENTRY_FILLED", entry: fillPrice, qty: filledQty, tp, sl });
              filled = true;
            } else if (order.status === "CANCELED" || order.status === "EXPIRED") {
              await closeXlmPosition(pos.id, { exit_price: 0, pnl: 0, result: "CANCELED" });
              log.push({ action: "ENTRY_CANCELED", orderId: pos.entry_order_id });
              filled = true; // break the poll loop
            } else {
              const livePrice    = await getPrice(SYMBOL);
              const orderPrice   = parseFloat(order.price);
              if (livePrice > orderPrice) {
                const freshOrder = await getOrder(SYMBOL, pos.entry_order_id);
                if (freshOrder.status === "FILLED") {
                  const fillPrice    = parseFloat(freshOrder.cummulativeQuoteQty) / parseFloat(freshOrder.executedQty);
                  const filledQty    = floorQty(parseFloat(freshOrder.executedQty));
                  const tp           = roundPrice(fillPrice * (1 + TP_PCT));
                  const sl           = roundPrice(fillPrice * (1 - SL_PCT));
                  const slLimit      = roundPrice(sl * (1 - SL_SLIP));
                  try { await cancelAllOrders(SYMBOL); } catch {}
                  const oco      = await placeOcoSellXlm(SYMBOL, filledQty, tp, sl, slLimit);
                  const slReport = oco.orderReports.find(r => r.type === "STOP_LOSS_LIMIT" || r.type === "STOP_LOSS");
                  const tpReport = oco.orderReports.find(r => r !== slReport);
                  await setXlmEntryFilled(pos.id, {
                    entry_price: fillPrice,
                    quantity:    filledQty,
                    tp,
                    sl,
                    tp_order_id: tpReport!.orderId,
                    sl_order_id: slReport!.orderId,
                  });
                  log.push({ action: "ENTRY_FILLED", entry: fillPrice, qty: filledQty, tp, sl });
                  filled = true;
                } else {
                  try { await cancelOrder(SYMBOL, pos.entry_order_id); } catch {}
                  await closeXlmPosition(pos.id, { exit_price: 0, pnl: 0, result: "MISSED" });
                  log.push({ action: "MISSED", livePrice, orderPrice });
                  filled = true;
                }
              }
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
            await addXlmPnl(pnl);
            log.push({ action: "TP", exit: exitPrice, pnl: pnl.toFixed(4) });

          } else if (slOrder.status === "FILLED") {
            try { await cancelOrder(SYMBOL, pos.tp_order_id); } catch {}
            const exitPrice = parseFloat(slOrder.cummulativeQuoteQty) / parseFloat(slOrder.executedQty);
            const pnl = (exitPrice - pos.entry_price) * pos.quantity;
            await closeXlmPosition(pos.id, { exit_price: exitPrice, pnl, result: "SL" });
            await addXlmPnl(pnl);
            log.push({ action: "SL", exit: exitPrice, pnl: pnl.toFixed(4) });

          } else if (livePrice < pos.sl) {
            try { await cancelAllOrders(SYMBOL); } catch {}
            const rescuePrice = roundPrice(livePrice * (1 - RESCUE_SLIP));
            const rescueOrder = await placeLimitSellXlm(SYMBOL, pos.quantity, rescuePrice);
            await setXlmChasing(pos.id, rescuePrice, rescueOrder.orderId);
            log.push({ action: "STUCK_RESCUE", livePrice, sl: pos.sl, rescuePrice });

          } else if (pos.hold_count + 1 >= MAX_HOLD) {
            try { await cancelOrder(SYMBOL, pos.tp_order_id); } catch {}
            try { await cancelOrder(SYMBOL, pos.sl_order_id); } catch {}
            const xlmFree = await getFreeBalance("XLM");
            if (floorQty(xlmFree) < 1) {
              // SL fired between our check and cancellation — recover fill from order
              const slOrder   = await getOrder(SYMBOL, pos.sl_order_id);
              const exitPrice = parseFloat(slOrder.cummulativeQuoteQty) / parseFloat(slOrder.executedQty);
              const pnl       = (exitPrice - pos.entry_price) * pos.quantity;
              await closeXlmPosition(pos.id, { exit_price: exitPrice, pnl, result: "SL" });
              await addXlmPnl(pnl);
              log.push({ action: "SL_RACE_RECOVERED", exit: exitPrice, pnl: pnl.toFixed(4) });
            } else {
              const exitPrice = roundPrice(await getPrice(SYMBOL));
              const exitOrder = await placeLimitSellXlm(SYMBOL, pos.quantity, exitPrice);
              await setXlmChasing(pos.id, exitPrice, exitOrder.orderId);
              log.push({ action: "START_EXIT", exitPrice });
            }

          } else {
            await incrementXlmHold(pos.id, pos.hold_count);
            log.push({ action: "HOLD", hold: pos.hold_count + 1, price, tp: pos.tp, sl: pos.sl });
          }

        // ── Exit phase: limit sell at current price, reprice each candle ────────
        } else if (pos.status === "chasing") {
          const exitOrder = await getOrder(SYMBOL, pos.sl_order_id);

          if (exitOrder.status === "FILLED") {
            const exitPrice = parseFloat(exitOrder.cummulativeQuoteQty) / parseFloat(exitOrder.executedQty);
            const pnl = (exitPrice - pos.entry_price) * pos.quantity;
            await closeXlmPosition(pos.id, { exit_price: exitPrice, pnl, result: "CHASE_EXIT" });
            await addXlmPnl(pnl);
            log.push({ action: "CHASE_EXIT", exit: exitPrice, pnl: pnl.toFixed(4) });

          } else {
            const livePrice  = await getPrice(SYMBOL);
            const newPrice   = roundPrice(livePrice);

            if (newPrice !== pos.chase_price) {
              let cancelOk = true;
              try {
                await cancelOrder(SYMBOL, pos.sl_order_id);
              } catch {
                const check = await getOrder(SYMBOL, pos.sl_order_id);
                if (check.status === "FILLED") {
                  const exitPrice = parseFloat(check.cummulativeQuoteQty) / parseFloat(check.executedQty);
                  const pnl = (exitPrice - pos.entry_price) * pos.quantity;
                  await closeXlmPosition(pos.id, { exit_price: exitPrice, pnl, result: "CHASE_EXIT" });
                  await addXlmPnl(pnl);
                  log.push({ action: "CHASE_EXIT", exit: exitPrice, pnl: pnl.toFixed(4) });
                  cancelOk = false;
                }
              }
              if (cancelOk) {
                const newOrder = await placeLimitSellXlm(SYMBOL, pos.quantity, newPrice);
                await updateXlmChaseFloor(pos.id, newPrice, newOrder.orderId);
                log.push({ action: "EXIT_REPRICE", from: pos.chase_price, to: newPrice });
              }
            } else {
              log.push({ action: "EXIT_HOLD", price: livePrice });
            }
          }
        }

      } else {
        // ── No position: look for entry signal ────────────────────────────────
        if (z <= -Z_THRESH) {
          const botBalance       = settings.usdt_balance ?? ALLOCATION;
          const qty              = floorQty(Math.min(botBalance, usdtFree) / price);
          if (qty >= 1) {
            const limitOrder = await placeLimitBuyXlm(SYMBOL, qty, roundPrice(price * 1.0002));
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
