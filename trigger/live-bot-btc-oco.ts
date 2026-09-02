// Live bot — BTC/USDT OCO test on Binance.US. REAL MONEY, hard-capped at $20.
// Strategy: every-bar (no filter), entry as a LIMIT_MAKER buy at best bid (maker only,
// zero slippage or no fill), TP=+1.0% and SL=-0.1% placed as a single OCO the moment the
// entry fills — TP as maker limit, SL as STOP_LOSS_LIMIT with a small price buffer so it
// has a real chance to fill during a fast move. New entry attempt on every 5m candle while
// flat (cancels and reprices an unfilled resting buy order each new candle).
//
// SAFETY: buy size is always min($20 hard cap, tracked pool, real free USDT balance) — the
// bot can never spend more than the original $20 seed, regardless of account balance or bugs.
import { schedules } from "@trigger.dev/sdk/v3";
import {
  getPrice, getBookTicker, getFreeBalance, getOrder, cancelOrder,
  placeLimitMakerBuyBtc, placeOcoSellBtc,
} from "../lib/binance";
import {
  getBtcOcoState, updateBtcOcoState, recordBtcOcoTrade, logBtcOcoRun,
} from "../lib/btc-oco-db";

const SYMBOL       = "BTCUSDT";
const TP_PCT        = 1.0;
const SL_PCT         = 0.1;
const SL_BUFFER_PCT  = 0.05; // extra room below the SL trigger for the stop-limit leg to actually fill
const HARD_CAP_USD   = 20;   // never spend more than this, ever, regardless of any other balance
const MIN_NOTIONAL   = 2;    // skip buying if usable capital is this thin
const CANDLE_MS      = 1 * 60 * 1000;

function round2(p: number): number { return Math.round(p * 100) / 100; }

export const liveBotBtcOco = schedules.task({
  id:          "live-bot-btc-oco-5m",
  cron:        "*/1 * * * *", // poll every 1m so a filled maker buy gets its OCO placed within ~1min, not up to 5min
  maxDuration: 55,

  run: async () => {
    const log: object[] = [];

    let state;
    try {
      state = await getBtcOcoState();
    } catch (err) {
      await logBtcOcoRun({ actions: [{ action: "ERROR", stage: "state", error: String(err) }] });
      return { ok: false };
    }
    if (!state.enabled) return { ok: false, reason: "disabled" };

    try {
      const [livePrice, book] = await Promise.all([getPrice(SYMBOL), getBookTicker(SYMBOL)]);
      const nowMs = Date.now();
      const candleTs = Math.floor(nowMs / CANDLE_MS) * CANDLE_MS;
      const isNewCandle = candleTs > (state.last_candle_ts ?? 0);

      log.push({ action: "CHECK", mode: state.mode, price: livePrice, bid: book.bid, ask: book.ask });

      // ── Pending maker buy order: check fill, or refresh on new candle ──────
      if (state.mode === "USD" && state.buy_order_id) {
        const order = await getOrder(SYMBOL, state.buy_order_id);

        if (order.status === "FILLED") {
          const fillPrice = parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty);
          const btcQty    = parseFloat(order.executedQty);
          const usdSpent  = parseFloat(order.cummulativeQuoteQty);

          const tp      = round2(fillPrice * (1 + TP_PCT / 100));
          const slStop  = round2(fillPrice * (1 - SL_PCT / 100));
          const slLimit = round2(slStop * (1 - SL_BUFFER_PCT / 100));

          const oco = await placeOcoSellBtc(SYMBOL, btcQty, tp, slStop, slLimit);
          const tpLeg = oco.orderReports.find(r => r.type === "LIMIT_MAKER" || r.type === "LIMIT");
          const slLeg = oco.orderReports.find(r => r.type === "STOP_LOSS_LIMIT");

          await updateBtcOcoState({
            mode:              "BTC",
            btc_quantity:      btcQty,
            entry_price:       fillPrice,
            entry_time:        new Date().toISOString(),
            usd_balance:       0,
            buy_order_id:      null,
            oco_order_list_id: oco.orderListId,
            oco_tp_order_id:   tpLeg?.orderId ?? null,
            oco_sl_order_id:   slLeg?.orderId ?? null,
          });
          log.push({ action: "BUY_FILLED", price: fillPrice, qty: btcQty, usdSpent });
          log.push({ action: "OCO_PLACED", tp, slStop, slLimit, orderListId: oco.orderListId });
          state = await getBtcOcoState();

        } else if (order.status === "CANCELED" || order.status === "EXPIRED" || order.status === "REJECTED") {
          await updateBtcOcoState({ buy_order_id: null });
          log.push({ action: "BUY_CANCELED", status: order.status });
          state = await getBtcOcoState();

        } else if (isNewCandle) {
          // Stale resting order from a prior candle — cancel and let the entry block below reprice it.
          try { await cancelOrder(SYMBOL, state.buy_order_id); } catch { /* may already be filled/gone */ }
          await updateBtcOcoState({ buy_order_id: null, last_candle_ts: candleTs });
          log.push({ action: "BUY_REPRICE_PENDING" });
          state = await getBtcOcoState();

        } else {
          log.push({ action: "BUY_WAIT", orderId: state.buy_order_id });
        }
      }

      // ── Open OCO position: check TP / SL leg fill ───────────────────────────
      if (state.mode === "BTC" && state.oco_order_list_id) {
        let exitPrice: number | null = null;
        let reason: "TP" | "SL" | null = null;
        let usdOut = 0;

        if (state.oco_tp_order_id) {
          const tpOrder = await getOrder(SYMBOL, state.oco_tp_order_id);
          if (tpOrder.status === "FILLED") {
            exitPrice = parseFloat(tpOrder.cummulativeQuoteQty) / parseFloat(tpOrder.executedQty);
            usdOut = parseFloat(tpOrder.cummulativeQuoteQty);
            reason = "TP";
          }
        }
        if (!reason && state.oco_sl_order_id) {
          const slOrder = await getOrder(SYMBOL, state.oco_sl_order_id);
          if (slOrder.status === "FILLED") {
            exitPrice = parseFloat(slOrder.cummulativeQuoteQty) / parseFloat(slOrder.executedQty);
            usdOut = parseFloat(slOrder.cummulativeQuoteQty);
            reason = "SL";
          }
        }

        if (reason && exitPrice !== null) {
          const usdIn  = state.entry_price! * state.btc_quantity!;
          const pnlUsd = usdOut - usdIn;
          const pnlPct = (pnlUsd / usdIn) * 100;

          await updateBtcOcoState({
            mode:              "USD",
            btc_quantity:      null,
            entry_price:       null,
            entry_time:        null,
            usd_balance:       usdOut,
            oco_order_list_id: null,
            oco_tp_order_id:   null,
            oco_sl_order_id:   null,
          });
          await recordBtcOcoTrade({
            entry_price:  state.entry_price!,
            exit_price:   exitPrice,
            btc_quantity: state.btc_quantity!,
            usd_in:       usdIn,
            usd_out:      usdOut,
            pnl_usd:      pnlUsd,
            pnl_pct:      pnlPct,
            exit_reason:  reason,
            entry_time:   state.entry_time!,
          });
          log.push({ action: "OCO_FILLED", reason, price: exitPrice, pnlUsd: pnlUsd.toFixed(2), pnlPct: pnlPct.toFixed(2) });
          state = await getBtcOcoState();
        } else {
          log.push({ action: "OCO_OPEN", tp: state.oco_tp_order_id, sl: state.oco_sl_order_id });
        }
      }

      // ── Entry: flat, no pending order → place a fresh maker buy at best bid ──
      if (state.mode === "USD" && !state.buy_order_id) {
        const usdFree = await getFreeBalance("USDT");
        // Derive the target position size from the $20 seed + all-time realized PnL,
        // not from the last trade's raw proceeds — chaining usd_balance forward
        // compounds the lot-size rounding loss (Binance floors qty to the nearest
        // 0.00001 BTC step) every cycle instead of self-correcting each time.
        const targetPool = HARD_CAP_USD + (state.realized_pnl_usd ?? 0);
        const buyAmount  = Math.min(HARD_CAP_USD, usdFree, targetPool);

        if (buyAmount >= MIN_NOTIONAL) {
          const price = round2(book.bid);
          const qty   = buyAmount / price;
          const order = await placeLimitMakerBuyBtc(SYMBOL, qty, price);
          await updateBtcOcoState({ buy_order_id: order.orderId, last_candle_ts: candleTs });
          log.push({ action: "START_BUY", price, qty, buyAmount });
        } else {
          log.push({ action: "SKIP_BUY", reason: "below_min_notional", buyAmount });
        }
      }

    } catch (err) {
      log.push({ action: "ERROR", stage: "trading", error: String(err) });
    }

    await logBtcOcoRun({ actions: log });
    return { ok: true, actions: log };
  },
});
