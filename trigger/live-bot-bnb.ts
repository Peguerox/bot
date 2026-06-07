// Pure Lag · BNB
// Signal: BTC 1m candle up >= 0.3% AND BNB up < 0.1% → buy BNB expecting snap-up
import { schedules } from "@trigger.dev/sdk/v3";
import {
  getKlines, getFreeBalance, getOrder, getPrice, cancelOrder, cancelAllOrders,
  placeLimitBuyBnb, placeLimitSellBnb, placeMarketSellBnb,
  placeStopLimitSellBnb, placeOcoSellBnb,
} from "../lib/binance";
import { TP_PCT, SL_PCT, MAX_HOLD } from "../lib/strategy";
import {
  getBnbPosition, openBnbPendingEntry, setBnbEntryFilled,
  incrementBnbHold, setBnbChasing, updateBnbChaseFloor, closeBnbPosition,
  logBnbRun, getBnbSettings, setBnbBaseline, updateBnbBalance, setBnbPendingSell,
} from "../lib/bnb-live-db";

const SYMBOL       = "BNBUSDT";
const ALLOCATION   = 25;
const CHASE_OFFSET = 0.001;   // 0.1% trailing offset
const BTC_THRESH   = 0.003;   // BTC must pump >= 0.3%
const COIN_MAX     = 0.001;   // BNB must have moved < 0.1%
const SL_SLIP      = 0.002;   // SL limit 0.2% below stop to ensure fill
const RESCUE_SLIP  = 0.0001;  // rescue limit 0.01% below live price

function roundPrice(p: number) { return Math.round(p * 100) / 100; }
function floorQty(q: number)   { return Math.floor(q * 1000) / 1000; }
function sleep(ms: number)     { return new Promise(r => setTimeout(r, ms)); }

export const bnbLiveBot = schedules.task({
  id:          "live-bot-bnb-1m",
  cron:        "* * * * *",
  maxDuration: 55,

  run: async () => {
    const log: object[] = [];

    let settings;
    try {
      settings = await getBnbSettings();
    } catch (err) {
      await logBnbRun({ actions: [{ action: "ERROR", stage: "settings", error: String(err) }] });
      return { ok: false };
    }
    if (!settings?.enabled) return { ok: false, reason: "disabled" };

    let usdtFree = 0;
    try {
      usdtFree = await getFreeBalance("USDT");
      let baseline = settings.baseline_usdt ?? 0;
      if (baseline === 0) {
        baseline = usdtFree - ALLOCATION;
        await setBnbBaseline(baseline);
      }
      await updateBnbBalance(Math.max(0, usdtFree - baseline));
    } catch (err) {
      log.push({ action: "ERROR", stage: "balance", error: String(err) });
      await logBnbRun({ actions: log });
      return { ok: false };
    }

    // Sell All — triggered by dashboard button
    if (settings.pending_sell) {
      try {
        try { await cancelAllOrders(SYMBOL); } catch {}
        const bnbFree  = await getFreeBalance("BNB");
        const bnbPrice = await getPrice(SYMBOL);
        const qty      = floorQty(bnbFree);
        if (qty >= 0.001 && qty * bnbPrice >= 1.1) {
          await placeMarketSellBnb(SYMBOL, qty);
          log.push({ action: "SELL_ALL", qty });
        } else {
          log.push({ action: "SELL_ALL_SKIP", bnbFree, reason: "below MIN_NOTIONAL" });
        }
        const newUsdt = await getFreeBalance("USDT");
        await setBnbBaseline(newUsdt - ALLOCATION);
        await updateBnbBalance(ALLOCATION);
        await setBnbPendingSell(false);
      } catch (err) {
        log.push({ action: "ERROR", stage: "sell_all", error: String(err) });
      }
      await logBnbRun({ actions: log });
      return { ok: true, actions: log };
    }

    try {
      const [btcCandles, bnbCandles] = await Promise.all([
        getKlines("BTCUSDT", "1m", 3).then(c => c.slice(0, -1)),
        getKlines(SYMBOL,    "1m", 3).then(c => c.slice(0, -1)),
      ]);

      const price   = bnbCandles[bnbCandles.length - 1].close;
      const btcRet  = (btcCandles[1].close - btcCandles[0].close) / btcCandles[0].close;
      const bnbRet  = (bnbCandles[1].close - bnbCandles[0].close) / bnbCandles[0].close;
      const signal  = btcRet >= BTC_THRESH && bnbRet < COIN_MAX;
      const pos     = await getBnbPosition();

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
              const slLimit      = roundPrice(sl * (1 - SL_SLIP));
              try { await cancelAllOrders(SYMBOL); } catch {}
              const oco      = await placeOcoSellBnb(SYMBOL, filledQty, tp, sl, slLimit);
              const slReport = oco.orderReports.find(r => r.type === "STOP_LOSS_LIMIT" || r.type === "STOP_LOSS");
              const tpReport = oco.orderReports.find(r => r !== slReport);
              await setBnbEntryFilled(pos.id, {
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
              await closeBnbPosition(pos.id, { exit_price: 0, pnl: 0, result: "CANCELED" });
              log.push({ action: "ENTRY_CANCELED", orderId: pos.entry_order_id });
              filled = true;
            }
          }
          if (!filled) log.push({ action: "PENDING_FILL", orderId: pos.entry_order_id });

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
            await closeBnbPosition(pos.id, { exit_price: exitPrice, pnl, result: "TP" });
            log.push({ action: "TP", exit: exitPrice, pnl: pnl.toFixed(4) });

          } else if (slOrder.status === "FILLED") {
            try { await cancelOrder(SYMBOL, pos.tp_order_id); } catch {}
            const exitPrice = parseFloat(slOrder.cummulativeQuoteQty) / parseFloat(slOrder.executedQty);
            const pnl = (exitPrice - pos.entry_price) * pos.quantity;
            await closeBnbPosition(pos.id, { exit_price: exitPrice, pnl, result: "SL" });
            log.push({ action: "SL", exit: exitPrice, pnl: pnl.toFixed(4) });

          } else if (livePrice < pos.sl) {
            try { await cancelAllOrders(SYMBOL); } catch {}
            const rescuePrice = roundPrice(livePrice * (1 - RESCUE_SLIP));
            const rescueOrder = await placeLimitSellBnb(SYMBOL, pos.quantity, rescuePrice);
            await setBnbChasing(pos.id, rescuePrice, rescueOrder.orderId);
            log.push({ action: "STUCK_RESCUE", livePrice, sl: pos.sl, rescuePrice });

          } else if (pos.hold_count + 1 >= MAX_HOLD) {
            try { await cancelOrder(SYMBOL, pos.tp_order_id); } catch {}
            try { await cancelOrder(SYMBOL, pos.sl_order_id); } catch {}
            const chasePrice  = await getPrice(SYMBOL);
            const chaseFloor  = roundPrice(chasePrice * (1 - CHASE_OFFSET));
            const chaseSlOrder = await placeStopLimitSellBnb(
              SYMBOL, pos.quantity, chaseFloor, roundPrice(chaseFloor * (1 - SL_SLIP))
            );
            await setBnbChasing(pos.id, chaseFloor, chaseSlOrder.orderId);
            log.push({ action: "START_CHASE", livePrice: chasePrice, chaseFloor });

          } else {
            await incrementBnbHold(pos.id, pos.hold_count);
            log.push({ action: "HOLD", hold: pos.hold_count + 1, price, tp: pos.tp, sl: pos.sl });
          }

        // ── Chase phase: trailing stop-loss-limit ──────────────────────────────
        } else if (pos.status === "chasing") {
          const slOrder = await getOrder(SYMBOL, pos.sl_order_id);

          if (slOrder.status === "FILLED") {
            const exitPrice = parseFloat(slOrder.cummulativeQuoteQty) / parseFloat(slOrder.executedQty);
            const pnl = (exitPrice - pos.entry_price) * pos.quantity;
            await closeBnbPosition(pos.id, { exit_price: exitPrice, pnl, result: "CHASE_EXIT" });
            log.push({ action: "CHASE_EXIT", exit: exitPrice, pnl: pnl.toFixed(4) });

          } else {
            const livePrice = await getPrice(SYMBOL);

            if (livePrice < pos.chase_price) {
              try { await cancelAllOrders(SYMBOL); } catch {}
              const rescuePrice = roundPrice(livePrice * (1 - RESCUE_SLIP));
              const rescueOrder = await placeLimitSellBnb(SYMBOL, pos.quantity, rescuePrice);
              await updateBnbChaseFloor(pos.id, rescuePrice, rescueOrder.orderId);
              log.push({ action: "STUCK_RESCUE_CHASE", livePrice, chaseFloor: pos.chase_price, rescuePrice });

            } else {
              const newFloor = roundPrice(livePrice * (1 - CHASE_OFFSET));
              if (newFloor > pos.chase_price) {
                let cancelOk = true;
                try {
                  await cancelOrder(SYMBOL, pos.sl_order_id);
                } catch {
                  const slCheck = await getOrder(SYMBOL, pos.sl_order_id);
                  if (slCheck.status === "FILLED") {
                    const exitPrice = parseFloat(slCheck.cummulativeQuoteQty) / parseFloat(slCheck.executedQty);
                    const pnl = (exitPrice - pos.entry_price) * pos.quantity;
                    await closeBnbPosition(pos.id, { exit_price: exitPrice, pnl, result: "CHASE_EXIT" });
                    log.push({ action: "CHASE_EXIT", exit: exitPrice, pnl: pnl.toFixed(4) });
                    cancelOk = false;
                  }
                }
                if (cancelOk) {
                  const newSlOrder = await placeStopLimitSellBnb(
                    SYMBOL, pos.quantity, newFloor, roundPrice(newFloor * (1 - SL_SLIP))
                  );
                  await updateBnbChaseFloor(pos.id, newFloor, newSlOrder.orderId);
                  log.push({ action: "CHASE_UP", livePrice, newFloor });
                }
              } else {
                log.push({ action: "CHASE_HOLD", livePrice, chaseFloor: pos.chase_price });
              }
            }
          }
        }

      } else {
        // ── No position: look for entry signal ────────────────────────────────
        if (signal) {
          const availableCapital = Math.max(0, usdtFree - (settings.baseline_usdt ?? 0));
          const qty              = floorQty(availableCapital / price);
          if (qty >= 0.001 && qty * price >= 1.1) {
            const limitOrder = await placeLimitBuyBnb(SYMBOL, qty, roundPrice(price));
            await openBnbPendingEntry({ symbol: SYMBOL, entry_order_id: limitOrder.orderId, quantity: qty });
            log.push({ action: "LIMIT_BUY_PLACED", qty, price: roundPrice(price), orderId: limitOrder.orderId, btcRet: btcRet.toFixed(4), bnbRet: bnbRet.toFixed(4) });
          }
        } else {
          log.push({ action: "WATCH", btcRet: btcRet.toFixed(4), bnbRet: bnbRet.toFixed(4), price });
        }
      }

    } catch (err) {
      log.push({ action: "ERROR", stage: "trading", error: String(err) });
    }

    await logBnbRun({ actions: log });
    console.log("BNB pure-lag bot run:", JSON.stringify(log, null, 2));
    return { ok: true, actions: log };
  },
});
