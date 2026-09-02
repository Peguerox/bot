// Live bot — SOL/FDUSD on Binance Global. REAL MONEY, $20 seed, COMPOUNDS with realized PnL.
// Explicit user design (2026-09-01), backtested over 6mo of 1m data before building:
//
// Every run (1-minute Trigger.dev cron, no WebSocket — "our own candle" is just the cron tick
// itself, not an exchange kline boundary):
//   - If flat: place a maker buy for the full $20 (or less if realized PnL has shrunk the pool).
//   - The instant the buy fills, place a real OCO: TP +0.5%, SL -0.05%. A real resting OCO is
//     what lets Binance's engine catch a TP/SL touch *between* our once-a-minute checks — this
//     bot doesn't watch price continuously, so the exchange has to.
//   - If the OCO is still fully resting ~60s after entry (cycle_started_at), neither level was
//     touched: cancel it and force-flat with a maker sell at the current ask ("exit all with
//     maker"), then immediately place the next entry in the same run. This is the backtest's
//     "timed-out-flat" bucket, which carried most of the strategy's edge, not the TP hits.
//   - A stuck/phantom SL (price already blown past the trigger, order not filled) gets chased
//     down as a maker the same way, rather than waiting out the full minute.
//   - Any maker chase (timeout or phantom-SL) that still won't fill after MAX_CHASE_ATTEMPTS
//     falls back to a real MARKET order — rare insurance, not the normal path.
// Fees: PnL tracked net of real commission via getNetSellProceeds, matching every other live bot.
import { schedules } from "@trigger.dev/sdk/v3";
import {
  getPriceGlobal, getBookTickerGlobal, getFreeBalanceGlobal, getOrderGlobal, cancelOrderGlobal,
  placeLimitMakerBuySol, placeLimitMakerSellSol, placeOcoSellSol, placeMarketSellSol, getNetSellProceeds,
} from "../lib/binance-global";
import {
  getSol1MinState, updateSol1MinState, recordSol1MinTrade, logSol1MinRun,
} from "../lib/sol-1min-db";

const SYMBOL          = "SOLFDUSD";
const QUOTE_ASSET     = "FDUSD";
const TP_PCT          = 0.5;
const SL_PCT          = 0.05;
const SL_BUFFER_PCT   = 0;    // no taker-guaranteeing buffer — limit = stop price exactly
const STUCK_STOP_PCT  = 0.02; // if price is this far past the SL trigger with no fill, treat as phantom
const MAX_CHASE_ATTEMPTS = 2; // chase-down-as-maker attempts (1/min each) before falling back to market
const SEED_USD        = 20;   // starting size — compounds with realized PnL from here, no ceiling
const MIN_NOTIONAL    = 5;
const CYCLE_MS        = 60 * 1000; // hold window before a non-TP/SL position gets flattened

function round2(p: number): number { return Math.round(p * 100) / 100; }

export const liveBotSol1Min = schedules.task({
  id:          "live-bot-sol-1min",
  cron:        "*/1 * * * *",
  maxDuration: 55,

  run: async () => {
    const log: object[] = [];

    let state;
    try {
      state = await getSol1MinState();
    } catch (err) {
      await logSol1MinRun({ actions: [{ action: "ERROR", stage: "state", error: String(err) }] });
      return { ok: false };
    }
    if (!state.enabled) return { ok: false, reason: "disabled" };

    try {
      const [livePrice, book] = await Promise.all([getPriceGlobal(SYMBOL), getBookTickerGlobal(SYMBOL)]);
      const nowMs = Date.now();
      log.push({ action: "CHECK", mode: state.mode, price: livePrice, bid: book.bid, ask: book.ask });

      // ── Pending maker buy: check fill, or reprice every tick (our own "candle" is the tick) ──
      if (state.mode === "USD" && state.buy_order_id) {
        const order = await getOrderGlobal(SYMBOL, state.buy_order_id);

        if (order.status === "FILLED") {
          const fillPrice = parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty);
          const solQty    = parseFloat(order.executedQty);
          const usdSpent  = parseFloat(order.cummulativeQuoteQty);

          const tp      = round2(fillPrice * (1 + TP_PCT / 100));
          const slStop  = round2(fillPrice * (1 - SL_PCT / 100));
          const slLimit = round2(slStop * (1 - SL_BUFFER_PCT / 100));

          // Price already moved past the OCO band since the fill — Binance would reject an OCO at
          // these levels (TP leg would cross immediately, or SL would trigger on arrival). Exit at
          // market instead of retrying the same invalid OCO forever while the position sits naked.
          if (livePrice <= slStop || livePrice >= tp) {
            const exitOrder = await placeMarketSellSol(SYMBOL, solQty);
            const grossOut  = parseFloat(exitOrder.cummulativeQuoteQty);
            const exitPrice = grossOut / parseFloat(exitOrder.executedQty);
            const { netProceeds: usdOut } = await getNetSellProceeds(SYMBOL, exitOrder.orderId, QUOTE_ASSET, grossOut);
            const pnlUsd = usdOut - usdSpent;
            const pnlPct = (pnlUsd / usdSpent) * 100;

            await updateSol1MinState({
              mode: "USD", sol_quantity: null, entry_price: null, entry_time: null,
              usd_balance: usdOut, buy_order_id: null,
              oco_order_list_id: null, oco_tp_order_id: null, oco_sl_order_id: null,
              exit_order_id: null, exit_reason_pending: null, chase_attempts: 0, cycle_started_at: null,
            });
            await recordSol1MinTrade({
              entry_price: fillPrice, exit_price: exitPrice, sol_quantity: solQty,
              usd_in: usdSpent, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct,
              exit_reason: livePrice <= slStop ? "SL" : "TP", entry_time: new Date(order.time).toISOString(),
            });
            log.push({ action: "IMMEDIATE_EXIT", reason: livePrice <= slStop ? "SL" : "TP", price: exitPrice, pnlUsd: pnlUsd.toFixed(2), pnlPct: pnlPct.toFixed(2) });
            state = await getSol1MinState();

          } else {
            try {
              const oco = await placeOcoSellSol(SYMBOL, solQty, tp, slStop, slLimit);
              const tpLeg = oco.orderReports.find(r => r.type === "LIMIT_MAKER" || r.type === "LIMIT");
              const slLeg = oco.orderReports.find(r => r.type === "STOP_LOSS_LIMIT");

              await updateSol1MinState({
                mode:                "SOL",
                sol_quantity:        solQty,
                entry_price:         fillPrice,
                entry_time:          new Date().toISOString(),
                usd_balance:         0,
                buy_order_id:        null,
                oco_order_list_id:   oco.orderListId,
                oco_tp_order_id:     tpLeg?.orderId ?? null,
                oco_sl_order_id:     slLeg?.orderId ?? null,
                exit_order_id:       null,
                exit_reason_pending: null,
                chase_attempts:      0,
                cycle_started_at:    new Date(nowMs).toISOString(),
              });
              log.push({ action: "OCO_PLACED", tp, slStop, slLimit, orderListId: oco.orderListId });
              state = await getSol1MinState();

            } catch (err) {
              // OCO placement itself was rejected (race between the band check above and Binance's
              // matching engine) — never leave a filled position with buy_order_id still set, that
              // would just retry the same rejected OCO forever. Market-exit as the safety net.
              const exitOrder = await placeMarketSellSol(SYMBOL, solQty);
              const grossOut  = parseFloat(exitOrder.cummulativeQuoteQty);
              const exitPrice = grossOut / parseFloat(exitOrder.executedQty);
              const { netProceeds: usdOut } = await getNetSellProceeds(SYMBOL, exitOrder.orderId, QUOTE_ASSET, grossOut);
              const pnlUsd = usdOut - usdSpent;
              const pnlPct = (pnlUsd / usdSpent) * 100;

              await updateSol1MinState({
                mode: "USD", sol_quantity: null, entry_price: null, entry_time: null,
                usd_balance: usdOut, buy_order_id: null,
                oco_order_list_id: null, oco_tp_order_id: null, oco_sl_order_id: null,
                exit_order_id: null, exit_reason_pending: null, chase_attempts: 0, cycle_started_at: null,
              });
              await recordSol1MinTrade({
                entry_price: fillPrice, exit_price: exitPrice, sol_quantity: solQty,
                usd_in: usdSpent, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct,
                exit_reason: pnlUsd >= 0 ? "TP" : "SL", entry_time: new Date(order.time).toISOString(),
              });
              log.push({ action: "OCO_REJECTED_MARKET_EXIT", error: String(err), price: exitPrice, pnlUsd: pnlUsd.toFixed(2), pnlPct: pnlPct.toFixed(2) });
              state = await getSol1MinState();
            }
          }

        } else if (order.status === "CANCELED" || order.status === "EXPIRED" || order.status === "REJECTED") {
          await updateSol1MinState({ buy_order_id: null });
          log.push({ action: "BUY_CANCELED", status: order.status });
          state = await getSol1MinState();

        } else {
          // Still resting from last tick — cancel and let the entry block below reprice fresh.
          try { await cancelOrderGlobal(SYMBOL, state.buy_order_id); } catch { /* may already be filled/gone */ }
          await updateSol1MinState({ buy_order_id: null });
          log.push({ action: "BUY_REPRICE" });
          state = await getSol1MinState();
        }
      }

      // ── Open OCO position: TP/SL fill, phantom-stop, or 1-min timeout ──────────
      if (state.mode === "SOL" && state.oco_order_list_id) {
        let exitPrice: number | null = null;
        let reason: "TP" | "SL" | null = null;
        let usdOut = 0;

        if (state.oco_tp_order_id) {
          const tpOrder = await getOrderGlobal(SYMBOL, state.oco_tp_order_id);
          if (tpOrder.status === "FILLED") {
            const grossOut = parseFloat(tpOrder.cummulativeQuoteQty);
            exitPrice = grossOut / parseFloat(tpOrder.executedQty);
            usdOut = (await getNetSellProceeds(SYMBOL, tpOrder.orderId, QUOTE_ASSET, grossOut)).netProceeds;
            reason = "TP";
          }
        }
        if (!reason && state.oco_sl_order_id) {
          const slOrder = await getOrderGlobal(SYMBOL, state.oco_sl_order_id);
          if (slOrder.status === "FILLED") {
            const grossOut = parseFloat(slOrder.cummulativeQuoteQty);
            exitPrice = grossOut / parseFloat(slOrder.executedQty);
            usdOut = (await getNetSellProceeds(SYMBOL, slOrder.orderId, QUOTE_ASSET, grossOut)).netProceeds;
            reason = "SL";
          }
        }

        if (reason && exitPrice !== null) {
          const usdIn  = state.entry_price! * state.sol_quantity!;
          const pnlUsd = usdOut - usdIn;
          const pnlPct = (pnlUsd / usdIn) * 100;

          await updateSol1MinState({
            mode: "USD", sol_quantity: null, entry_price: null, entry_time: null,
            usd_balance: usdOut,
            oco_order_list_id: null, oco_tp_order_id: null, oco_sl_order_id: null,
            exit_order_id: null, exit_reason_pending: null, chase_attempts: 0, cycle_started_at: null,
          });
          await recordSol1MinTrade({
            entry_price: state.entry_price!, exit_price: exitPrice, sol_quantity: state.sol_quantity!,
            usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct,
            exit_reason: reason, entry_time: state.entry_time!,
          });
          log.push({ action: "OCO_FILLED", reason, price: exitPrice, pnlUsd: pnlUsd.toFixed(2), pnlPct: pnlPct.toFixed(2) });
          state = await getSol1MinState();

        } else {
          const restingSlPrice = state.oco_sl_order_id ? parseFloat((await getOrderGlobal(SYMBOL, state.oco_sl_order_id)).price) : null;
          const phantom = restingSlPrice !== null && livePrice <= restingSlPrice * (1 - STUCK_STOP_PCT / 100);
          const cycleStart = state.cycle_started_at ? new Date(state.cycle_started_at).getTime() : nowMs;
          const timedOut = nowMs - cycleStart >= CYCLE_MS;

          if (phantom || timedOut) {
            try { await cancelOrderGlobal(SYMBOL, state.oco_sl_order_id!); } catch { /* cancelling one leg cancels the pair */ }
            const freshBook = await getBookTickerGlobal(SYMBOL);
            const price = round2(freshBook.ask);
            const newOrder = await placeLimitMakerSellSol(SYMBOL, state.sol_quantity!, price);
            await updateSol1MinState({
              oco_order_list_id: null, oco_tp_order_id: null, oco_sl_order_id: null,
              exit_order_id: newOrder.orderId,
              exit_reason_pending: phantom ? "SL" : "TIME",
              chase_attempts: 0,
            });
            log.push({ action: phantom ? "PHANTOM_STOP_CHASE_START" : "TIMEOUT_CHASE_START", price });
            state = await getSol1MinState();
          } else {
            log.push({ action: "OCO_OPEN", tp: state.oco_tp_order_id, sl: state.oco_sl_order_id });
          }
        }
      }

      // ── Pending fallback exit (post-cancel maker sell — timeout or phantom-SL chase) ──
      if (state.mode === "SOL" && state.exit_order_id) {
        const order = await getOrderGlobal(SYMBOL, state.exit_order_id);

        if (order.status === "FILLED") {
          const grossOut = parseFloat(order.cummulativeQuoteQty);
          const exitPrice = grossOut / parseFloat(order.executedQty);
          const usdOut = (await getNetSellProceeds(SYMBOL, order.orderId, QUOTE_ASSET, grossOut)).netProceeds;
          const usdIn  = state.entry_price! * state.sol_quantity!;
          const pnlUsd = usdOut - usdIn;
          const pnlPct = (pnlUsd / usdIn) * 100;

          await updateSol1MinState({
            mode: "USD", sol_quantity: null, entry_price: null, entry_time: null,
            usd_balance: usdOut,
            exit_order_id: null, exit_reason_pending: null, chase_attempts: 0, cycle_started_at: null,
          });
          await recordSol1MinTrade({
            entry_price: state.entry_price!, exit_price: exitPrice, sol_quantity: state.sol_quantity!,
            usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct,
            exit_reason: state.exit_reason_pending ?? "TIME", entry_time: state.entry_time!,
          });
          log.push({ action: "CHASE_FILLED", reason: state.exit_reason_pending, price: exitPrice, pnlUsd: pnlUsd.toFixed(2), pnlPct: pnlPct.toFixed(2) });
          state = await getSol1MinState();

        } else if ((state.chase_attempts ?? 0) >= MAX_CHASE_ATTEMPTS) {
          const exitOrder = await placeMarketSellSol(SYMBOL, state.sol_quantity!);
          const grossOut  = parseFloat(exitOrder.cummulativeQuoteQty);
          const exitPrice = grossOut / parseFloat(exitOrder.executedQty);
          const usdOut = (await getNetSellProceeds(SYMBOL, exitOrder.orderId, QUOTE_ASSET, grossOut)).netProceeds;
          const usdIn  = state.entry_price! * state.sol_quantity!;
          const pnlUsd = usdOut - usdIn;
          const pnlPct = (pnlUsd / usdIn) * 100;

          await updateSol1MinState({
            mode: "USD", sol_quantity: null, entry_price: null, entry_time: null,
            usd_balance: usdOut,
            exit_order_id: null, exit_reason_pending: null, chase_attempts: 0, cycle_started_at: null,
          });
          await recordSol1MinTrade({
            entry_price: state.entry_price!, exit_price: exitPrice, sol_quantity: state.sol_quantity!,
            usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct,
            exit_reason: state.exit_reason_pending ?? "TIME", entry_time: state.entry_time!,
          });
          log.push({ action: "MARKET_FALLBACK_EXIT", reason: state.exit_reason_pending, price: exitPrice, pnlUsd: pnlUsd.toFixed(2) });
          state = await getSol1MinState();

        } else {
          try { await cancelOrderGlobal(SYMBOL, state.exit_order_id); } catch { /* may already be gone */ }
          const freshBook = await getBookTickerGlobal(SYMBOL);
          const price = round2(freshBook.ask);
          const newOrder = await placeLimitMakerSellSol(SYMBOL, state.sol_quantity!, price);
          await updateSol1MinState({ exit_order_id: newOrder.orderId, chase_attempts: (state.chase_attempts ?? 0) + 1 });
          log.push({ action: "CHASE_DOWN", to: price, attempt: (state.chase_attempts ?? 0) + 1 });
          state = await getSol1MinState();
        }
      }

      // ── Entry: flat, nothing pending → place a fresh maker buy ──────────────
      if (state.mode === "USD" && !state.buy_order_id) {
        const usdFree    = await getFreeBalanceGlobal(QUOTE_ASSET);
        const targetPool = SEED_USD + (state.realized_pnl_usd ?? 0); // compounds — full pool reinvested, not capped at the seed
        const buyAmount  = Math.max(0, Math.min(usdFree, targetPool));

        if (buyAmount >= MIN_NOTIONAL) {
          const price = round2(book.bid);
          const qty   = buyAmount / price;
          const order = await placeLimitMakerBuySol(SYMBOL, qty, price);
          await updateSol1MinState({ buy_order_id: order.orderId });
          log.push({ action: "START_BUY", price, qty, buyAmount });
        } else {
          log.push({ action: "SKIP_BUY", reason: "below_min_notional", buyAmount });
        }
      }

    } catch (err) {
      log.push({ action: "ERROR", stage: "trading", error: String(err) });
    }

    await logSol1MinRun({ actions: log });
    return { ok: true, actions: log };
  },
});
