// Live bot — SOL/FDUSD OCO test on Binance Global. REAL MONEY, starts at $100, COMPOUNDS.
// Same architecture as the BTC OCO bot (live-bot-btc-oco.ts), adapted for Binance Global:
// every-bar (no filter), entry as a LIMIT_MAKER buy at best bid (maker only, zero slippage
// or no fill), TP=+1.0% and SL=-0.1% placed as a single OCO the moment entry fills — TP as
// maker limit, SL as STOP_LOSS_LIMIT. New entry attempt every 1-min candle while flat
// (cancels and reprices an unfilled resting buy order each new candle).
//
// FEES (2026-09-01): the SL leg's limit price used to sit a small buffer below the trigger "so
// it has a real chance to fill during a fast move" — but that buffer guarantees the order
// crosses the book the instant it triggers, so it fills as TAKER every single time (confirmed
// on real fills from the sibling Trail bot: 0/41 recent sells were maker; the TP leg here is
// already free — LIMIT_MAKER is structurally maker-only). The buffer is now removed (limit =
// stop price exactly) so a normal trigger rests and fills as maker (free). Since this bot only
// checks state once a minute (no WebSocket chase like live-bot-sol-trail.ts), a stop that
// triggers but doesn't fill could otherwise sit unprotected for up to a minute — the SL-leg
// check below now also watches for a stop that's clearly been triggered but isn't FILLED yet
// (a "phantom stop", via STUCK_STOP_PCT). Instead of jumping straight to a market exit, it
// chases the price down as a maker (LIMIT_MAKER re-place, structurally can't cross) for up to
// MAX_SL_CHASE_ATTEMPTS 1-min cycles, tracked via sl_chase_attempts since this bot has no
// in-run memory between ticks — only falls back to a real market order once that's exhausted.
//
// Also: PnL tracking used to use each order's cummulativeQuoteQty directly as "USD out" — that's
// GROSS proceeds before commission, not what actually lands in the account. Every exit now nets
// out the real commission via getNetSellProceeds so the tracked numbers match the real balance.
//
// SIZING: buy size is min(real free FDUSD balance, $100 seed + all-time realized PnL) — grows
// with wins, shrinks with losses, no ceiling. Sized off the tracked seed+PnL total rather than
// chaining the raw proceeds of the last trade forward (that caused a real rounding-loss bug on
// the BTC bot — see project_fee_slippage_finding memory / btc-oco trigger comment history);
// this keeps that self-correcting property while still letting the position size compound.
import { schedules } from "@trigger.dev/sdk/v3";
import {
  getPriceGlobal, getBookTickerGlobal, getFreeBalanceGlobal, getOrderGlobal, cancelOrderGlobal,
  placeLimitMakerBuySol, placeLimitMakerSellSol, placeOcoSellSol, placeMarketSellSol, getNetSellProceeds,
} from "../lib/binance-global";
import {
  getSolOcoState, updateSolOcoState, recordSolOcoTrade, logSolOcoRun,
} from "../lib/sol-oco-db";

const SYMBOL          = "SOLFDUSD";
const QUOTE_ASSET     = "FDUSD";
const TP_PCT          = 1.0;
const SL_PCT          = 0.1;
const SL_BUFFER_PCT   = 0;    // was 0.05 — guaranteed a taker fill every time, see FEES note above
const STUCK_STOP_PCT  = 0.02; // if price is this far past the SL trigger with no fill, treat as phantom
const MAX_SL_CHASE_ATTEMPTS = 2; // chase-down-as-maker attempts (1/min each) before falling back to market
const SEED_USD        = 100;  // starting size — compounds from here, not a ceiling
const MIN_NOTIONAL    = 5;    // SOLFDUSD exchange minimum is $5 notional
const CANDLE_MS       = 1 * 60 * 1000;

function round2(p: number): number { return Math.round(p * 100) / 100; }

export const liveBotSolOco = schedules.task({
  id:          "live-bot-sol-oco-1m",
  cron:        "*/1 * * * *",
  maxDuration: 55,

  run: async () => {
    const log: object[] = [];

    let state;
    try {
      state = await getSolOcoState();
    } catch (err) {
      await logSolOcoRun({ actions: [{ action: "ERROR", stage: "state", error: String(err) }] });
      return { ok: false };
    }
    if (!state.enabled) return { ok: false, reason: "disabled" };

    try {
      const [livePrice, book] = await Promise.all([getPriceGlobal(SYMBOL), getBookTickerGlobal(SYMBOL)]);
      const nowMs = Date.now();
      const candleTs = Math.floor(nowMs / CANDLE_MS) * CANDLE_MS;
      const isNewCandle = candleTs > (state.last_candle_ts ?? 0);

      log.push({ action: "CHECK", mode: state.mode, price: livePrice, bid: book.bid, ask: book.ask });

      // ── Pending maker buy order: check fill, or refresh on new candle ──────
      if (state.mode === "USD" && state.buy_order_id) {
        const order = await getOrderGlobal(SYMBOL, state.buy_order_id);

        if (order.status === "FILLED") {
          const fillPrice = parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty);
          const solQty    = parseFloat(order.executedQty);
          const usdSpent  = parseFloat(order.cummulativeQuoteQty);

          const tp      = round2(fillPrice * (1 + TP_PCT / 100));
          const slStop  = round2(fillPrice * (1 - SL_PCT / 100));
          const slLimit = round2(slStop * (1 - SL_BUFFER_PCT / 100));

          log.push({ action: "BUY_FILLED", price: fillPrice, qty: solQty, usdSpent });

          // Price already moved past the OCO band since the fill (e.g. OCO placement got
          // delayed a run or two) — a resting stop/limit at these levels would be rejected
          // by Binance (-2010, stop already breached). Exit at market instead of retrying
          // the same invalid OCO forever while the position sits unprotected.
          if (livePrice <= slStop || livePrice >= tp) {
            const exitOrder = await placeMarketSellSol(SYMBOL, solQty);
            const grossOut  = parseFloat(exitOrder.cummulativeQuoteQty);
            const exitPrice = grossOut / parseFloat(exitOrder.executedQty);
            const { netProceeds: usdOut } = await getNetSellProceeds(SYMBOL, exitOrder.orderId, QUOTE_ASSET, grossOut);
            const pnlUsd    = usdOut - usdSpent;
            const pnlPct    = (pnlUsd / usdSpent) * 100;

            await updateSolOcoState({
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
            await recordSolOcoTrade({
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
            state = await getSolOcoState();

          } else {
            const oco = await placeOcoSellSol(SYMBOL, solQty, tp, slStop, slLimit);
            const tpLeg = oco.orderReports.find(r => r.type === "LIMIT_MAKER" || r.type === "LIMIT");
            const slLeg = oco.orderReports.find(r => r.type === "STOP_LOSS_LIMIT");

            await updateSolOcoState({
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
            state = await getSolOcoState();
          }

        } else if (order.status === "CANCELED" || order.status === "EXPIRED" || order.status === "REJECTED") {
          await updateSolOcoState({ buy_order_id: null });
          log.push({ action: "BUY_CANCELED", status: order.status });
          state = await getSolOcoState();

        } else if (isNewCandle) {
          // Stale resting order from a prior candle — cancel and let the entry block below reprice it.
          try { await cancelOrderGlobal(SYMBOL, state.buy_order_id); } catch { /* may already be filled/gone */ }
          await updateSolOcoState({ buy_order_id: null, last_candle_ts: candleTs });
          log.push({ action: "BUY_REPRICE_PENDING" });
          state = await getSolOcoState();

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
          } else {
            // Phantom-stop check: no WebSocket chase here, so a stop that triggers but doesn't
            // fill could otherwise sit unprotected until the next 1-min tick notices. Reference
            // price is the SL order's own resting price (not the original entry-derived level) —
            // that way, once we've already chased it down once, this check compares against
            // where it *currently* sits, not the original trigger, so it doesn't keep firing
            // just because price is still below the original entry-based level.
            const restingSlPrice = parseFloat(slOrder.price);
            if (livePrice <= restingSlPrice * (1 - STUCK_STOP_PCT / 100)) {
              try { await cancelOrderGlobal(SYMBOL, state.oco_sl_order_id); } catch { /* may already be gone */ }
              const cancelCheck = await getOrderGlobal(SYMBOL, state.oco_sl_order_id);

              if (cancelCheck.status === "FILLED") {
                const grossOut = parseFloat(cancelCheck.cummulativeQuoteQty);
                exitPrice = grossOut / parseFloat(cancelCheck.executedQty);
                usdOut = (await getNetSellProceeds(SYMBOL, cancelCheck.orderId, QUOTE_ASSET, grossOut)).netProceeds;
                reason = "SL";
              } else if ((state.sl_chase_attempts ?? 0) >= MAX_SL_CHASE_ATTEMPTS) {
                // Already chased it down MAX_SL_CHASE_ATTEMPTS times (1/min each, since this bot
                // only polls once a minute) — stop waiting and exit at market as the backstop.
                const exitOrder = await placeMarketSellSol(SYMBOL, state.sol_quantity!);
                const grossOut  = parseFloat(exitOrder.cummulativeQuoteQty);
                exitPrice = grossOut / parseFloat(exitOrder.executedQty);
                usdOut = (await getNetSellProceeds(SYMBOL, exitOrder.orderId, QUOTE_ASSET, grossOut)).netProceeds;
                reason = "SL";
                phantom = true;
              } else {
                // Chase it down as a maker first instead of jumping straight to a market (taker)
                // exit — LIMIT_MAKER is structurally non-crossing, so this can never itself
                // become a taker fill. Only falls back to market once MAX_SL_CHASE_ATTEMPTS is
                // exhausted, or if a placement itself is rejected (price already moved past even
                // this). Cancelling one OCO leg cancels the whole list, so the TP leg is gone too
                // — this position is now tracked by the single resting sell instead of an OCO
                // pair until it either fills or gets chased again.
                try {
                  const freshBook = await getBookTickerGlobal(SYMBOL);
                  const newPrice = round2(freshBook.ask);
                  const newOrder = await placeLimitMakerSellSol(SYMBOL, state.sol_quantity!, newPrice);
                  await updateSolOcoState({
                    oco_sl_order_id: newOrder.orderId, oco_tp_order_id: null,
                    sl_chase_attempts: (state.sl_chase_attempts ?? 0) + 1,
                  });
                  log.push({ action: "CHASE_DOWN", to: newPrice, attempt: (state.sl_chase_attempts ?? 0) + 1 });
                  state = await getSolOcoState();
                } catch (err) {
                  const exitOrder = await placeMarketSellSol(SYMBOL, state.sol_quantity!);
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

          await updateSolOcoState({
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
          await recordSolOcoTrade({
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
          state = await getSolOcoState();
        } else {
          log.push({ action: "OCO_OPEN", tp: state.oco_tp_order_id, sl: state.oco_sl_order_id });
        }
      }

      // ── Entry: flat, no pending order → place a fresh maker buy at best bid ──
      if (state.mode === "USD" && !state.buy_order_id) {
        const usdFree    = await getFreeBalanceGlobal("FDUSD");
        // Compounds: target pool grows with all-time realized PnL, no fixed ceiling. Still
        // sized off the tracked seed+PnL total, not the last trade's raw proceeds — chaining
        // usd_balance forward would compound lot-size rounding loss every cycle instead of
        // self-correcting each time. Floored by actual free balance either way.
        const targetPool = SEED_USD + (state.realized_pnl_usd ?? 0);
        const buyAmount  = Math.min(usdFree, targetPool);

        if (buyAmount >= MIN_NOTIONAL) {
          const price = round2(book.bid);
          const qty   = buyAmount / price;
          const order = await placeLimitMakerBuySol(SYMBOL, qty, price);
          await updateSolOcoState({ buy_order_id: order.orderId, last_candle_ts: candleTs });
          log.push({ action: "START_BUY", price, qty, buyAmount });
        } else {
          log.push({ action: "SKIP_BUY", reason: "below_min_notional", buyAmount });
        }
      }

    } catch (err) {
      log.push({ action: "ERROR", stage: "trading", error: String(err) });
    }

    await logSolOcoRun({ actions: log });
    return { ok: true, actions: log };
  },
});
