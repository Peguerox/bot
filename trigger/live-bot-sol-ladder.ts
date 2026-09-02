// Live bot — SOL/FDUSD "ladder" TP on Binance Global. REAL MONEY, $20 hard cap (no compounding,
// same discipline as the OCO bots — deliberately small while this strategy is being tested).
// Explicit user design (2026-09-01):
//
// Entry : same proven mechanism as live-bot-sol-trail.ts — maker buy, reprice-on-drift while
//         resting, 60s cooldown after any exit (TP or SL) before re-entering.
// Exit  : a real OCO (TP + SL) placed the moment entry fills. TP is fixed at +1.0% (the "actual"
//         take-profit) for the life of the trade. SL starts at -0.05% below entry — NOT trailed
//         continuously. Instead, price has to cross a series of 0.1%-spaced profit checkpoints
//         (+0.2%, +0.3%, ... +0.9%) before the SL moves at all; each checkpoint crossed ratchets
//         the SL up to (checkpoint - 0.05%) locked profit — a fixed 0.05% gap behind whichever
//         checkpoint was just hit. Reaching +1.0% is the real exit (TP fill), not another
//         checkpoint. Ratcheting re-places the whole OCO (same TP, new SL) since cancelling one
//         OCO leg cancels the pair — same pattern as live-bot-sol-oco.ts's chase-down fix.
// Chase : while holding, each run opens a ~40s WebSocket burst (real trade ticks) — same
//         mechanism as live-bot-sol-trail.ts — used for two things: (1) detecting checkpoint
//         crossings at tick resolution instead of once a minute, since checkpoints are only
//         0.1% apart and price can cross more than one within a minute; (2) if the SL has
//         actually triggered (price crossed the currently-locked stop) but the resting order
//         hasn't filled — a "phantom stop" — chase it down as a maker: repeated LIMIT_MAKER
//         re-places toward the market, structurally cannot cross the book, for up to
//         MAX_EXIT_REPRICE_ATTEMPTS before falling back to a real market order.
// Fees  : SL leg has no taker-guaranteeing buffer (limit = stop exactly). PnL is tracked net of
//         real commission via getNetSellProceeds, not raw gross proceeds.
import { schedules } from "@trigger.dev/sdk/v3";
import {
  getPriceGlobal, getBookTickerGlobal, getFreeBalanceGlobal, getOrderGlobal, cancelOrderGlobal,
  placeLimitMakerBuySol, placeLimitMakerSellSol, placeOcoSellSol, placeMarketSellSol, getNetSellProceeds,
} from "../lib/binance-global";
import {
  getSolLadderState, updateSolLadderState, recordSolLadderTrade, logSolLadderRun, getLastLadderExitTime,
  type SolLadderState,
} from "../lib/sol-ladder-db";
import WebSocket from "ws";

const SYMBOL          = "SOLFDUSD";
const QUOTE_ASSET     = "FDUSD";
const INITIAL_SL_PCT  = 0.05;  // stop distance below entry before the first checkpoint is hit
const FINAL_TP_PCT    = 1.0;   // the actual take-profit — fixed for the life of the trade
const LOCK_GAP_PCT    = 0.05;  // fixed gap behind whichever checkpoint was just crossed
const CHECKPOINTS     = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]; // profit % that ratchet the SL
const STUCK_STOP_PCT  = 0.02;  // if price is this far past the SL trigger with no fill, treat as phantom
const MAX_EXIT_REPRICE_ATTEMPTS = 5; // chase-down-as-maker attempts before falling back to market
const SEED_USD        = 20;    // hard cap — never spend more than this, ever
const MIN_NOTIONAL    = 5;     // SOLFDUSD exchange minimum is $5 notional
const CANDLE_MS       = 1 * 60 * 1000;
const CHASE_MS        = 40 * 1000; // WebSocket burst length — same margin reasoning as live-bot-sol-trail.ts
const FILL_CHECK_MS   = 5000;
const CHASE_START_CUTOFF_MS = 5000;  // only start a fresh chase burst if the run just started
const POLL_START_CUTOFF_MS  = 10000;
const REENTRY_COOLDOWN_MS   = 60 * 1000; // wait a minute after any exit (TP or SL) before re-entering
const REPRICE_DRIFT_PCT     = 0.02;

function round2(p: number): number { return Math.round(p * 100) / 100; }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// Given how many checkpoints have been crossed (idx = count crossed, 0 if none yet), the locked
// SL level as a % gain from entry. idx=0 means still on the initial (unlocked) stop.
function lockedPctForIdx(idx: number): number {
  if (idx <= 0) return -INITIAL_SL_PCT;
  return CHECKPOINTS[idx - 1] - LOCK_GAP_PCT;
}

// IDEA, NOT YET IMPLEMENTED (2026-09-01): price the entry buy at 2 cents below the ask (rather
// than exactly at the bid) when there's room for it, to jump queue position without risking a
// cross — SOLFDUSD's real spread is often only ~1 cent, so this needs a max(bid, ask - 0.02)
// guard rather than a blind offset. Discussed, explicitly not built yet — user said "annotate",
// not implement.

// Same drift-aware reprice loop as live-bot-sol-trail.ts.
async function pollAndRepriceBuy(initialOrderId: number, qty: number, attempts = 8, delayMs = 5000) {
  let orderId = initialOrderId;
  for (let i = 0; i < attempts; i++) {
    const order = await getOrderGlobal(SYMBOL, orderId);
    if (order.status === "FILLED" || order.status === "CANCELED" || order.status === "EXPIRED" || order.status === "REJECTED") {
      return { order, orderId };
    }
    const restingPrice = parseFloat(order.price);
    const book = await getBookTickerGlobal(SYMBOL);
    if (book.bid > restingPrice * (1 + REPRICE_DRIFT_PCT / 100)) {
      try { await cancelOrderGlobal(SYMBOL, orderId); } catch { /* may have just filled */ }
      const check = await getOrderGlobal(SYMBOL, orderId);
      if (check.status === "FILLED") return { order: check, orderId };
      const newPrice = round2(book.bid);
      const newOrder = await placeLimitMakerBuySol(SYMBOL, qty, newPrice);
      await updateSolLadderState({ buy_order_id: newOrder.orderId });
      orderId = newOrder.orderId;
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  return { order: null, orderId };
}

export const liveBotSolLadder = schedules.task({
  id:          "live-bot-sol-ladder-1m",
  cron:        "*/1 * * * *",
  maxDuration: 55,

  run: async () => {
    const log: object[] = [];

    async function placeInitialOcoOrExit(fillPrice: number, solQty: number, livePrice: number) {
      const tp     = round2(fillPrice * (1 + FINAL_TP_PCT / 100));
      const slStop = round2(fillPrice * (1 - INITIAL_SL_PCT / 100));
      log.push({ action: "BUY_FILLED", price: fillPrice, qty: solQty });

      if (livePrice <= slStop || livePrice >= tp) {
        await marketExitFlat(fillPrice, solQty, "band_already_breached");
        return;
      }

      try {
        const oco = await placeOcoSellSol(SYMBOL, solQty, tp, slStop, slStop);
        const tpLeg = oco.orderReports.find(r => r.type === "LIMIT_MAKER" || r.type === "LIMIT");
        const slLeg = oco.orderReports.find(r => r.type === "STOP_LOSS_LIMIT");
        await updateSolLadderState({
          mode: "SOL", sol_quantity: solQty, entry_price: fillPrice, entry_time: new Date().toISOString(),
          usd_balance: 0, buy_order_id: null,
          oco_order_list_id: oco.orderListId, oco_tp_order_id: tpLeg?.orderId ?? null, oco_sl_order_id: slLeg?.orderId ?? null,
          next_checkpoint_idx: 0, sl_chase_attempts: 0,
        });
        log.push({ action: "OCO_PLACED", tp, slStop, orderListId: oco.orderListId });
      } catch (err) {
        await marketExitFlat(fillPrice, solQty, String(err));
      }
    }

    // Used only when a position must be closed before any OCO/chase order exists yet.
    async function marketExitFlat(fillPrice: number, solQty: number, reason: string) {
      const exitOrder = await placeMarketSellSol(SYMBOL, solQty);
      const grossOut   = parseFloat(exitOrder.cummulativeQuoteQty);
      const exitPrice  = grossOut / parseFloat(exitOrder.executedQty);
      const { netProceeds: usdOut } = await getNetSellProceeds(SYMBOL, exitOrder.orderId, QUOTE_ASSET, grossOut);
      const usdIn      = fillPrice * solQty;
      const pnlUsd      = usdOut - usdIn;
      const pnlPct      = (pnlUsd / usdIn) * 100;

      await updateSolLadderState({
        mode: "USD", sol_quantity: null, entry_price: null, entry_time: null,
        usd_balance: usdOut, buy_order_id: null, oco_order_list_id: null, oco_tp_order_id: null, oco_sl_order_id: null,
        next_checkpoint_idx: 0, sl_chase_attempts: 0,
      });
      await recordSolLadderTrade({
        entry_price: fillPrice, exit_price: exitPrice, sol_quantity: solQty,
        usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct,
        entry_time: new Date().toISOString(), exit_reason: pnlUsd >= 0 ? "TP" : "SL",
      });
      log.push({ action: "EMERGENCY_MARKET_EXIT", reason, price: exitPrice, pnlUsd: pnlUsd.toFixed(2) });
    }

    async function recordExit(
      order: { orderId: number; cummulativeQuoteQty: string; executedQty: string }, state: SolLadderState, reason: "TP" | "SL",
    ) {
      const grossOut   = parseFloat(order.cummulativeQuoteQty);
      const exitPrice  = grossOut / parseFloat(order.executedQty);
      const { netProceeds: usdOut } = await getNetSellProceeds(SYMBOL, order.orderId, QUOTE_ASSET, grossOut);
      const usdIn      = state.entry_price! * state.sol_quantity!;
      const pnlUsd      = usdOut - usdIn;
      const pnlPct      = (pnlUsd / usdIn) * 100;

      await updateSolLadderState({
        mode: "USD", sol_quantity: null, entry_price: null, entry_time: null,
        usd_balance: usdOut, oco_order_list_id: null, oco_tp_order_id: null, oco_sl_order_id: null,
        next_checkpoint_idx: 0, sl_chase_attempts: 0,
      });
      await recordSolLadderTrade({
        entry_price: state.entry_price!, exit_price: exitPrice, sol_quantity: state.sol_quantity!,
        usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct, entry_time: state.entry_time!, exit_reason: reason,
      });
      log.push({ action: reason === "TP" ? "TP_FILLED" : "SL_FILLED", price: exitPrice, pnlUsd: pnlUsd.toFixed(2), pnlPct: pnlPct.toFixed(2) });
      return getSolLadderState();
    }

    async function emergencyMarketExit(state: SolLadderState, reason: unknown): Promise<SolLadderState> {
      const exitOrder = await placeMarketSellSol(SYMBOL, state.sol_quantity!);
      const grossOut   = parseFloat(exitOrder.cummulativeQuoteQty);
      const exitPrice  = grossOut / parseFloat(exitOrder.executedQty);
      const { netProceeds: usdOut } = await getNetSellProceeds(SYMBOL, exitOrder.orderId, QUOTE_ASSET, grossOut);
      const usdIn      = state.entry_price! * state.sol_quantity!;
      const pnlUsd      = usdOut - usdIn;
      const pnlPct      = (pnlUsd / usdIn) * 100;

      await updateSolLadderState({
        mode: "USD", sol_quantity: null, entry_price: null, entry_time: null,
        usd_balance: usdOut, oco_order_list_id: null, oco_tp_order_id: null, oco_sl_order_id: null,
        next_checkpoint_idx: 0, sl_chase_attempts: 0,
      });
      await recordSolLadderTrade({
        entry_price: state.entry_price!, exit_price: exitPrice, sol_quantity: state.sol_quantity!,
        usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct, entry_time: state.entry_time!,
        exit_reason: pnlUsd >= 0 ? "TP" : "SL",
      });
      log.push({ action: "EMERGENCY_MARKET_EXIT", reason: String(reason), price: exitPrice, pnlUsd: pnlUsd.toFixed(2) });
      return getSolLadderState();
    }

    // Continuous WS chase burst while holding — same mechanism as live-bot-sol-trail.ts. Handles
    // BOTH checkpoint ratcheting (tick resolution, since checkpoints are only 0.1% apart) and
    // phantom-stop chase-down-as-maker, in one serial queue so nothing races itself.
    async function chasePosition(startState: SolLadderState): Promise<SolLadderState> {
      let state = startState;
      let queue: Promise<void> = Promise.resolve();
      let lastTickPrice = startState.entry_price ?? 0;
      let exitRepriceAttempts = 0;

      log.push({ action: "CHASE_START", checkpointIdx: state.next_checkpoint_idx });

      await new Promise<void>((resolve) => {
        const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${SYMBOL.toLowerCase()}@trade`);
        const endTimer = setTimeout(() => { try { ws.close(); } catch { /* already closed */ } }, CHASE_MS);

        const fillCheck = setInterval(() => {
          queue = queue.then(async () => {
            if (state.mode !== "SOL" || !state.oco_sl_order_id) return;

            if (state.oco_tp_order_id) {
              const tpOrder = await getOrderGlobal(SYMBOL, state.oco_tp_order_id);
              if (tpOrder.status === "FILLED") {
                state = await recordExit(tpOrder, state, "TP");
                try { ws.close(); } catch { /* already closed */ }
                return;
              }
            }
            const slOrder = await getOrderGlobal(SYMBOL, state.oco_sl_order_id);
            if (slOrder.status === "FILLED") {
              state = await recordExit(slOrder, state, "SL");
              try { ws.close(); } catch { /* already closed */ }
              return;
            }

            const lockedPct = lockedPctForIdx(state.next_checkpoint_idx);
            const stop = state.entry_price! * (1 + lockedPct / 100);
            if (!(lastTickPrice <= stop * (1 - STUCK_STOP_PCT / 100))) return;

            if (exitRepriceAttempts >= MAX_EXIT_REPRICE_ATTEMPTS) {
              try { await cancelOrderGlobal(SYMBOL, state.oco_sl_order_id); } catch { /* may already be gone */ }
              state = await emergencyMarketExit(state, "phantom_stop_max_reprice");
              try { ws.close(); } catch { /* already closed */ }
              return;
            }

            try {
              await cancelOrderGlobal(SYMBOL, state.oco_sl_order_id);
            } catch {
              const check = await getOrderGlobal(SYMBOL, state.oco_sl_order_id);
              if (check.status === "FILLED") {
                state = await recordExit(check, state, "SL");
                try { ws.close(); } catch { /* already closed */ }
              }
              return;
            }

            exitRepriceAttempts++;
            try {
              const freshBook = await getBookTickerGlobal(SYMBOL);
              const newPrice = round2(freshBook.ask);
              const newOrder = await placeLimitMakerSellSol(SYMBOL, state.sol_quantity!, newPrice);
              await updateSolLadderState({ oco_sl_order_id: newOrder.orderId, oco_tp_order_id: null });
              log.push({ action: "CHASE_DOWN", to: newPrice, attempt: exitRepriceAttempts });
              state = { ...state, oco_sl_order_id: newOrder.orderId, oco_tp_order_id: null };
            } catch (err) {
              state = await emergencyMarketExit(state, err);
              try { ws.close(); } catch { /* already closed */ }
            }
          }).catch((err) => log.push({ action: "ERROR", stage: "fill_check", error: String(err) }));
        }, FILL_CHECK_MS);

        ws.on("message", (raw: Buffer) => {
          let price: number;
          try {
            const msg = JSON.parse(raw.toString());
            price = parseFloat(msg.p);
            if (!price || isNaN(price)) return;
          } catch { return; }
          lastTickPrice = price;

          queue = queue.then(async () => {
            if (state.mode !== "SOL" || !state.oco_sl_order_id || !state.entry_price) return;

            const gainPct = (price - state.entry_price) / state.entry_price * 100;
            let idx = state.next_checkpoint_idx;
            while (idx < CHECKPOINTS.length && gainPct >= CHECKPOINTS[idx]) idx++;
            if (idx === state.next_checkpoint_idx) return; // no new checkpoint crossed

            const newLockedPct = lockedPctForIdx(idx);
            const newStop = round2(state.entry_price * (1 + newLockedPct / 100));

            try {
              await cancelOrderGlobal(SYMBOL, state.oco_sl_order_id);
            } catch {
              const check = await getOrderGlobal(SYMBOL, state.oco_sl_order_id);
              if (check.status === "FILLED") {
                state = await recordExit(check, state, "SL");
                try { ws.close(); } catch { /* already closed */ }
              } else {
                log.push({ action: "RATCHET_FAILED", error: "cancel failed, OCO still open" });
              }
              return;
            }

            // Old OCO is now gone — genuinely unprotected until the new one lands. If placement
            // fails too (price already breached it), exit at market immediately instead of
            // retrying and leaving the position exposed.
            try {
              const tp = round2(state.entry_price * (1 + FINAL_TP_PCT / 100));
              const oco = await placeOcoSellSol(SYMBOL, state.sol_quantity!, tp, newStop, newStop);
              const tpLeg = oco.orderReports.find(r => r.type === "LIMIT_MAKER" || r.type === "LIMIT");
              const slLeg = oco.orderReports.find(r => r.type === "STOP_LOSS_LIMIT");
              await updateSolLadderState({
                oco_order_list_id: oco.orderListId, oco_tp_order_id: tpLeg?.orderId ?? null, oco_sl_order_id: slLeg?.orderId ?? null,
                next_checkpoint_idx: idx,
              });
              log.push({ action: "RATCHET_UP", checkpointIdx: idx, lockedPct: newLockedPct, newStop });
              state = { ...state, oco_order_list_id: oco.orderListId, oco_tp_order_id: tpLeg?.orderId ?? null, oco_sl_order_id: slLeg?.orderId ?? null, next_checkpoint_idx: idx };
            } catch (err) {
              state = await emergencyMarketExit(state, err);
              try { ws.close(); } catch { /* already closed */ }
            }
          }).catch((err) => log.push({ action: "ERROR", stage: "chase", error: String(err) }));
        });

        ws.on("error", (err) => log.push({ action: "WS_ERROR", error: String(err) }));
        ws.on("close", () => {
          clearTimeout(endTimer);
          clearInterval(fillCheck);
          queue.finally(resolve);
        });
      });

      log.push({ action: "CHASE_END", checkpointIdx: state.next_checkpoint_idx });
      return state;
    }

    let state;
    try {
      state = await getSolLadderState();
    } catch (err) {
      await logSolLadderRun({ actions: [{ action: "ERROR", stage: "state", error: String(err) }] });
      return { ok: false };
    }
    if (!state.enabled) return { ok: false, reason: "disabled" };

    const runStartMs = Date.now();

    try {
      const [livePrice, book] = await Promise.all([getPriceGlobal(SYMBOL), getBookTickerGlobal(SYMBOL)]);
      const nowMs = Date.now();
      const candleTs = Math.floor(nowMs / CANDLE_MS) * CANDLE_MS;
      const isNewCandle = candleTs > (state.last_candle_ts ?? 0);

      log.push({ action: "CHECK", mode: state.mode, price: livePrice, bid: book.bid, ask: book.ask, checkpointIdx: state.next_checkpoint_idx });

      // ── Pending maker buy order ──
      if (state.mode === "USD" && state.buy_order_id) {
        const pendingOrder = await getOrderGlobal(SYMBOL, state.buy_order_id);
        const { order } = pendingOrder.status === "NEW" || pendingOrder.status === "PARTIALLY_FILLED"
          ? await pollAndRepriceBuy(state.buy_order_id, parseFloat(pendingOrder.origQty))
          : { order: pendingOrder };
        state = await getSolLadderState();

        if (order?.status === "FILLED") {
          const fillPrice = parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty);
          const solQty    = parseFloat(order.executedQty);
          const fresh = await getPriceGlobal(SYMBOL);
          await placeInitialOcoOrExit(fillPrice, solQty, fresh);
          state = await getSolLadderState();

        } else if (order && (order.status === "CANCELED" || order.status === "EXPIRED" || order.status === "REJECTED")) {
          await updateSolLadderState({ buy_order_id: null });
          log.push({ action: "BUY_CANCELED", status: order.status });
          state = await getSolLadderState();

        } else if (isNewCandle) {
          try { await cancelOrderGlobal(SYMBOL, state.buy_order_id); } catch { /* may already be filled/gone */ }
          await updateSolLadderState({ buy_order_id: null, last_candle_ts: candleTs });
          log.push({ action: "BUY_REPRICE_PENDING" });
          state = await getSolLadderState();

        } else {
          log.push({ action: "BUY_WAIT", orderId: state.buy_order_id });
        }
      }

      // ── Open position: chase the ladder with a ~40s WebSocket burst instead of a poll ──
      if (state.mode === "SOL" && state.oco_sl_order_id) {
        if (Date.now() - runStartMs < CHASE_START_CUTOFF_MS) {
          state = await chasePosition(state);
        } else {
          log.push({ action: "SKIP_CHASE", reason: "time_budget", elapsedMs: Date.now() - runStartMs });
        }
      }

      // ── Entry: flat, no pending order, cooldown elapsed → place a fresh maker buy ──
      if (state.mode === "USD" && !state.buy_order_id) {
        const lastExitTime = await getLastLadderExitTime();
        const msSinceExit  = lastExitTime ? Date.now() - new Date(lastExitTime).getTime() : Infinity;

        if (msSinceExit < REENTRY_COOLDOWN_MS) {
          log.push({ action: "COOLDOWN_WAIT", msSinceExit: Math.round(msSinceExit), cooldownMs: REENTRY_COOLDOWN_MS });

        } else {
          const usdFree    = await getFreeBalanceGlobal("FDUSD");
          const targetPool = SEED_USD + (state.realized_pnl_usd ?? 0);
          const buyAmount  = Math.min(SEED_USD, usdFree, targetPool);

          if (buyAmount >= MIN_NOTIONAL) {
            const freshBook = await getBookTickerGlobal(SYMBOL);
            const price = round2(freshBook.bid);
            const qty   = buyAmount / price;
            const order = await placeLimitMakerBuySol(SYMBOL, qty, price);
            await updateSolLadderState({ buy_order_id: order.orderId, last_candle_ts: candleTs });
            log.push({ action: "START_BUY", price, qty, buyAmount });

            if (Date.now() - runStartMs < POLL_START_CUTOFF_MS) {
              const { order: filled } = await pollAndRepriceBuy(order.orderId, qty);
              if (filled?.status === "FILLED") {
                const fillPrice = parseFloat(filled.cummulativeQuoteQty) / parseFloat(filled.executedQty);
                const solQty    = parseFloat(filled.executedQty);
                const fresh = await getPriceGlobal(SYMBOL);
                await placeInitialOcoOrExit(fillPrice, solQty, fresh);
              }
            } else {
              log.push({ action: "SKIP_FILL_POLL", reason: "time_budget", elapsedMs: Date.now() - runStartMs });
            }
          } else {
            log.push({ action: "SKIP_BUY", reason: "below_min_notional", buyAmount });
          }
        }
      }

    } catch (err) {
      log.push({ action: "ERROR", stage: "trading", error: String(err) });
    }

    await logSolLadderRun({ actions: log });
    return { ok: true, actions: log };
  },
});
