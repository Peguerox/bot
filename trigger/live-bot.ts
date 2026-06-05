import { schedules } from "@trigger.dev/sdk/v3";
import {
  getKlines, getPrice, placeLimitSell, placeStopLimitSell,
  cancelOrder, getOrder, getFreeBalance, placeMarketBuy, placeMarketSell,
} from "../lib/binance";
import { calcZScore, Z_THRESH, TP_PCT, SL_PCT, MAX_HOLD } from "../lib/strategy";
import {
  getLivePosition, openLivePositionFilled,
  incrementLiveHold, setLivePositionChasing, updateLiveChaseOrder,
  closeLivePosition, logLiveRun, getLiveSettings, updateLiveBalance,
} from "../lib/live-db";

const SYMBOL       = "ATOMUSDT";
const ALLOCATION   = 200;          // $200 live
const CHASE_OFFSET = 0.0005;       // 0.05% below price for limit sell
const CANDLES      = 50;

// ATOM/USDT precision on Binance.US
// Lot size step: 0.01  |  Price tick: 0.001  |  Min notional: $1
function roundPrice(p: number) { return Math.round(p * 1000) / 1000; }
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
      const [btcCandles, altCandles, price] = await Promise.all([
        getKlines("BTCUSDT", "1m", CANDLES).then(c => c.slice(0, -1)),
        getKlines(SYMBOL,    "1m", CANDLES).then(c => c.slice(0, -1)),
        getPrice(SYMBOL),
      ]);

      const z = calcZScore(btcCandles, altCandles);

      const pos = await getLivePosition();

      // ── Manage open position ───────────────────────────────────────────────

      if (pos) {

        // 1. In position — TP and SL as separate limit orders
        if (pos.status === "open") {
          const [tpOrder, slOrder] = await Promise.all([
            getOrder(SYMBOL, pos.tp_order_id),
            getOrder(SYMBOL, pos.sl_order_id),
          ]);

          if (tpOrder.status === "FILLED") {
            try { await cancelOrder(SYMBOL, pos.sl_order_id); } catch {}
            const pnl = (pos.tp - pos.entry_price) * pos.quantity;
            await closeLivePosition(pos.id, { exit_price: pos.tp, pnl, result: "TP" });
            log.push({ action: "TP_FILLED", exit: pos.tp, pnl: pnl.toFixed(4) });

          } else if (slOrder.status === "FILLED") {
            try { await cancelOrder(SYMBOL, pos.tp_order_id); } catch {}
            const fillPrice = parseFloat(slOrder.cummulativeQuoteQty) / parseFloat(slOrder.executedQty);
            const pnl       = (fillPrice - pos.entry_price) * pos.quantity;
            await closeLivePosition(pos.id, { exit_price: fillPrice, pnl, result: "SL" });
            log.push({ action: "SL_FILLED", exit: fillPrice, pnl: pnl.toFixed(4) });

          } else if (price < pos.sl) {
            // Price below SL but stop-limit not triggered (gap down) — cancel both, market sell
            try { await cancelOrder(SYMBOL, pos.tp_order_id); } catch {}
            try { await cancelOrder(SYMBOL, pos.sl_order_id); } catch {}
            const exitOrder = await placeMarketSell(SYMBOL, pos.quantity);
            const exitPrice = parseFloat(exitOrder.cummulativeQuoteQty) / parseFloat(exitOrder.executedQty);
            const pnl       = (exitPrice - pos.entry_price) * pos.quantity;
            await closeLivePosition(pos.id, { exit_price: exitPrice, pnl, result: "SL_STUCK" });
            log.push({ action: "SL_STUCK", exitPrice, pnl: pnl.toFixed(4) });

          } else if (pos.hold_count + 1 >= MAX_HOLD) {
            // Hold expired — cancel both, start chasing
            try { await cancelOrder(SYMBOL, pos.tp_order_id); } catch {}
            try { await cancelOrder(SYMBOL, pos.sl_order_id); } catch {}
            const chasePrice = roundPrice(price * (1 - CHASE_OFFSET));
            const chaseOrder = await placeLimitSell(SYMBOL, pos.quantity, chasePrice);
            await setLivePositionChasing(pos.id, {
              chase_order_id: chaseOrder.orderId,
              chase_price:    chasePrice,
            });
            log.push({ action: "START_CHASE", price, chasePrice });

          } else {
            await incrementLiveHold(pos.id, pos.hold_count);
            log.push({ action: "HOLD", hold: pos.hold_count + 1, price });
          }

        // 2. Chasing — trailing limit sell
        } else if (pos.status === "chasing") {
          const order = await getOrder(SYMBOL, pos.chase_order_id);

          if (order.status === "FILLED") {
            const pnl = (pos.chase_price - pos.entry_price) * pos.quantity;
            await closeLivePosition(pos.id, {
              exit_price: pos.chase_price, pnl, result: "CHASE_FILL",
            });
            log.push({ action: "CHASE_FILLED", exit: pos.chase_price, pnl: pnl.toFixed(4) });

          } else {
            const newChasePrice = roundPrice(price * (1 - CHASE_OFFSET));
            if (newChasePrice > pos.chase_price) {
              // Price moved up — raise the chase order
              try { await cancelOrder(SYMBOL, pos.chase_order_id); } catch {}
              const newOrder = await placeLimitSell(SYMBOL, pos.quantity, newChasePrice);
              await updateLiveChaseOrder(pos.id, {
                chase_order_id: newOrder.orderId,
                chase_price:    newChasePrice,
              });
              log.push({ action: "CHASE_UP", price, newChasePrice });
            } else {
              // Price flat or down — keep existing order, don't lower the chase
              log.push({ action: "CHASE_HOLD", price, chasePrice: pos.chase_price });
            }
          }
        }

      // ── No open position — check for signal ─────────────────────────────────
      } else {
        if (z <= -Z_THRESH) {
          if (usdtBalance < ALLOCATION) {
            log.push({ action: "SKIP_NO_FUNDS", balance: usdtBalance, needed: ALLOCATION });
          } else {
            const estQty = floorQty(ALLOCATION / price);
            if (estQty * price >= 10) {
              // Market buy — fills immediately, no missed entries
              const buyOrder  = await placeMarketBuy(SYMBOL, estQty);
              const fillPrice = parseFloat(buyOrder.cummulativeQuoteQty) / parseFloat(buyOrder.executedQty);
              const filledQty = floorQty(parseFloat(buyOrder.executedQty));
              const tp        = roundPrice(fillPrice * (1 + TP_PCT));
              const sl        = roundPrice(fillPrice * (1 - SL_PCT));
              const slLimit   = roundPrice(sl - 0.001);

              // Place TP and SL as separate limit orders
              const tpOrder = await placeLimitSell(SYMBOL, filledQty, tp);
              const slOrder = await placeStopLimitSell(SYMBOL, filledQty, sl, slLimit);

              await openLivePositionFilled({
                symbol:      SYMBOL,
                entry_price: fillPrice,
                sl, tp,
                quantity:    filledQty,
                z_score:     z,
                tp_order_id: tpOrder.orderId,
                sl_order_id: slOrder.orderId,
              });
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
