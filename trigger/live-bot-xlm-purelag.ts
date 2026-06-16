// Pure Lag · BTC (using XLM infrastructure)
// Signal: BTC global UP >= 0.05% from last close AND BTC.US lagging → buy expecting snap-up
import { schedules } from "@trigger.dev/sdk/v3";
import {
  getPriceGlobal, getKlinesGlobal, getFreeBalance, getOrder, getPrice, getKlines,
  getBookTicker, cancelOrder, cancelAllOrders,
  placeLimitSellBtc, placeMarketBuyBtc, placeMarketSellBtc, placeOcoSellBtc,
} from "../lib/binance";
import { TP_PCT, SL_PCT, MAX_HOLD } from "../lib/strategy";
import {
  getXlmPosition as getPosition, openXlmPendingEntry as openPendingEntry, setXlmEntryFilled as setEntryFilled,
  incrementXlmHold as incrementHold, setXlmChasing as setChasing, updateXlmChaseFloor as updateChaseFloor,
  closeXlmPosition as closePosition, logXlmRun as logRun, getXlmSettings as getSettings,
  setXlmBaseline as setBaseline, updateXlmBalance as updateBalance, updateXlmTotal as updateTotal,
  setXlmPendingSell as setPendingSell, addXlmPnl as addPnl, logBtcPrice,
} from "../lib/xlm-live-db";

const SYMBOL       = "BTCUSDT";
const ALLOCATION   = 25;
const GL_THRESH    = 0.001;   // global must be up >= 0.10% from last close AND ahead of US
const SL_SLIP      = 0.0005;  // SL limit 0.05% below stop to ensure fill
const RESCUE_SLIP  = 0.0001;  // rescue limit 0.01% below live price
const CANCEL_DROP  = 0.0015;  // cancel pending limit buy if price drops 0.15% below order price

function roundPrice(p: number) { return Math.round(p * 100) / 100; }
function floorQty(q: number)   { return Math.floor(q * 100000) / 100000; }
function sleep(ms: number)     { return new Promise(r => setTimeout(r, ms)); }

export const xlmPureLagBot = schedules.task({
  id:          "live-bot-xlm-purelag-1m",
  cron:        "* * * * *",
  maxDuration: 55,

  run: async () => {
    const log: object[] = [];

    let settings;
    try {
      settings = await getSettings();
    } catch (err) {
      await logRun({ actions: [{ action: "ERROR", stage: "settings", error: String(err) }] });
      return { ok: false };
    }
    if (!settings?.enabled) return { ok: false, reason: "disabled" };

    let usdtFree = 0;
    try {
      usdtFree = await getFreeBalance("USDT");
      await updateTotal(usdtFree);
      if (!settings.usdt_balance || settings.usdt_balance === 0) {
        await updateBalance(ALLOCATION);
      }
    } catch (err) {
      log.push({ action: "ERROR", stage: "balance", error: String(err) });
      await logRun({ actions: log });
      return { ok: false };
    }

    // Sell All — triggered by dashboard button
    if (settings.pending_sell) {
      try {
        try { await cancelAllOrders(SYMBOL); } catch {}
        const btcFree  = await getFreeBalance("BTC");
        const btcPrice = await getPrice(SYMBOL);
        const qty      = floorQty(btcFree);
        if (qty >= 0.00001 && qty * btcPrice >= 10) {
          await placeMarketSellBtc(SYMBOL, qty);
          log.push({ action: "SELL_ALL", qty });
        } else {
          log.push({ action: "SELL_ALL_SKIP", btcFree, reason: "below MIN_NOTIONAL" });
        }
        const newUsdt = await getFreeBalance("USDT");
        await setBaseline(newUsdt - ALLOCATION);
        await updateBalance(ALLOCATION);
        await setPendingSell(false);
      } catch (err) {
        log.push({ action: "ERROR", stage: "sell_all", error: String(err) });
      }
      await logRun({ actions: log });
      return { ok: true, actions: log };
    }

    let hadPosition = false;
    try {
      const [liveGLPrice, price, book, glCandles, usCandles] = await Promise.all([
        getPriceGlobal(SYMBOL),
        getPrice(SYMBOL),
        getBookTicker(SYMBOL),
        getKlinesGlobal(SYMBOL, "1m", 2),
        getKlines(SYMBOL, "1m", 2),
      ]);

      const prevGL   = glCandles[0].close;  // last closed candle
      const prevUS   = usCandles[0].close;
      const spread   = (liveGLPrice - price) / price;
      const glRet    = (liveGLPrice - prevGL) / prevGL;  // global up from last close
      const usRet    = (price - prevUS) / prevUS;         // US movement from last close
      logBtcPrice(price, liveGLPrice, book).catch(() => {});   // fire-and-forget, never block the run
      const xlmGLRet = spread;
      const investment = Math.min(settings.usdt_balance ?? ALLOCATION, usdtFree);
      // entries only during US working hours 9am–4pm ET (13:00–20:00 UTC) — all 3 live days lost money outside this window
      const hourUTC  = new Date().getUTCHours();
      const inWindow = hourUTC >= 13 && hourUTC < 20;
      const signal   = spread >= GL_THRESH && glRet > 0 && usRet < glRet && inWindow;
      const pos        = await getPosition();
      if (pos) hadPosition = true;

      if (pos) {

        // ── Waiting for limit buy to fill ──────────────────────────────────────
        if (pos.status === "pending_entry") {
          let filled = false;
          for (let attempt = 0; attempt < 10 && !filled; attempt++) {
            if (attempt > 0) await sleep(5000);
            const order = await getOrder(SYMBOL, pos.entry_order_id);
            if (order.status === "FILLED") {
              const fillPrice = parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty);
              const filledQty = floorQty(parseFloat(order.executedQty));
              try { await cancelAllOrders(SYMBOL); } catch {}
              // Retry OCO up to 3 times — price may have moved making TP/SL invalid (-2010)
              let oco: Awaited<ReturnType<typeof placeOcoSellBtc>> | null = null;
              let ocoTp = roundPrice(fillPrice * (1 + TP_PCT));
              let ocoSl = roundPrice(fillPrice * (1 - SL_PCT));
              for (let ocoTry = 0; ocoTry < 3; ocoTry++) {
                try {
                  oco = await placeOcoSellBtc(SYMBOL, filledQty, ocoTp, ocoSl, roundPrice(ocoSl * (1 - SL_SLIP)));
                  break;
                } catch (ocoErr: any) {
                  if (ocoTry < 2 && String(ocoErr).includes("-2010")) {
                    // Price moved — recalculate TP/SL from current live price
                    await sleep(500);
                    const liveNow = await getPrice(SYMBOL);
                    ocoTp = roundPrice(liveNow * (1 + TP_PCT));
                    ocoSl = roundPrice(liveNow * (1 - SL_PCT));
                  } else throw ocoErr;
                }
              }
              const slReport = oco!.orderReports.find(r => r.type === "STOP_LOSS_LIMIT" || r.type === "STOP_LOSS");
              const tpReport = oco!.orderReports.find(r => r !== slReport);
              await setEntryFilled(pos.id, {
                entry_price: fillPrice,
                quantity:    filledQty,
                tp:          ocoTp,
                sl:          ocoSl,
                tp_order_id: tpReport!.orderId,
                sl_order_id: slReport!.orderId,
              });
              log.push({ action: "ENTRY_FILLED", entry: fillPrice, qty: filledQty, tp: ocoTp, sl: ocoSl });
              filled = true;
            } else if (order.status === "CANCELED" || order.status === "EXPIRED") {
              await closePosition(pos.id, { exit_price: 0, pnl: 0, result: "CANCELED" });
              log.push({ action: "ENTRY_CANCELED", orderId: pos.entry_order_id });
              filled = true;
            } else {
              const livePrice  = await getPrice(SYMBOL);
              const orderPrice = parseFloat(order.price);
              if (livePrice < orderPrice * (1 - CANCEL_DROP)) {
                // Price dropped 0.15% below order — signal reversed, cancel
                try { await cancelOrder(SYMBOL, pos.entry_order_id); } catch {}
                await closePosition(pos.id, { exit_price: 0, pnl: 0, result: "CANCELED_DROP" });
                log.push({ action: "CANCELED_DROP", livePrice, orderPrice });
                filled = true;
              } else if (livePrice > orderPrice) {
                const freshOrder = await getOrder(SYMBOL, pos.entry_order_id);
                if (freshOrder.status === "FILLED") {
                  const fillPrice = parseFloat(freshOrder.cummulativeQuoteQty) / parseFloat(freshOrder.executedQty);
                  const filledQty = floorQty(parseFloat(freshOrder.executedQty));
                  try { await cancelAllOrders(SYMBOL); } catch {}
                  let oco2: Awaited<ReturnType<typeof placeOcoSellBtc>> | null = null;
                  let ocoTp2 = roundPrice(fillPrice * (1 + TP_PCT));
                  let ocoSl2 = roundPrice(fillPrice * (1 - SL_PCT));
                  for (let ocoTry = 0; ocoTry < 3; ocoTry++) {
                    try {
                      oco2 = await placeOcoSellBtc(SYMBOL, filledQty, ocoTp2, ocoSl2, roundPrice(ocoSl2 * (1 - SL_SLIP)));
                      break;
                    } catch (ocoErr: any) {
                      if (ocoTry < 2 && String(ocoErr).includes("-2010")) {
                        await sleep(500);
                        const liveNow = await getPrice(SYMBOL);
                        ocoTp2 = roundPrice(liveNow * (1 + TP_PCT));
                        ocoSl2 = roundPrice(liveNow * (1 - SL_PCT));
                      } else throw ocoErr;
                    }
                  }
                  const slReport = oco2!.orderReports.find(r => r.type === "STOP_LOSS_LIMIT" || r.type === "STOP_LOSS");
                  const tpReport = oco2!.orderReports.find(r => r !== slReport);
                  await setEntryFilled(pos.id, {
                    entry_price: fillPrice,
                    quantity:    filledQty,
                    tp:          ocoTp2,
                    sl:          ocoSl2,
                    tp_order_id: tpReport!.orderId,
                    sl_order_id: slReport!.orderId,
                  });
                  log.push({ action: "ENTRY_FILLED", entry: fillPrice, qty: filledQty, tp: ocoTp2, sl: ocoSl2 });
                  filled = true;
                } else {
                  try { await cancelOrder(SYMBOL, pos.entry_order_id); } catch {}
                  await closePosition(pos.id, { exit_price: 0, pnl: 0, result: "MISSED" });
                  log.push({ action: "MISSED", livePrice, orderPrice });
                  filled = true;
                }
              }
            }
          }
          if (!filled) {
            if (pos.hold_count + 1 >= MAX_HOLD) {
              // Stuck too long — cancel and move on
              try { await cancelOrder(SYMBOL, pos.entry_order_id); } catch {}
              await closePosition(pos.id, { exit_price: 0, pnl: 0, result: "ENTRY_TIMEOUT" });
              log.push({ action: "ENTRY_TIMEOUT", holdCount: pos.hold_count + 1, orderId: pos.entry_order_id });
            } else {
              await incrementHold(pos.id, pos.hold_count);
              log.push({ action: "PENDING_FILL", orderId: pos.entry_order_id, hold: pos.hold_count + 1 });
            }
          }

        // ── Hold phase: check if TP or SL filled ──────────────────────────────
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
            await closePosition(pos.id, { exit_price: exitPrice, pnl, result: "TP" });
            await addPnl(pnl);
            await updateBalance((settings.usdt_balance ?? ALLOCATION) + pnl);
            log.push({ action: "TP", exit: exitPrice, pnl: pnl.toFixed(4) });

          } else if (slOrder.status === "FILLED") {
            try { await cancelOrder(SYMBOL, pos.tp_order_id); } catch {}
            const exitPrice = parseFloat(slOrder.cummulativeQuoteQty) / parseFloat(slOrder.executedQty);
            const pnl = (exitPrice - pos.entry_price) * pos.quantity;
            await closePosition(pos.id, { exit_price: exitPrice, pnl, result: "SL" });
            await addPnl(pnl);
            await updateBalance((settings.usdt_balance ?? ALLOCATION) + pnl);
            log.push({ action: "SL", exit: exitPrice, pnl: pnl.toFixed(4) });

          } else if (livePrice < pos.sl) {
            try { await cancelAllOrders(SYMBOL); } catch {}
            const rescuePrice = roundPrice(livePrice * (1 - RESCUE_SLIP));
            const rescueOrder = await placeLimitSellBtc(SYMBOL, pos.quantity, rescuePrice);
            await setChasing(pos.id, rescuePrice, rescueOrder.orderId);
            log.push({ action: "STUCK_RESCUE", livePrice, sl: pos.sl, rescuePrice });

          } else if (pos.hold_count + 1 >= MAX_HOLD) {
            try { await cancelOrder(SYMBOL, pos.tp_order_id); } catch {}
            try { await cancelOrder(SYMBOL, pos.sl_order_id); } catch {}
            const btcFree = await getFreeBalance("BTC");
            if (floorQty(btcFree) < 0.00001) {
              const slOrder   = await getOrder(SYMBOL, pos.sl_order_id);
              const exitPrice = parseFloat(slOrder.cummulativeQuoteQty) / parseFloat(slOrder.executedQty);
              const pnl       = (exitPrice - pos.entry_price) * pos.quantity;
              await closePosition(pos.id, { exit_price: exitPrice, pnl, result: "SL" });
              await addPnl(pnl);
              await updateBalance((settings.usdt_balance ?? ALLOCATION) + pnl);
              log.push({ action: "SL_RACE_RECOVERED", exit: exitPrice, pnl: pnl.toFixed(4) });
            } else {
              const exitPrice = roundPrice(await getPrice(SYMBOL));
              const exitOrder = await placeLimitSellBtc(SYMBOL, pos.quantity, exitPrice);
              await setChasing(pos.id, exitPrice, exitOrder.orderId);
              log.push({ action: "START_EXIT", exitPrice });
            }

          } else {
            await incrementHold(pos.id, pos.hold_count);
            log.push({ action: "HOLD", hold: pos.hold_count + 1, price, tp: pos.tp, sl: pos.sl });
          }

        // ── Exit phase: limit sell at current price, reprice each candle ─────────
        } else if (pos.status === "chasing") {
          const exitOrder = await getOrder(SYMBOL, pos.sl_order_id);

          if (exitOrder.status === "FILLED") {
            const exitPrice = parseFloat(exitOrder.cummulativeQuoteQty) / parseFloat(exitOrder.executedQty);
            const pnl = (exitPrice - pos.entry_price) * pos.quantity;
            await closePosition(pos.id, { exit_price: exitPrice, pnl, result: "CHASE_EXIT" });
            await addPnl(pnl);
            await updateBalance((settings.usdt_balance ?? ALLOCATION) + pnl);
            log.push({ action: "CHASE_EXIT", exit: exitPrice, pnl: pnl.toFixed(4) });

          } else {
            const livePrice = await getPrice(SYMBOL);
            const newPrice  = roundPrice(livePrice);

            if (newPrice !== pos.chase_price) {
              let cancelOk = true;
              try {
                await cancelOrder(SYMBOL, pos.sl_order_id);
              } catch {
                const check = await getOrder(SYMBOL, pos.sl_order_id);
                if (check.status === "FILLED") {
                  const exitPrice = parseFloat(check.cummulativeQuoteQty) / parseFloat(check.executedQty);
                  const pnl = (exitPrice - pos.entry_price) * pos.quantity;
                  await closePosition(pos.id, { exit_price: exitPrice, pnl, result: "CHASE_EXIT" });
                  await addPnl(pnl);
                  await updateBalance((settings.usdt_balance ?? ALLOCATION) + pnl);
                  log.push({ action: "CHASE_EXIT", exit: exitPrice, pnl: pnl.toFixed(4) });
                  cancelOk = false;
                }
              }
              if (cancelOk) {
                const newOrder = await placeLimitSellBtc(SYMBOL, pos.quantity, newPrice);
                await updateChaseFloor(pos.id, newPrice, newOrder.orderId);
                log.push({ action: "EXIT_REPRICE", from: pos.chase_price, to: newPrice });
              }
            } else {
              log.push({ action: "EXIT_HOLD", price: livePrice });
            }
          }
        }

      } else {
        // ── No position: look for entry signal ────────────────────────────────
        if (signal) {
          const btcHeld = await getFreeBalance("BTC");
          if (btcHeld >= 0.00001) {
            // Exchange says we hold BTC but DB has no record — skip, don't double-buy
            log.push({ action: "SKIP_HAVE_BTC", btcHeld });
          } else {
            const qty = floorQty(investment / book.ask);
            if (qty >= 0.00001 && qty * book.ask >= 10) {
              const mktOrder  = await placeMarketBuyBtc(SYMBOL, qty);
              const fillPrice = parseFloat(mktOrder.cummulativeQuoteQty) / parseFloat(mktOrder.executedQty);
              const filledQty = floorQty(parseFloat(mktOrder.executedQty));
              // Save to DB before OCO — if OCO fails, pending_entry handler retries next run
              await openPendingEntry({ symbol: SYMBOL, entry_order_id: mktOrder.orderId, quantity: filledQty, z_score: spread });
              const newPos = await getPosition();
              let oco: Awaited<ReturnType<typeof placeOcoSellBtc>> | null = null;
              let ocoTp = roundPrice(fillPrice * (1 + TP_PCT));
              let ocoSl = roundPrice(fillPrice * (1 - SL_PCT));
              for (let ocoTry = 0; ocoTry < 3; ocoTry++) {
                try {
                  oco = await placeOcoSellBtc(SYMBOL, filledQty, ocoTp, ocoSl, roundPrice(ocoSl * (1 - SL_SLIP)));
                  break;
                } catch (ocoErr: any) {
                  if (ocoTry < 2 && String(ocoErr).includes("-2010")) {
                    await sleep(500);
                    const liveNow = await getPrice(SYMBOL);
                    ocoTp = roundPrice(liveNow * (1 + TP_PCT));
                    ocoSl = roundPrice(liveNow * (1 - SL_PCT));
                  } else throw ocoErr;
                }
              }
              const slReport = oco!.orderReports.find(r => r.type === "STOP_LOSS_LIMIT" || r.type === "STOP_LOSS");
              const tpReport = oco!.orderReports.find(r => r !== slReport);
              await setEntryFilled(newPos!.id, {
                entry_price: fillPrice, quantity: filledQty,
                tp: ocoTp, sl: ocoSl,
                tp_order_id: tpReport!.orderId, sl_order_id: slReport!.orderId,
              });
              hadPosition = true;
              log.push({ action: "MARKET_BUY_FILLED", entry: roundPrice(fillPrice), qty: filledQty, tp: ocoTp, sl: ocoSl });
            }
          }
        } else {
          log.push({ action: "WATCH", xlmGLRet: xlmGLRet.toFixed(4), price });
        }
      }

    } catch (err) {
      log.push({ action: "ERROR", stage: "trading", error: String(err) });
    }

    // ── Log first check immediately so dashboard updates at 0s ────────────────
    await logRun({ actions: log });
    if (hadPosition) {
      console.log("XLM pure-lag bot run:", JSON.stringify(log, null, 2));
      return { ok: true, actions: log };
    }

    // ── Second signal check at 30s (only when no position is open) ────────────
    const log2: object[] = [];
    await sleep(30000);
    try {
      const pos2 = await getPosition();
      if (!pos2) {
        const [liveGLPrice2, price2, book2, glCandles2, usCandles2] = await Promise.all([
          getPriceGlobal(SYMBOL),
          getPrice(SYMBOL),
          getBookTicker(SYMBOL),
          getKlinesGlobal(SYMBOL, "1m", 2),
          getKlines(SYMBOL, "1m", 2),
        ]);
        const prevGL2  = glCandles2[0].close;
        const prevUS2  = usCandles2[0].close;
        const spread2  = (liveGLPrice2 - price2) / price2;
        const glRet2   = (liveGLPrice2 - prevGL2) / prevGL2;
        const usRet2   = (price2 - prevUS2) / prevUS2;
        logBtcPrice(price2, liveGLPrice2, book2).catch(() => {});  // fire-and-forget
        const xlmGLRet2 = spread2;
        const investment2 = Math.min(settings.usdt_balance ?? ALLOCATION, usdtFree);
        const hourUTC2  = new Date().getUTCHours();
        const inWindow2 = hourUTC2 >= 13 && hourUTC2 < 20;
        if (spread2 >= GL_THRESH && glRet2 > 0 && usRet2 < glRet2 && inWindow2) {
          const btcHeld2 = await getFreeBalance("BTC");
          if (btcHeld2 >= 0.00001) {
            log2.push({ action: "SKIP_HAVE_BTC_30S", btcHeld: btcHeld2 });
          } else {
            const qty = floorQty(investment2 / book2.ask);
            if (qty >= 0.00001 && qty * book2.ask >= 10) {
              const mktOrder2  = await placeMarketBuyBtc(SYMBOL, qty);
              const fillPrice2 = parseFloat(mktOrder2.cummulativeQuoteQty) / parseFloat(mktOrder2.executedQty);
              const filledQty2 = floorQty(parseFloat(mktOrder2.executedQty));
              await openPendingEntry({ symbol: SYMBOL, entry_order_id: mktOrder2.orderId, quantity: filledQty2, z_score: spread2 });
              const newPos2 = await getPosition();
              let oco2: Awaited<ReturnType<typeof placeOcoSellBtc>> | null = null;
              let ocoTp2 = roundPrice(fillPrice2 * (1 + TP_PCT));
              let ocoSl2 = roundPrice(fillPrice2 * (1 - SL_PCT));
              for (let ocoTry = 0; ocoTry < 3; ocoTry++) {
                try {
                  oco2 = await placeOcoSellBtc(SYMBOL, filledQty2, ocoTp2, ocoSl2, roundPrice(ocoSl2 * (1 - SL_SLIP)));
                  break;
                } catch (ocoErr: any) {
                  if (ocoTry < 2 && String(ocoErr).includes("-2010")) {
                    await sleep(500);
                    const liveNow2 = await getPrice(SYMBOL);
                    ocoTp2 = roundPrice(liveNow2 * (1 + TP_PCT));
                    ocoSl2 = roundPrice(liveNow2 * (1 - SL_PCT));
                  } else throw ocoErr;
                }
              }
              const slReport2 = oco2!.orderReports.find(r => r.type === "STOP_LOSS_LIMIT" || r.type === "STOP_LOSS");
              const tpReport2 = oco2!.orderReports.find(r => r !== slReport2);
              await setEntryFilled(newPos2!.id, {
                entry_price: fillPrice2, quantity: filledQty2,
                tp: ocoTp2, sl: ocoSl2,
                tp_order_id: tpReport2!.orderId, sl_order_id: slReport2!.orderId,
              });
              log2.push({ action: "MARKET_BUY_FILLED_30S", entry: roundPrice(fillPrice2), qty: filledQty2, tp: ocoTp2, sl: ocoSl2 });
            }
          }
        } else {
          log2.push({ action: "WATCH_30S", xlmGLRet: xlmGLRet2.toFixed(4), price: price2 });
        }
      }
    } catch (err) {
      log2.push({ action: "ERROR", stage: "trading_30s", error: String(err) });
    }

    await logRun({ actions: log2 });
    console.log("XLM pure-lag bot run 30s:", JSON.stringify(log2, null, 2));
    return { ok: true, actions: [...log, ...log2] };
  },
});
