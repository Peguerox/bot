import { schedules } from "@trigger.dev/sdk/v3";
import {
  getKlines, placeLimitSell, placeStopMarket,
  cancelOrder, getOrder, getFreeBalance, placeMarketBuy, placeMarketSell,
} from "../lib/binance";
import { calcZScore, Z_THRESH, TP_PCT, SL_PCT, MAX_HOLD } from "../lib/strategy";
import {
  getFakingPosition, openFakingPosition, incrementFakingHold,
  updateFakingChase, closeFakingPosition, logFakingRun,
  getFakingSettings, updateFakingBalance,
} from "../lib/faking-db";

const SYMBOL       = "ATOMUSDT";
const ALLOCATION   = 200;
const CHASE_OFFSET = 0.0005;  // 0.05% below price when raising TP
const CANDLES      = 50;
const MIN_ATOM     = 1.0;     // real ATOM balance threshold to consider "in position"

function roundPrice(p: number) { return Math.round(p * 1000) / 1000; }
function floorQty(q: number)   { return Math.floor(q * 100) / 100; }

export const fakingBot = schedules.task({
  id:          "faking-bot-atom-1m",
  cron:        "* * * * *",
  maxDuration: 55,

  run: async () => {
    const log: object[] = [];

    // ── Settings ─────────────────────────────────────────────────────────────
    let settings: { id: string; enabled: boolean; usdt_balance: number } | null = null;
    try {
      settings = await getFakingSettings();
    } catch (err) {
      await logFakingRun([{ action: "ERROR", stage: "getSettings", error: String(err) }]);
      return { ok: false, error: String(err) };
    }

    if (!settings?.enabled) {
      return { ok: false, reason: "disabled" };
    }

    // ── Real balances from Binance (source of truth) ──────────────────────────
    let usdtFree = 0, atomFree = 0;
    try {
      [usdtFree, atomFree] = await Promise.all([
        getFreeBalance("USDT"),
        getFreeBalance("ATOM"),
      ]);
      await updateFakingBalance(usdtFree);
    } catch (err) {
      log.push({ action: "ERROR", stage: "getBalances", error: String(err) });
      await logFakingRun(log);
      return { ok: false, error: String(err) };
    }

    // ── Signal ────────────────────────────────────────────────────────────────
    try {
      const [btcCandles, altCandles] = await Promise.all([
        getKlines("BTCUSDT", "1m", CANDLES).then(c => c.slice(0, -1)),
        getKlines(SYMBOL,    "1m", CANDLES).then(c => c.slice(0, -1)),
      ]);
      const currentPrice = altCandles[altCandles.length - 1].close;
      const z            = calcZScore(btcCandles, altCandles);
      const pos          = await getFakingPosition();

      // ── Manage open position ───────────────────────────────────────────────
      if (pos) {
        // Legacy position (no sl_order_id): close it on next TP or SL hit via price check
        if (!pos.sl_order_id) {
          const tpOrder = await getOrder(SYMBOL, pos.tp_order_id);
          if (tpOrder.status === "FILLED") {
            const exitPrice = parseFloat(tpOrder.cummulativeQuoteQty) / parseFloat(tpOrder.executedQty);
            const pnl       = (exitPrice - pos.entry_price) * pos.quantity;
            await closeFakingPosition(pos.id, { exit_price: exitPrice, pnl, result: "TP" });
            log.push({ action: "TP_FILLED", exit: exitPrice, pnl: pnl.toFixed(4) });
          } else if (currentPrice <= pos.sl) {
            await cancelOrder(SYMBOL, pos.tp_order_id);
            const exitOrder = await placeMarketSell(SYMBOL, pos.quantity);
            const exitPrice = parseFloat(exitOrder.cummulativeQuoteQty) / parseFloat(exitOrder.executedQty);
            const pnl       = (exitPrice - pos.entry_price) * pos.quantity;
            await closeFakingPosition(pos.id, { exit_price: exitPrice, pnl, result: "SL_LEGACY" });
            log.push({ action: "SL_LEGACY", exitPrice, pnl: pnl.toFixed(4) });
          } else {
            await incrementFakingHold(pos.id, pos.hold_count);
            log.push({ action: "HOLD_LEGACY", hold: pos.hold_count + 1, currentPrice });
          }
          await logFakingRun(log);
          return { ok: true, actions: log };
        }

        // New position: check both Binance orders
        const [tpOrder, slOrder] = await Promise.all([
          getOrder(SYMBOL, pos.tp_order_id),
          getOrder(SYMBOL, pos.sl_order_id),
        ]);

        if (tpOrder.status === "FILLED") {
          try { await cancelOrder(SYMBOL, pos.sl_order_id); } catch {}  // cleanup — SL may already be gone
          const exitPrice = parseFloat(tpOrder.cummulativeQuoteQty) / parseFloat(tpOrder.executedQty);
          const pnl       = (exitPrice - pos.entry_price) * pos.quantity;
          await closeFakingPosition(pos.id, { exit_price: exitPrice, pnl, result: "TP" });
          log.push({ action: "TP_FILLED", exit: exitPrice, pnl: pnl.toFixed(4) });

        } else if (slOrder.status === "FILLED") {
          try { await cancelOrder(SYMBOL, pos.tp_order_id); } catch {}  // cleanup — TP may already be gone
          const exitPrice = parseFloat(slOrder.cummulativeQuoteQty) / parseFloat(slOrder.executedQty);
          const pnl       = (exitPrice - pos.entry_price) * pos.quantity;
          await closeFakingPosition(pos.id, { exit_price: exitPrice, pnl, result: "SL" });
          log.push({ action: "SL_FILLED", exit: exitPrice, pnl: pnl.toFixed(4) });

        } else if (tpOrder.status === "CANCELED" || slOrder.status === "CANCELED") {
          // Orders cancelled externally — close DB position to avoid getting stuck
          try { await cancelOrder(SYMBOL, pos.tp_order_id); } catch {}
          try { await cancelOrder(SYMBOL, pos.sl_order_id); } catch {}
          await closeFakingPosition(pos.id, { exit_price: 0, pnl: 0, result: "CANCELLED" });
          log.push({ action: "CANCELLED_EXTERNAL", tpStatus: tpOrder.status, slStatus: slOrder.status });

        } else if (pos.hold_count + 1 >= MAX_HOLD) {
          // Chase: raise TP only if price moved up — SL stop-market stays on Binance untouched
          const newTp  = roundPrice(currentPrice * (1 - CHASE_OFFSET));
          const curTp  = pos.chase_price ?? pos.tp;
          if (newTp > curTp) {
            await cancelOrder(SYMBOL, pos.tp_order_id);
            const newTpOrder = await placeLimitSell(SYMBOL, pos.quantity, newTp);
            await updateFakingChase(pos.id, { tp_order_id: newTpOrder.orderId, chase_price: newTp });
            log.push({ action: "CHASE_UP", currentPrice, newTp });
          } else {
            log.push({ action: "CHASE_HOLD", currentPrice, curTp });
          }

        } else {
          await incrementFakingHold(pos.id, pos.hold_count);
          log.push({ action: "HOLD", hold: pos.hold_count + 1, currentPrice });
        }

      // ── No DB position ────────────────────────────────────────────────────
      } else {
        if (atomFree >= MIN_ATOM) {
          // ATOM on Binance but no DB record — don't trade, flag for investigation
          log.push({ action: "WARN_ATOM_NO_POS", atomFree });

        } else if (z <= -Z_THRESH) {
          if (usdtFree < ALLOCATION) {
            log.push({ action: "SKIP_NO_FUNDS", balance: usdtFree, needed: ALLOCATION });
          } else {
            const estQty = floorQty(ALLOCATION / currentPrice);
            if (estQty * currentPrice >= 10) {
              // Market buy
              const buyOrder  = await placeMarketBuy(SYMBOL, estQty);
              const fillPrice = parseFloat(buyOrder.cummulativeQuoteQty) / parseFloat(buyOrder.executedQty);
              const filledQty = floorQty(parseFloat(buyOrder.executedQty));
              const tp        = roundPrice(fillPrice * (1 + TP_PCT));
              const sl        = roundPrice(fillPrice * (1 - SL_PCT));

              // Place TP limit sell — if fails, market sell and abort
              let tpOrder;
              try {
                tpOrder = await placeLimitSell(SYMBOL, filledQty, tp);
              } catch (err) {
                try { await placeMarketSell(SYMBOL, filledQty); } catch {}
                log.push({ action: "ENTRY_ROLLBACK", stage: "tp", error: String(err) });
                throw err;
              }

              // Place SL stop-market — if fails, cancel TP, market sell and abort
              let slOrder;
              try {
                slOrder = await placeStopMarket(SYMBOL, filledQty, sl);
              } catch (err) {
                try { await cancelOrder(SYMBOL, tpOrder.orderId); } catch {}
                try { await placeMarketSell(SYMBOL, filledQty); } catch {}
                log.push({ action: "ENTRY_ROLLBACK", stage: "sl", error: String(err) });
                throw err;
              }

              await openFakingPosition({
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
