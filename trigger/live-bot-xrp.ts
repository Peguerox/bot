import { schedules } from "@trigger.dev/sdk/v3";
import {
  getKlinesGlobal, getFreeBalanceGlobal, getOrderGlobal, getPriceGlobal,
  cancelOrderGlobal, cancelAllOrdersGlobal,
  placeMarketSellXrp, placeLimitBuyXrp, placeLimitSellXrp, placeOcoSellXrp,
} from "../lib/binance-global";
import { calcZScore, TP_PCT, SL_PCT, MAX_HOLD } from "../lib/strategy";
import {
  getXrpPosition, openXrpPendingEntry, setXrpEntryFilled,
  incrementXrpHold, setXrpChasing, updateXrpChaseFloor, closeXrpPosition,
  logXrpRun, getXrpSettings, setXrpBaseline, updateXrpBalance, updateXrpTotal,
  setXrpPendingSell, addXrpPnl,
} from "../lib/xrp-live-db";

const SYMBOL      = "XRPFDUSD";
const ALLOCATION  = 25;
const CANDLES     = 50;
const Z_THRESH    = 1.5;
const SL_SLIP     = 0.002;
const RESCUE_SLIP = 0.0001;

function roundPrice(p: number) { return Math.round(p * 10000) / 10000; }
function floorQty(q: number)   { return Math.floor(q * 10) / 10; }
function sleep(ms: number)     { return new Promise(r => setTimeout(r, ms)); }

export const xrpLiveBot = schedules.task({
  id:          "live-bot-xrp-1m",
  cron:        "* * * * *",
  maxDuration: 55,

  run: async () => {
    return { ok: false, reason: "deprecated" };
    const log: object[] = [];

    let settings;
    try {
      settings = await getXrpSettings();
    } catch (err) {
      await logXrpRun({ actions: [{ action: "ERROR", stage: "settings", error: String(err) }] });
      return { ok: false };
    }
    if (!settings?.enabled) return { ok: false, reason: "disabled" };

    let fdusdFree = 0;
    try {
      fdusdFree = await getFreeBalanceGlobal("FDUSD");
      await updateXrpTotal(fdusdFree);
      if (!settings.usdt_balance || settings.usdt_balance === 0) {
        await updateXrpBalance(ALLOCATION);
      }
    } catch (err) {
      log.push({ action: "ERROR", stage: "balance", error: String(err) });
      await logXrpRun({ actions: log });
      return { ok: false };
    }

    // Sell All — triggered by dashboard button
    if (settings.pending_sell) {
      try {
        try { await cancelAllOrdersGlobal(SYMBOL); } catch {}
        const xrpFree  = await getFreeBalanceGlobal("XRP");
        const xrpPrice = await getPriceGlobal(SYMBOL);
        const qty      = floorQty(xrpFree);
        if (qty >= 0.1 && qty * xrpPrice >= 5) {
          await placeMarketSellXrp(SYMBOL, qty);
          log.push({ action: "SELL_ALL", qty });
        } else {
          log.push({ action: "SELL_ALL_SKIP", xrpFree, reason: "below MIN_NOTIONAL" });
        }
        const newFdusd = await getFreeBalanceGlobal("FDUSD");
        await setXrpBaseline(newFdusd - ALLOCATION);
        await updateXrpBalance(ALLOCATION);
        await setXrpPendingSell(false);
      } catch (err) {
        log.push({ action: "ERROR", stage: "sell_all", error: String(err) });
      }
      await logXrpRun({ actions: log });
      return { ok: true, actions: log };
    }

    try {
      const [btcCandles, altCandles] = await Promise.all([
        getKlinesGlobal("BTCFDUSD", "1m", CANDLES).then(c => c.slice(0, -1)),
        getKlinesGlobal(SYMBOL,     "1m", CANDLES).then(c => c.slice(0, -1)),
      ]);

      const price = altCandles[altCandles.length - 1].close;
      const z     = calcZScore(btcCandles, altCandles);
      const pos   = await getXrpPosition();

      if (pos) {

        // ── Waiting for limit buy to fill ──────────────────────────────────────
        if (pos.status === "pending_entry") {
          let filled = false;
          for (let attempt = 0; attempt < 4 && !filled; attempt++) {
            if (attempt > 0) await sleep(10000);
            const order = await getOrderGlobal(SYMBOL, pos.entry_order_id);
            if (order.status === "FILLED") {
              const fillPrice    = parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty);
              const filledQty    = floorQty(parseFloat(order.executedQty));
              const currentPrice = await getPriceGlobal(SYMBOL);
              const tp           = roundPrice(currentPrice * (1 + TP_PCT));
              const sl           = roundPrice(currentPrice * (1 - SL_PCT));
              const slLimit      = roundPrice(sl * (1 - SL_SLIP));
              try { await cancelAllOrdersGlobal(SYMBOL); } catch {}
              const oco      = await placeOcoSellXrp(SYMBOL, filledQty, tp, sl, slLimit);
              const slReport = oco.orderReports.find(r => r.type === "STOP_LOSS_LIMIT" || r.type === "STOP_LOSS");
              const tpReport = oco.orderReports.find(r => r !== slReport);
              await setXrpEntryFilled(pos.id, {
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
              await closeXrpPosition(pos.id, { exit_price: 0, pnl: 0, result: "CANCELED" });
              log.push({ action: "ENTRY_CANCELED", orderId: pos.entry_order_id });
              filled = true;
            } else {
              const livePrice  = await getPriceGlobal(SYMBOL);
              const orderPrice = parseFloat(order.price);
              if (livePrice > orderPrice) {
                try { await cancelOrderGlobal(SYMBOL, pos.entry_order_id); } catch {}
                await closeXrpPosition(pos.id, { exit_price: 0, pnl: 0, result: "MISSED" });
                log.push({ action: "MISSED", livePrice, orderPrice });
                filled = true;
              }
            }
          }
          if (!filled) log.push({ action: "PENDING_FILL", orderId: pos.entry_order_id });

        // ── Hold phase: check if TP or SL filled ──────────────────────────────
        } else if (pos.status === "open") {
          const [tpOrder, slOrder, livePrice] = await Promise.all([
            getOrderGlobal(SYMBOL, pos.tp_order_id),
            getOrderGlobal(SYMBOL, pos.sl_order_id),
            getPriceGlobal(SYMBOL),
          ]);

          if (tpOrder.status === "FILLED") {
            try { await cancelOrderGlobal(SYMBOL, pos.sl_order_id); } catch {}
            const exitPrice = parseFloat(tpOrder.cummulativeQuoteQty) / parseFloat(tpOrder.executedQty);
            const pnl = (exitPrice - pos.entry_price) * pos.quantity;
            await closeXrpPosition(pos.id, { exit_price: exitPrice, pnl, result: "TP" });
            await addXrpPnl(pnl);
            log.push({ action: "TP", exit: exitPrice, pnl: pnl.toFixed(4) });

          } else if (slOrder.status === "FILLED") {
            try { await cancelOrderGlobal(SYMBOL, pos.tp_order_id); } catch {}
            const exitPrice = parseFloat(slOrder.cummulativeQuoteQty) / parseFloat(slOrder.executedQty);
            const pnl = (exitPrice - pos.entry_price) * pos.quantity;
            await closeXrpPosition(pos.id, { exit_price: exitPrice, pnl, result: "SL" });
            await addXrpPnl(pnl);
            log.push({ action: "SL", exit: exitPrice, pnl: pnl.toFixed(4) });

          } else if (livePrice < pos.sl) {
            try { await cancelAllOrdersGlobal(SYMBOL); } catch {}
            const rescuePrice = roundPrice(livePrice * (1 - RESCUE_SLIP));
            const rescueOrder = await placeLimitSellXrp(SYMBOL, pos.quantity, rescuePrice);
            await setXrpChasing(pos.id, rescuePrice, rescueOrder.orderId);
            log.push({ action: "STUCK_RESCUE", livePrice, sl: pos.sl, rescuePrice });

          } else if (pos.hold_count + 1 >= MAX_HOLD) {
            try { await cancelOrderGlobal(SYMBOL, pos.tp_order_id); } catch {}
            try { await cancelOrderGlobal(SYMBOL, pos.sl_order_id); } catch {}
            const exitPrice = roundPrice(await getPriceGlobal(SYMBOL));
            const exitOrder = await placeLimitSellXrp(SYMBOL, pos.quantity, exitPrice);
            await setXrpChasing(pos.id, exitPrice, exitOrder.orderId);
            log.push({ action: "START_EXIT", exitPrice });

          } else {
            await incrementXrpHold(pos.id, pos.hold_count);
            log.push({ action: "HOLD", hold: pos.hold_count + 1, price, tp: pos.tp, sl: pos.sl });
          }

        // ── Exit phase: limit sell at current price, reprice each candle ───────
        } else if (pos.status === "chasing") {
          const exitOrder = await getOrderGlobal(SYMBOL, pos.sl_order_id);

          if (exitOrder.status === "FILLED") {
            const exitPrice = parseFloat(exitOrder.cummulativeQuoteQty) / parseFloat(exitOrder.executedQty);
            const pnl = (exitPrice - pos.entry_price) * pos.quantity;
            await closeXrpPosition(pos.id, { exit_price: exitPrice, pnl, result: "CHASE_EXIT" });
            await addXrpPnl(pnl);
            log.push({ action: "CHASE_EXIT", exit: exitPrice, pnl: pnl.toFixed(4) });

          } else {
            const livePrice = await getPriceGlobal(SYMBOL);
            const newPrice  = roundPrice(livePrice);

            if (newPrice !== pos.chase_price) {
              let cancelOk = true;
              try {
                await cancelOrderGlobal(SYMBOL, pos.sl_order_id);
              } catch {
                const check = await getOrderGlobal(SYMBOL, pos.sl_order_id);
                if (check.status === "FILLED") {
                  const exitPrice = parseFloat(check.cummulativeQuoteQty) / parseFloat(check.executedQty);
                  const pnl = (exitPrice - pos.entry_price) * pos.quantity;
                  await closeXrpPosition(pos.id, { exit_price: exitPrice, pnl, result: "CHASE_EXIT" });
                  await addXrpPnl(pnl);
                  log.push({ action: "CHASE_EXIT", exit: exitPrice, pnl: pnl.toFixed(4) });
                  cancelOk = false;
                }
              }
              if (cancelOk) {
                const newOrder = await placeLimitSellXrp(SYMBOL, pos.quantity, newPrice);
                await updateXrpChaseFloor(pos.id, newPrice, newOrder.orderId);
                log.push({ action: "EXIT_REPRICE", from: pos.chase_price, to: newPrice });
              }
            } else {
              log.push({ action: "EXIT_HOLD", price: livePrice });
            }
          }
        }

      } else {
        // ── No position: look for entry signal ──────────────────────────────────
        if (z <= -Z_THRESH) {
          const botBalance = settings.usdt_balance ?? ALLOCATION;
          const qty        = floorQty(Math.min(botBalance, fdusdFree) / price);
          if (qty >= 0.1 && qty * price >= 5) {
            const limitOrder = await placeLimitBuyXrp(SYMBOL, qty, roundPrice(price));
            await openXrpPendingEntry({ symbol: SYMBOL, entry_order_id: limitOrder.orderId, quantity: qty, z_score: z });
            log.push({ action: "LIMIT_BUY_PLACED", qty, price: roundPrice(price), orderId: limitOrder.orderId, z: z.toFixed(3) });
          }
        } else {
          log.push({ action: "WATCH", z: z.toFixed(3), price });
        }
      }

    } catch (err) {
      log.push({ action: "ERROR", stage: "trading", error: String(err) });
    }

    await logXrpRun({ actions: log });
    console.log("XRP live bot run:", JSON.stringify(log, null, 2));
    return { ok: true, actions: log };
  },
});
