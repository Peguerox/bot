// Live bot — SOL/USDT OCO on Binance.US. REAL MONEY, hard-capped at $20 (never compounds above
// the seed, same sizing discipline as live-bot-btc-oco.ts). Built with every fee/execution fix
// learned on the SOL Global OCO bot today (2026-09-01), from day one instead of bolted on later:
// - SL leg has no price buffer (limit = stop price exactly) — a buffer guarantees the order
//   crosses the book the instant it triggers, i.e. guaranteed taker. No buffer means a normal
//   trigger rests and fills as maker (free) unless the market is moving too fast to catch it.
// - PnL is tracked net of real commission (getNetSellProceeds), not the order's raw gross
//   cummulativeQuoteQty.
// - A stop that triggers but doesn't fill ("phantom stop") is chased down as a maker —
//   LIMIT_MAKER re-places toward the market, structurally cannot cross the book — for up to
//   MAX_SL_CHASE_ATTEMPTS 1-min cycles (tracked via sl_chase_attempts, since this bot has no
//   in-run memory between ticks) before falling back to a real market order as the backstop.
//
// HYPOTHESIS BEING TESTED: SOL Global OCO ran near-breakeven-to-negative even in a perfect
// backtest over a choppy 33h window. Before concluding the TP/SL design itself is broken, testing
// whether Binance.US's SOL/USDT order book (thinner, possibly less erratic short-term price
// action than Global's SOL/FDUSD) behaves differently for this same strategy.
import { schedules } from "@trigger.dev/sdk/v3";
import {
  getPrice, getBookTicker, getFreeBalance, getOrder, cancelOrder,
  placeLimitMakerBuySolUsdt, placeLimitMakerSellSolUsdt, placeOcoSellSolUsdt, placeMarketSellSolUsdt,
  getNetSellProceeds,
} from "../lib/binance";
import {
  getSolOcoUsState, updateSolOcoUsState, recordSolOcoUsTrade, logSolOcoUsRun,
} from "../lib/sol-oco-us-db";

const SYMBOL          = "SOLUSDT";
const QUOTE_ASSET     = "USDT";
const TP_PCT          = 1.0;
const SL_PCT          = 0.1;
const SL_BUFFER_PCT   = 0;    // no taker-guaranteeing buffer — see FEES note in sol-oco-global
const STUCK_STOP_PCT  = 0.02; // if price is this far past the SL trigger with no fill, treat as phantom
const MAX_SL_CHASE_ATTEMPTS = 2; // chase-down-as-maker attempts (1/min each) before falling back to market
const HARD_CAP_USD    = 20;   // never spend more than this, ever, regardless of any other balance
const MIN_NOTIONAL    = 5;    // SOLUSDT exchange minimum is $5 notional
const CANDLE_MS       = 1 * 60 * 1000;

function round2(p: number): number { return Math.round(p * 100) / 100; }

export const liveBotSolOcoUs = schedules.task({
  id:          "live-bot-sol-oco-us-1m",
  cron:        "*/1 * * * *",
  maxDuration: 55,

  run: async () => {
    const log: object[] = [];

    let state;
    try {
      state = await getSolOcoUsState();
    } catch (err) {
      await logSolOcoUsRun({ actions: [{ action: "ERROR", stage: "state", error: String(err) }] });
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
          const solQty    = parseFloat(order.executedQty);
          const usdSpent  = parseFloat(order.cummulativeQuoteQty);

          const tp      = round2(fillPrice * (1 + TP_PCT / 100));
          const slStop  = round2(fillPrice * (1 - SL_PCT / 100));
          const slLimit = round2(slStop * (1 - SL_BUFFER_PCT / 100));

          log.push({ action: "BUY_FILLED", price: fillPrice, qty: solQty, usdSpent });

          // Price already moved past the OCO band since the fill — a resting stop/limit at
          // these levels would be rejected by Binance. Exit at market instead of retrying the
          // same invalid OCO forever while the position sits unprotected.
          if (livePrice <= slStop || livePrice >= tp) {
            const exitOrder = await placeMarketSellSolUsdt(SYMBOL, solQty);
            const grossOut  = parseFloat(exitOrder.cummulativeQuoteQty);
            const exitPrice = grossOut / parseFloat(exitOrder.executedQty);
            const { netProceeds: usdOut } = await getNetSellProceeds(SYMBOL, exitOrder.orderId, QUOTE_ASSET, grossOut);
            const pnlUsd    = usdOut - usdSpent;
            const pnlPct    = (pnlUsd / usdSpent) * 100;

            await updateSolOcoUsState({
              mode:              "USD",
              sol_quantity:      null,
              entry_price:       null,
              entry_time:        null,
              usd_balance:       usdOut,
              buy_order_id:      null,
              oco_order_list_id: null,
              oco_tp_order_id:   null,
              oco_sl_order_id:   null,
            });
            await recordSolOcoUsTrade({
              entry_price:  fillPrice,
              exit_price:   exitPrice,
              sol_quantity: solQty,
              usd_in:       usdSpent,
              usd_out:      usdOut,
              pnl_usd:      pnlUsd,
              pnl_pct:      pnlPct,
              exit_reason:  livePrice <= slStop ? "SL" : "TP",
              entry_time:   new Date(order.time).toISOString(),
            });
            log.push({ action: "IMMEDIATE_EXIT", reason: livePrice <= slStop ? "SL" : "TP", price: exitPrice, pnlUsd: pnlUsd.toFixed(2), pnlPct: pnlPct.toFixed(2) });
            state = await getSolOcoUsState();

          } else {
            const oco = await placeOcoSellSolUsdt(SYMBOL, solQty, tp, slStop, slLimit);
            const tpLeg = oco.orderReports.find(r => r.type === "LIMIT_MAKER" || r.type === "LIMIT");
            const slLeg = oco.orderReports.find(r => r.type === "STOP_LOSS_LIMIT");

            await updateSolOcoUsState({
              mode:              "SOL",
              sol_quantity:      solQty,
              entry_price:       fillPrice,
              entry_time:        new Date().toISOString(),
              usd_balance:       0,
              buy_order_id:      null,
              oco_order_list_id: oco.orderListId,
              oco_tp_order_id:   tpLeg?.orderId ?? null,
              oco_sl_order_id:   slLeg?.orderId ?? null,
              sl_chase_attempts: 0,
            });
            log.push({ action: "OCO_PLACED", tp, slStop, slLimit, orderListId: oco.orderListId });
            state = await getSolOcoUsState();
          }

        } else if (order.status === "CANCELED" || order.status === "EXPIRED" || order.status === "REJECTED") {
          await updateSolOcoUsState({ buy_order_id: null });
          log.push({ action: "BUY_CANCELED", status: order.status });
          state = await getSolOcoUsState();

        } else if (isNewCandle) {
          // Stale resting order from a prior candle — cancel and let the entry block below reprice it.
          try { await cancelOrder(SYMBOL, state.buy_order_id); } catch { /* may already be filled/gone */ }
          await updateSolOcoUsState({ buy_order_id: null, last_candle_ts: candleTs });
          log.push({ action: "BUY_REPRICE_PENDING" });
          state = await getSolOcoUsState();

        } else {
          log.push({ action: "BUY_WAIT", orderId: state.buy_order_id });
        }
      }

      // ── Open OCO position: check TP / SL leg fill ───────────────────────────
      if (state.mode === "SOL" && state.oco_order_list_id) {
        let exitPrice: number | null = null;
        let reason: "TP" | "SL" | null = null;
        let usdOut = 0;
        let phantom = false;

        if (state.oco_tp_order_id) {
          const tpOrder = await getOrder(SYMBOL, state.oco_tp_order_id);
          if (tpOrder.status === "FILLED") {
            const grossOut = parseFloat(tpOrder.cummulativeQuoteQty);
            exitPrice = grossOut / parseFloat(tpOrder.executedQty);
            usdOut = (await getNetSellProceeds(SYMBOL, tpOrder.orderId, QUOTE_ASSET, grossOut)).netProceeds;
            reason = "TP";
          }
        }
        if (!reason && state.oco_sl_order_id) {
          const slOrder = await getOrder(SYMBOL, state.oco_sl_order_id);
          if (slOrder.status === "FILLED") {
            const grossOut = parseFloat(slOrder.cummulativeQuoteQty);
            exitPrice = grossOut / parseFloat(slOrder.executedQty);
            usdOut = (await getNetSellProceeds(SYMBOL, slOrder.orderId, QUOTE_ASSET, grossOut)).netProceeds;
            reason = "SL";
          } else {
            // Phantom-stop check: no WebSocket chase here (1-min poll only), so reference price
            // is the SL order's own resting price — once we've chased it down once, this checks
            // against where it *currently* sits, not the original entry-derived trigger.
            const restingSlPrice = parseFloat(slOrder.price);
            if (livePrice <= restingSlPrice * (1 - STUCK_STOP_PCT / 100)) {
              try { await cancelOrder(SYMBOL, state.oco_sl_order_id); } catch { /* may already be gone */ }
              const cancelCheck = await getOrder(SYMBOL, state.oco_sl_order_id);

              if (cancelCheck.status === "FILLED") {
                const grossOut = parseFloat(cancelCheck.cummulativeQuoteQty);
                exitPrice = grossOut / parseFloat(cancelCheck.executedQty);
                usdOut = (await getNetSellProceeds(SYMBOL, cancelCheck.orderId, QUOTE_ASSET, grossOut)).netProceeds;
                reason = "SL";
              } else if ((state.sl_chase_attempts ?? 0) >= MAX_SL_CHASE_ATTEMPTS) {
                const exitOrder = await placeMarketSellSolUsdt(SYMBOL, state.sol_quantity!);
                const grossOut  = parseFloat(exitOrder.cummulativeQuoteQty);
                exitPrice = grossOut / parseFloat(exitOrder.executedQty);
                usdOut = (await getNetSellProceeds(SYMBOL, exitOrder.orderId, QUOTE_ASSET, grossOut)).netProceeds;
                reason = "SL";
                phantom = true;
              } else {
                // Chase it down as a maker first — LIMIT_MAKER structurally can't cross the
                // book. Cancelling one OCO leg cancels the whole list, so the TP leg is gone too
                // — tracked by the single resting sell until it fills or gets chased again.
                try {
                  const freshBook = await getBookTicker(SYMBOL);
                  const newPrice = round2(freshBook.ask);
                  const newOrder = await placeLimitMakerSellSolUsdt(SYMBOL, state.sol_quantity!, newPrice);
                  await updateSolOcoUsState({
                    oco_sl_order_id: newOrder.orderId, oco_tp_order_id: null,
                    sl_chase_attempts: (state.sl_chase_attempts ?? 0) + 1,
                  });
                  log.push({ action: "CHASE_DOWN", to: newPrice, attempt: (state.sl_chase_attempts ?? 0) + 1 });
                  state = await getSolOcoUsState();
                } catch (err) {
                  const exitOrder = await placeMarketSellSolUsdt(SYMBOL, state.sol_quantity!);
                  const grossOut  = parseFloat(exitOrder.cummulativeQuoteQty);
                  exitPrice = grossOut / parseFloat(exitOrder.executedQty);
                  usdOut = (await getNetSellProceeds(SYMBOL, exitOrder.orderId, QUOTE_ASSET, grossOut)).netProceeds;
                  reason = "SL";
                  phantom = true;
                  log.push({ action: "ERROR", stage: "chase_down_reprice", error: String(err) });
                }
              }
            }
          }
        }

        if (reason && exitPrice !== null) {
          const usdIn  = state.entry_price! * state.sol_quantity!;
          const pnlUsd = usdOut - usdIn;
          const pnlPct = (pnlUsd / usdIn) * 100;

          await updateSolOcoUsState({
            mode:              "USD",
            sol_quantity:      null,
            entry_price:       null,
            entry_time:        null,
            usd_balance:       usdOut,
            oco_order_list_id: null,
            oco_tp_order_id:   null,
            oco_sl_order_id:   null,
            sl_chase_attempts: 0,
          });
          await recordSolOcoUsTrade({
            entry_price:  state.entry_price!,
            exit_price:   exitPrice,
            sol_quantity: state.sol_quantity!,
            usd_in:       usdIn,
            usd_out:      usdOut,
            pnl_usd:      pnlUsd,
            pnl_pct:      pnlPct,
            exit_reason:  reason,
            entry_time:   state.entry_time!,
          });
          log.push({ action: phantom ? "PHANTOM_STOP_MARKET_EXIT" : "OCO_FILLED", reason, price: exitPrice, pnlUsd: pnlUsd.toFixed(2), pnlPct: pnlPct.toFixed(2) });
          state = await getSolOcoUsState();
        } else {
          log.push({ action: "OCO_OPEN", tp: state.oco_tp_order_id, sl: state.oco_sl_order_id });
        }
      }

      // ── Entry: flat, no pending order → place a fresh maker buy at best bid ──
      if (state.mode === "USD" && !state.buy_order_id) {
        const usdFree    = await getFreeBalance("USDT");
        const targetPool = HARD_CAP_USD + (state.realized_pnl_usd ?? 0);
        const buyAmount  = Math.min(HARD_CAP_USD, usdFree, targetPool);

        if (buyAmount >= MIN_NOTIONAL) {
          const price = round2(book.bid);
          const qty   = buyAmount / price;
          const order = await placeLimitMakerBuySolUsdt(SYMBOL, qty, price);
          await updateSolOcoUsState({ buy_order_id: order.orderId, last_candle_ts: candleTs });
          log.push({ action: "START_BUY", price, qty, buyAmount });
        } else {
          log.push({ action: "SKIP_BUY", reason: "below_min_notional", buyAmount });
        }
      }

    } catch (err) {
      log.push({ action: "ERROR", stage: "trading", error: String(err) });
    }

    await logSolOcoUsRun({ actions: log });
    return { ok: true, actions: log };
  },
});
