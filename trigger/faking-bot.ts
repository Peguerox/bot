import { schedules } from "@trigger.dev/sdk/v3";
import {
  getKlines, placeLimitSell,
  cancelOrder, getOrder, getFreeBalance, placeMarketBuy, placeMarketSell,
} from "../lib/binance";
import { calcZScore, Z_THRESH, TP_PCT, SL_PCT, MAX_HOLD } from "../lib/strategy";
import {
  getFakingPosition, openFakingPosition,
  incrementFakingHold, setFakingPositionChasing, updateFakingChaseOrder,
  closeFakingPosition, logFakingRun, getFakingSettings, updateFakingBalance,
} from "../lib/faking-db";

const SYMBOL       = "ATOMUSDT";
const ALLOCATION   = 200;
const CHASE_OFFSET = 0.0005;  // 0.05% below price for limit sell
const CANDLES      = 50;

function roundPrice(p: number) { return Math.round(p * 1000) / 1000; }
function floorQty(q: number)   { return Math.floor(q * 100) / 100; }

export const fakingBot = schedules.task({
  id:          "faking-bot-atom-1m",
  cron:        "* * * * *",
  maxDuration: 55,

  run: async () => {
    const log: object[] = [];

    // ── Settings + balance ───────────────────────────────────────────────────
    let settings: { id: string; enabled: boolean; usdt_balance: number } | null = null;

    try {
      settings = await getFakingSettings();
    } catch (err) {
      await logFakingRun([{ action: "ERROR", stage: "getSettings", error: String(err) }]);
      return { ok: false, error: String(err) };
    }

    try {
      const balance = await getFreeBalance("USDT");
      await updateFakingBalance(balance);
    } catch (err) {
      log.push({ action: "ERROR", stage: "getFreeBalance", error: String(err) });
      await logFakingRun(log);
      return { ok: false, error: String(err) };
    }

    if (!settings?.enabled) {
      return { ok: false, reason: "disabled" };
    }

    // ── Trading logic ────────────────────────────────────────────────────────
    try {
      // Use last CLOSED candle — same as paper bot, guarantees same signal timing
      const [btcCandles, altCandles] = await Promise.all([
        getKlines("BTCUSDT", "1m", CANDLES).then(c => c.slice(0, -1)),
        getKlines(SYMBOL,    "1m", CANDLES).then(c => c.slice(0, -1)),
      ]);

      const currentPrice = altCandles[altCandles.length - 1].close;
      const z            = calcZScore(btcCandles, altCandles);
      const pos          = await getFakingPosition();

      // ── Manage open position ─────────────────────────────────────────────
      if (pos) {

        if (pos.status === "open") {
          const tpOrder = await getOrder(SYMBOL, pos.tp_order_id);

          if (tpOrder.status === "FILLED") {
            // TP limit sell filled on Binance — ATOM sold
            const pnl = (pos.tp - pos.entry_price) * pos.quantity;
            await closeFakingPosition(pos.id, { exit_price: pos.tp, pnl, result: "TP" });
            log.push({ action: "TP_FILLED", exit: pos.tp, pnl: pnl.toFixed(4) });

          } else if (currentPrice <= pos.sl) {
            // Price hit SL — cancel TP order, market sell immediately
            try { await cancelOrder(SYMBOL, pos.tp_order_id); } catch {}
            const exitOrder = await placeMarketSell(SYMBOL, pos.quantity);
            const exitPrice = parseFloat(exitOrder.cummulativeQuoteQty) / parseFloat(exitOrder.executedQty);
            const pnl       = (exitPrice - pos.entry_price) * pos.quantity;
            await closeFakingPosition(pos.id, { exit_price: exitPrice, pnl, result: "SL" });
            log.push({ action: "SL_HIT", exitPrice, pnl: pnl.toFixed(4) });

          } else if (pos.hold_count + 1 >= MAX_HOLD) {
            // Hold expired — cancel TP, start chasing with limit sell below market
            try { await cancelOrder(SYMBOL, pos.tp_order_id); } catch {}
            const chasePrice = roundPrice(currentPrice * (1 - CHASE_OFFSET));
            const chaseOrder = await placeLimitSell(SYMBOL, pos.quantity, chasePrice);
            await setFakingPositionChasing(pos.id, {
              chase_order_id: chaseOrder.orderId,
              chase_price:    chasePrice,
            });
            log.push({ action: "START_CHASE", currentPrice, chasePrice });

          } else {
            await incrementFakingHold(pos.id, pos.hold_count);
            log.push({ action: "HOLD", hold: pos.hold_count + 1, currentPrice });
          }

        } else if (pos.status === "chasing") {
          const order = await getOrder(SYMBOL, pos.chase_order_id);

          if (order.status === "FILLED") {
            // Chase limit sell filled — ATOM sold
            const fillPrice = parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty);
            const pnl       = (fillPrice - pos.entry_price) * pos.quantity;
            await closeFakingPosition(pos.id, { exit_price: fillPrice, pnl, result: "CHASE_FILL" });
            log.push({ action: "CHASE_FILLED", exit: fillPrice, pnl: pnl.toFixed(4) });

          } else {
            // Only raise the chase if price moved up — never lower it
            const newChasePrice = roundPrice(currentPrice * (1 - CHASE_OFFSET));
            if (newChasePrice > pos.chase_price) {
              try { await cancelOrder(SYMBOL, pos.chase_order_id); } catch {}
              const newOrder = await placeLimitSell(SYMBOL, pos.quantity, newChasePrice);
              await updateFakingChaseOrder(pos.id, {
                chase_order_id: newOrder.orderId,
                chase_price:    newChasePrice,
              });
              log.push({ action: "CHASE_UP", currentPrice, newChasePrice });
            } else {
              log.push({ action: "CHASE_HOLD", currentPrice, chasePrice: pos.chase_price });
            }
          }
        }

      // ── No position — check for signal ──────────────────────────────────
      } else {
        if (z <= -Z_THRESH) {
          const usdtBalance = settings?.usdt_balance ?? 0;
          if (usdtBalance < ALLOCATION) {
            log.push({ action: "SKIP_NO_FUNDS", balance: usdtBalance, needed: ALLOCATION });
          } else {
            const estQty = floorQty(ALLOCATION / currentPrice);
            if (estQty * currentPrice >= 10) {
              const buyOrder  = await placeMarketBuy(SYMBOL, estQty);
              const fillPrice = parseFloat(buyOrder.cummulativeQuoteQty) / parseFloat(buyOrder.executedQty);
              const filledQty = parseFloat(buyOrder.executedQty);
              const tp        = roundPrice(fillPrice * (1 + TP_PCT));
              const sl        = roundPrice(fillPrice * (1 - SL_PCT));

              // Place TP limit sell — only real order we keep open
              // Safety net: if this fails, immediately market sell to avoid stranded ATOM
              let tpOrder;
              try {
                tpOrder = await placeLimitSell(SYMBOL, filledQty, tp);
              } catch (err) {
                try { await placeMarketSell(SYMBOL, filledQty); } catch {}
                log.push({ action: "ENTRY_ROLLBACK", error: String(err) });
                throw err;
              }

              await openFakingPosition({
                symbol:      SYMBOL,
                entry_price: fillPrice,
                sl, tp,
                quantity:    filledQty,
                z_score:     z,
                tp_order_id: tpOrder.orderId,
              });
              log.push({ action: "OPEN", entry: fillPrice, qty: filledQty, tp, sl, z: z.toFixed(3) });
            }
          }
        } else {
          log.push({ action: "WATCH", z: z.toFixed(3), price: currentPrice });
        }
      }

    } catch (err) {
      log.push({ action: "ERROR", stage: "trading", error: String(err) });
    }

    await logFakingRun(log);
    console.log("Faking bot run:", JSON.stringify(log, null, 2));
    return { ok: true, actions: log };
  },
});
