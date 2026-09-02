// Live bot — SOL/FDUSD VWAP-armed scalp on Binance Global. REAL MONEY, $20 seed, no compounding
// (unlike live-bot-sol-1min, this strategy hasn't been stress-tested live yet — starting small).
//
// Signal is an exact port of paper-bot-vwap-scalp-solfdusd.ts: while a closing 5m candle is below
// the rolling 20-period VWAP, the entry is armed; re-checked fresh on every new 5m candle. TP/SL
// are the paper bot's own settings (+0.5% / -0.1%), not the tighter 1-Min bot's band.
//
// Execution is the maker-first machinery proven across every other live bot this session:
//   - Entry: maker buy, reprice-on-drift every tick until filled.
//   - The instant it fills, a real OCO is placed (TP LIMIT_MAKER, SL STOP_LOSS_LIMIT, zero buffer)
//     — letting Binance's engine catch a touch between our once-a-minute checks.
//   - No timeout — matches the paper bot exactly, holds until TP or SL, however long that takes.
//   - A stuck/phantom SL (price blown past the trigger, order not filled) chases down as a maker,
//     persisted attempt counter (not a local var — see the sl_chase_attempts bug fixed on
//     live-bot-sol-trail.ts this session), MARKET fallback only after MAX_CHASE_ATTEMPTS.
//   - If price already moved past the band before the OCO can be placed (or the OCO placement
//     itself is rejected), market-exit immediately rather than retrying a doomed OCO forever.
// Fees: PnL tracked net of real commission via getNetSellProceeds, matching every other live bot.
import { schedules } from "@trigger.dev/sdk/v3";
import {
  getKlinesGlobal, getPriceGlobal, getBookTickerGlobal, getFreeBalanceGlobal, getOrderGlobal, cancelOrderGlobal,
  placeLimitMakerBuySol, placeLimitMakerSellSol, placeOcoSellSol, placeMarketSellSol, getNetSellProceeds,
} from "../lib/binance-global";
import {
  getSolVwapLiveState, updateSolVwapLiveState, recordSolVwapLiveTrade, logSolVwapLiveRun,
} from "../lib/sol-vwap-live-db";

const SYMBOL          = "SOLFDUSD";
const QUOTE_ASSET     = "FDUSD";
const VWAP_PERIOD     = 20;
const C5_LIMIT        = VWAP_PERIOD + 10;
const TP_PCT          = 0.5;
const SL_PCT          = 0.1;
const SL_BUFFER_PCT   = 0;
const STUCK_STOP_PCT  = 0.02;
const MAX_CHASE_ATTEMPTS = 2;
const SEED_USD        = 20;
const MIN_NOTIONAL    = 5;

type Candle = { time: number; close: number; volume: number };

function round2(p: number): number { return Math.round(p * 100) / 100; }

function calcRollingVWAP(candles: Candle[]): number {
  const window = candles.slice(-VWAP_PERIOD - 1, -1); // last 20 CLOSED candles, excluding current
  let pv = 0, vol = 0;
  for (const c of window) { pv += c.close * c.volume; vol += c.volume; }
  return vol > 0 ? pv / vol : NaN;
}

export const liveBotSolVwap = schedules.task({
  id:          "live-bot-sol-vwap",
  cron:        "*/1 * * * *",
  maxDuration: 55,

  run: async () => {
    const log: object[] = [];

    let state;
    try {
      state = await getSolVwapLiveState();
    } catch (err) {
      await logSolVwapLiveRun({ actions: [{ action: "ERROR", stage: "state", error: String(err) }] });
      return { ok: false };
    }
    if (!state.enabled) return { ok: false, reason: "disabled" };

    try {
      const [raw5, livePrice, book] = await Promise.all([
        getKlinesGlobal(SYMBOL, "5m", C5_LIMIT),
        getPriceGlobal(SYMBOL),
        getBookTickerGlobal(SYMBOL),
      ]);
      const nowMs = Date.now();

      const c5: Candle[] = raw5.slice(0, -1).map((c: any) => ({ time: c.time, close: c.close, volume: c.volume }));
      const lastCandleTs = c5[c5.length - 1].time;
      const vwap = calcRollingVWAP(c5);
      const lastClose = c5[c5.length - 1].close;
      const favorable = !isNaN(vwap) && lastClose < vwap;
      const isNewCandle = lastCandleTs > (state.last_candle_ts ?? 0);

      log.push({ action: "CHECK", mode: state.mode, price: livePrice, vwap: vwap.toFixed(4), favorable });

      if (isNewCandle) {
        await updateSolVwapLiveState({ last_candle_ts: lastCandleTs });
        state = await getSolVwapLiveState();
      }

      // ── Pending maker buy: check fill, or reprice every tick ────────────────
      if (state.mode === "USD" && state.buy_order_id) {
        const order = await getOrderGlobal(SYMBOL, state.buy_order_id);

        if (order.status === "FILLED") {
          const fillPrice = parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty);
          const solQty    = parseFloat(order.executedQty);
          const usdSpent  = parseFloat(order.cummulativeQuoteQty);

          const tp      = round2(fillPrice * (1 + TP_PCT / 100));
          const slStop  = round2(fillPrice * (1 - SL_PCT / 100));
          const slLimit = round2(slStop * (1 - SL_BUFFER_PCT / 100));

          if (livePrice <= slStop || livePrice >= tp) {
            const exitOrder = await placeMarketSellSol(SYMBOL, solQty);
            const grossOut  = parseFloat(exitOrder.cummulativeQuoteQty);
            const exitPrice = grossOut / parseFloat(exitOrder.executedQty);
            const { netProceeds: usdOut } = await getNetSellProceeds(SYMBOL, exitOrder.orderId, QUOTE_ASSET, grossOut);
            const pnlUsd = usdOut - usdSpent;
            const pnlPct = (pnlUsd / usdSpent) * 100;

            await updateSolVwapLiveState({
              mode: "USD", sol_quantity: null, entry_price: null, entry_time: null,
              usd_balance: usdOut, buy_order_id: null,
              oco_order_list_id: null, oco_tp_order_id: null, oco_sl_order_id: null,
              exit_order_id: null, chase_attempts: 0,
            });
            await recordSolVwapLiveTrade({
              entry_price: fillPrice, exit_price: exitPrice, sol_quantity: solQty,
              usd_in: usdSpent, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct,
              exit_reason: livePrice <= slStop ? "SL" : "TP", entry_time: new Date(order.time).toISOString(),
            });
            log.push({ action: "IMMEDIATE_EXIT", reason: livePrice <= slStop ? "SL" : "TP", price: exitPrice, pnlUsd: pnlUsd.toFixed(2) });
            state = await getSolVwapLiveState();

          } else {
            try {
              const oco = await placeOcoSellSol(SYMBOL, solQty, tp, slStop, slLimit);
              const tpLeg = oco.orderReports.find(r => r.type === "LIMIT_MAKER" || r.type === "LIMIT");
              const slLeg = oco.orderReports.find(r => r.type === "STOP_LOSS_LIMIT");

              await updateSolVwapLiveState({
                mode: "SOL", sol_quantity: solQty, entry_price: fillPrice, entry_time: new Date().toISOString(),
                usd_balance: 0, buy_order_id: null,
                oco_order_list_id: oco.orderListId, oco_tp_order_id: tpLeg?.orderId ?? null, oco_sl_order_id: slLeg?.orderId ?? null,
                exit_order_id: null, chase_attempts: 0,
              });
              log.push({ action: "OCO_PLACED", tp, slStop, slLimit, orderListId: oco.orderListId });
              state = await getSolVwapLiveState();

            } catch (err) {
              const exitOrder = await placeMarketSellSol(SYMBOL, solQty);
              const grossOut  = parseFloat(exitOrder.cummulativeQuoteQty);
              const exitPrice = grossOut / parseFloat(exitOrder.executedQty);
              const { netProceeds: usdOut } = await getNetSellProceeds(SYMBOL, exitOrder.orderId, QUOTE_ASSET, grossOut);
              const pnlUsd = usdOut - usdSpent;
              const pnlPct = (pnlUsd / usdSpent) * 100;

              await updateSolVwapLiveState({
                mode: "USD", sol_quantity: null, entry_price: null, entry_time: null,
                usd_balance: usdOut, buy_order_id: null,
                oco_order_list_id: null, oco_tp_order_id: null, oco_sl_order_id: null,
                exit_order_id: null, chase_attempts: 0,
              });
              await recordSolVwapLiveTrade({
                entry_price: fillPrice, exit_price: exitPrice, sol_quantity: solQty,
                usd_in: usdSpent, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct,
                exit_reason: pnlUsd >= 0 ? "TP" : "SL", entry_time: new Date(order.time).toISOString(),
              });
              log.push({ action: "OCO_REJECTED_MARKET_EXIT", error: String(err), price: exitPrice, pnlUsd: pnlUsd.toFixed(2) });
              state = await getSolVwapLiveState();
            }
          }

        } else if (order.status === "CANCELED" || order.status === "EXPIRED" || order.status === "REJECTED") {
          await updateSolVwapLiveState({ buy_order_id: null });
          log.push({ action: "BUY_CANCELED", status: order.status });
          state = await getSolVwapLiveState();

        } else {
          try { await cancelOrderGlobal(SYMBOL, state.buy_order_id); } catch { /* may already be filled/gone */ }
          await updateSolVwapLiveState({ buy_order_id: null });
          log.push({ action: "BUY_REPRICE" });
          state = await getSolVwapLiveState();
        }
      }

      // ── Open OCO position: TP/SL fill or phantom-stop chase ────────────────
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

          await updateSolVwapLiveState({
            mode: "USD", sol_quantity: null, entry_price: null, entry_time: null,
            usd_balance: usdOut,
            oco_order_list_id: null, oco_tp_order_id: null, oco_sl_order_id: null,
            exit_order_id: null, chase_attempts: 0,
          });
          await recordSolVwapLiveTrade({
            entry_price: state.entry_price!, exit_price: exitPrice, sol_quantity: state.sol_quantity!,
            usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct,
            exit_reason: reason, entry_time: state.entry_time!,
          });
          log.push({ action: "OCO_FILLED", reason, price: exitPrice, pnlUsd: pnlUsd.toFixed(2), pnlPct: pnlPct.toFixed(2) });
          state = await getSolVwapLiveState();

        } else {
          const restingSlPrice = state.oco_sl_order_id ? parseFloat((await getOrderGlobal(SYMBOL, state.oco_sl_order_id)).price) : null;
          const phantom = restingSlPrice !== null && livePrice <= restingSlPrice * (1 - STUCK_STOP_PCT / 100);

          if (phantom) {
            try { await cancelOrderGlobal(SYMBOL, state.oco_sl_order_id!); } catch { /* cancelling one leg cancels the pair */ }
            const freshBook = await getBookTickerGlobal(SYMBOL);
            const price = round2(freshBook.ask);
            const newOrder = await placeLimitMakerSellSol(SYMBOL, state.sol_quantity!, price);
            await updateSolVwapLiveState({
              oco_order_list_id: null, oco_tp_order_id: null, oco_sl_order_id: null,
              exit_order_id: newOrder.orderId, chase_attempts: 0,
            });
            log.push({ action: "PHANTOM_STOP_CHASE_START", price });
            state = await getSolVwapLiveState();
          } else {
            log.push({ action: "OCO_OPEN", tp: state.oco_tp_order_id, sl: state.oco_sl_order_id });
          }
        }
      }

      // ── Pending fallback exit (post-cancel maker sell from a phantom-SL chase) ──
      if (state.mode === "SOL" && state.exit_order_id) {
        const order = await getOrderGlobal(SYMBOL, state.exit_order_id);

        if (order.status === "FILLED") {
          const grossOut = parseFloat(order.cummulativeQuoteQty);
          const exitPrice = grossOut / parseFloat(order.executedQty);
          const usdOut = (await getNetSellProceeds(SYMBOL, order.orderId, QUOTE_ASSET, grossOut)).netProceeds;
          const usdIn  = state.entry_price! * state.sol_quantity!;
          const pnlUsd = usdOut - usdIn;
          const pnlPct = (pnlUsd / usdIn) * 100;

          await updateSolVwapLiveState({
            mode: "USD", sol_quantity: null, entry_price: null, entry_time: null,
            usd_balance: usdOut, exit_order_id: null, chase_attempts: 0,
          });
          await recordSolVwapLiveTrade({
            entry_price: state.entry_price!, exit_price: exitPrice, sol_quantity: state.sol_quantity!,
            usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct,
            exit_reason: "SL", entry_time: state.entry_time!,
          });
          log.push({ action: "CHASE_FILLED", price: exitPrice, pnlUsd: pnlUsd.toFixed(2), pnlPct: pnlPct.toFixed(2) });
          state = await getSolVwapLiveState();

        } else if ((state.chase_attempts ?? 0) >= MAX_CHASE_ATTEMPTS) {
          const exitOrder = await placeMarketSellSol(SYMBOL, state.sol_quantity!);
          const grossOut  = parseFloat(exitOrder.cummulativeQuoteQty);
          const exitPrice = grossOut / parseFloat(exitOrder.executedQty);
          const usdOut = (await getNetSellProceeds(SYMBOL, exitOrder.orderId, QUOTE_ASSET, grossOut)).netProceeds;
          const usdIn  = state.entry_price! * state.sol_quantity!;
          const pnlUsd = usdOut - usdIn;
          const pnlPct = (pnlUsd / usdIn) * 100;

          await updateSolVwapLiveState({
            mode: "USD", sol_quantity: null, entry_price: null, entry_time: null,
            usd_balance: usdOut, exit_order_id: null, chase_attempts: 0,
          });
          await recordSolVwapLiveTrade({
            entry_price: state.entry_price!, exit_price: exitPrice, sol_quantity: state.sol_quantity!,
            usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct,
            exit_reason: "SL", entry_time: state.entry_time!,
          });
          log.push({ action: "MARKET_FALLBACK_EXIT", price: exitPrice, pnlUsd: pnlUsd.toFixed(2) });
          state = await getSolVwapLiveState();

        } else {
          try { await cancelOrderGlobal(SYMBOL, state.exit_order_id); } catch { /* may already be gone */ }
          const freshBook = await getBookTickerGlobal(SYMBOL);
          const price = round2(freshBook.ask);
          const newOrder = await placeLimitMakerSellSol(SYMBOL, state.sol_quantity!, price);
          await updateSolVwapLiveState({ exit_order_id: newOrder.orderId, chase_attempts: (state.chase_attempts ?? 0) + 1 });
          log.push({ action: "CHASE_DOWN", to: price, attempt: (state.chase_attempts ?? 0) + 1 });
          state = await getSolVwapLiveState();
        }
      }

      // ── Entry: flat, signal favorable on a fresh candle → place a maker buy ──
      if (state.mode === "USD" && !state.buy_order_id && isNewCandle && favorable) {
        const usdFree    = await getFreeBalanceGlobal(QUOTE_ASSET);
        const targetPool = SEED_USD + (state.realized_pnl_usd ?? 0);
        const buyAmount  = Math.max(0, Math.min(usdFree, targetPool));

        if (buyAmount >= MIN_NOTIONAL) {
          const price = round2(book.bid);
          const qty   = buyAmount / price;
          const order = await placeLimitMakerBuySol(SYMBOL, qty, price);
          await updateSolVwapLiveState({ buy_order_id: order.orderId });
          log.push({ action: "START_BUY", price, qty, buyAmount, vwap: vwap.toFixed(4) });
        } else {
          log.push({ action: "SKIP_BUY", reason: "below_min_notional", buyAmount });
        }
      }

    } catch (err) {
      log.push({ action: "ERROR", stage: "trading", error: String(err) });
    }

    await logSolVwapLiveRun({ actions: log });
    return { ok: true, actions: log };
  },
});
