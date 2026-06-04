import { schedules } from "@trigger.dev/sdk/v3";
import {
  getKlines, getPrice, placeLimitBuy, placeLimitSell, placeOCO,
  cancelOrder, cancelOCO, getOrder, getFreeBalance, placeMarketSell,
} from "../lib/binance";
import { calcZScore, Z_THRESH, TP_PCT, SL_PCT, MAX_HOLD } from "../lib/strategy";
import {
  getLivePosition, openLivePosition, setLivePositionOpen,
  incrementLiveHold, setLivePositionChasing, updateLiveChaseOrder,
  closeLivePosition, logLiveRun, getLiveSettings, updateLiveBalance,
  updateLiveEntryOrder,
} from "../lib/live-db";

const SYMBOL       = "ATOMUSDT";
const ALLOCATION   = 200;          // $200 live
const CHASE_OFFSET = 0.0005;       // 0.05% below price for limit sell
const CANDLES      = 50;

// ATOM/USDT precision on Binance.US
// Lot size step: 0.01  |  Price tick: 0.0001  |  Min notional: $10
function roundPrice(p: number) { return Math.round(p * 10000) / 10000; }
function floorQty(q: number)   { return Math.floor(q * 100) / 100; }

export const liveBot = schedules.task({
  id:          "live-bot-atom-1m",
  cron:        "* * * * *",
  maxDuration: 55,

  run: async () => {
    const log: object[] = [];

    // ── Setup: settings + balance ────────────────────────────────────────────
    let settings: { id: string; enabled: boolean; usdt_balance: number } | null = null;
    let usdtBalance = 0;

    try {
      settings = await getLiveSettings();
    } catch (err) {
      await logLiveRun({ actions: [{ action: "ERROR", stage: "getLiveSettings", error: String(err) }] });
      return { ok: false, error: String(err) };
    }

    try {
      usdtBalance = await getFreeBalance("USDT");
      await updateLiveBalance(usdtBalance);
    } catch (err) {
      log.push({ action: "ERROR", stage: "getFreeBalance", error: String(err) });
      await logLiveRun({ actions: log });
      return { ok: false, error: String(err) };
    }

    if (!settings?.enabled) {
      return { ok: false, reason: "disabled" };
    }

    // ── Trading logic ────────────────────────────────────────────────────────
    try {
      const [btcCandles, altCandles, price, btcPrice] = await Promise.all([
        getKlines("BTCUSDT", "1m", CANDLES).then(c => c.slice(0, -1)),
        getKlines(SYMBOL,    "1m", CANDLES).then(c => c.slice(0, -1)),
        getPrice(SYMBOL),
        getPrice("BTCUSDT"),
      ]);

      // Append live prices as the 50th candle for z-score calculation
      const btcWithLive = [...btcCandles, { close: btcPrice }];
      const altWithLive = [...altCandles, { close: price }];
      const z           = calcZScore(btcWithLive, altWithLive);

      const pos = await getLivePosition();

      // ── Manage open position ───────────────────────────────────────────────

      if (pos) {

        // 1. Waiting for entry limit buy to fill
        if (pos.status === "pending") {
          const order = await getOrder(SYMBOL, pos.entry_order_id);

          if (order.status === "FILLED") {
            const fillPrice = parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty);
            const qty       = parseFloat(order.executedQty);
            const tp        = roundPrice(fillPrice * (1 + TP_PCT));
            const sl        = roundPrice(fillPrice * (1 - SL_PCT));
            const slLimit   = roundPrice(sl - 0.0001);

            if (price >= tp) {
              // Price already past TP — skip OCO, go straight to chase
              const chasePrice = roundPrice(price * (1 - CHASE_OFFSET));
              const chaseOrder = await placeLimitSell(SYMBOL, qty, chasePrice);
              await setLivePositionOpen(pos.id, {
                entry_price: fillPrice, quantity: qty, tp, sl,
                tp_order_id: 0, sl_order_id: 0, oco_order_list_id: 0,
              });
              await setLivePositionChasing(pos.id, {
                chase_order_id: chaseOrder.orderId,
                chase_price:    chasePrice,
              });
              log.push({ action: "ENTRY_FILLED_SKIP_TO_CHASE", fillPrice, qty, price, chasePrice });

            } else if (price <= sl) {
              // Price already below SL — OCO would be rejected, market sell immediately
              const exitOrder = await placeMarketSell(SYMBOL, qty);
              const exitPrice = parseFloat(exitOrder.cummulativeQuoteQty) / parseFloat(exitOrder.executedQty);
              const pnl       = (exitPrice - fillPrice) * qty;
              await setLivePositionOpen(pos.id, {
                entry_price: fillPrice, quantity: qty, tp, sl,
                tp_order_id: 0, sl_order_id: 0, oco_order_list_id: 0,
              });
              await closeLivePosition(pos.id, { exit_price: exitPrice, pnl, result: "SL_IMMEDIATE" });
              log.push({ action: "SL_IMMEDIATE", fillPrice, exitPrice, pnl: pnl.toFixed(4) });

            } else {
              const oco       = await placeOCO(SYMBOL, qty, tp, sl, slLimit);
              const tpOrderId = oco.orderReports[0].orderId;
              const slOrderId = oco.orderReports[1].orderId;
              await setLivePositionOpen(pos.id, {
                entry_price: fillPrice, quantity: qty,
                tp, sl,
                tp_order_id: tpOrderId, sl_order_id: slOrderId,
                oco_order_list_id: oco.orderListId,
              });
              log.push({ action: "ENTRY_FILLED", price: fillPrice, qty, tp, sl });
            }

          } else {
            // Not filled yet — cancel and re-place if signal still valid
            try { await cancelOrder(SYMBOL, pos.entry_order_id); } catch {}
            if (z <= -Z_THRESH) {
              // Signal still active — re-place at current price
              const entryPrice = roundPrice(price);
              const newOrder   = await placeLimitBuy(SYMBOL, pos.quantity, entryPrice);
              await updateLiveEntryOrder(pos.id, newOrder.orderId, entryPrice);
              log.push({ action: "ENTRY_RECHASE", price: entryPrice, z: z.toFixed(3) });
            } else {
              // Signal gone — give up
              await closeLivePosition(pos.id, { exit_price: 0, pnl: 0, result: "MISSED" });
              log.push({ action: "ENTRY_MISSED", z: z.toFixed(3) });
            }
          }

        // 2. In position, OCO active
        } else if (pos.status === "open") {
          const [tpOrder, slOrder] = await Promise.all([
            getOrder(SYMBOL, pos.tp_order_id),
            getOrder(SYMBOL, pos.sl_order_id),
          ]);

          if (tpOrder.status === "FILLED") {
            const pnl = (pos.tp - pos.entry_price) * pos.quantity;
            await closeLivePosition(pos.id, { exit_price: pos.tp, pnl, result: "TP" });
            log.push({ action: "TP_FILLED", exit: pos.tp, pnl: pnl.toFixed(4) });

          } else if (slOrder.status === "FILLED") {
            const fillPrice = parseFloat(slOrder.cummulativeQuoteQty) / parseFloat(slOrder.executedQty);
            const pnl       = (fillPrice - pos.entry_price) * pos.quantity;
            await closeLivePosition(pos.id, { exit_price: fillPrice, pnl, result: "SL" });
            log.push({ action: "SL_FILLED", exit: fillPrice, pnl: pnl.toFixed(4) });

          } else if (pos.hold_count + 1 >= MAX_HOLD) {
            // Hold expired — cancel OCO, start chasing
            await cancelOCO(SYMBOL, pos.oco_order_list_id);
            const chasePrice  = roundPrice(price * (1 - CHASE_OFFSET));
            const chaseOrder  = await placeLimitSell(SYMBOL, pos.quantity, chasePrice);
            await setLivePositionChasing(pos.id, {
              chase_order_id: chaseOrder.orderId,
              chase_price:    chasePrice,
            });
            log.push({ action: "START_CHASE", price, chasePrice });

          } else {
            await incrementLiveHold(pos.id, pos.hold_count);
            log.push({ action: "HOLD", hold: pos.hold_count + 1, price });
          }

        // 3. Chasing — trailing limit sell
        } else if (pos.status === "chasing") {
          const order = await getOrder(SYMBOL, pos.chase_order_id);

          if (order.status === "FILLED") {
            const pnl = (pos.chase_price - pos.entry_price) * pos.quantity;
            await closeLivePosition(pos.id, {
              exit_price: pos.chase_price, pnl, result: "CHASE_FILL",
            });
            log.push({ action: "CHASE_FILLED", exit: pos.chase_price, pnl: pnl.toFixed(4) });

          } else {
            // Always re-place — trails price up AND down, order always near market
            try { await cancelOrder(SYMBOL, pos.chase_order_id); } catch {}
            const newChasePrice = roundPrice(price * (1 - CHASE_OFFSET));
            const newOrder      = await placeLimitSell(SYMBOL, pos.quantity, newChasePrice);
            await updateLiveChaseOrder(pos.id, {
              chase_order_id: newOrder.orderId,
              chase_price:    newChasePrice,
            });
            log.push({ action: "CHASE_UPDATE", price, newChasePrice });
          }
        }

      // ── No open position — check for signal ─────────────────────────────────
      } else {
        if (z <= -Z_THRESH) {
          if (usdtBalance < ALLOCATION) {
            log.push({ action: "SKIP_NO_FUNDS", balance: usdtBalance, needed: ALLOCATION });
          } else {
            const qty = floorQty(ALLOCATION / price);
            if (qty * price >= 10) {   // min notional check
              const entryPrice = roundPrice(price);
              const order      = await placeLimitBuy(SYMBOL, qty, entryPrice);
              await openLivePosition({
                symbol:         SYMBOL,
                entry_price:    entryPrice,
                sl:             roundPrice(entryPrice * (1 - SL_PCT)),
                tp:             roundPrice(entryPrice * (1 + TP_PCT)),
                quantity:       qty,
                z_score:        z,
                entry_order_id: order.orderId,
              });
              log.push({ action: "OPEN", entry: entryPrice, qty, z: z.toFixed(3), balance: usdtBalance });
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
