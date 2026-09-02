// Live bot — SOL/FDUSD trailing-stop-only on Binance Global. REAL MONEY, starts at $100, COMPOUNDS.
// Entry : every 1-min bar, unconditionally, as soon as flat — no re-entry cooldown (removed
//         2026-09-01 to match the paper Chase bot for a fair side-by-side test). LIMIT_MAKER buy,
//         priced at bestSafeBuyPrice (bid, improved toward the ask by up to BID_IMPROVEMENT_USD
//         when the spread allows it, never crossing). Polled every 5s while resting; if the
//         market runs more than REPRICE_DRIFT_PCT past our resting price, cancel and re-place at
//         the fresh bid immediately instead of waiting for the next candle.
// Exit  : NO take-profit. A single STOP_LOSS_LIMIT sell, 0.1% below the highest price seen since
//         entry, trailed up on every new-high tick (continuous, matching the paper Chase bot —
//         the 0.03%-step version tested earlier was backtested roughly a wash, this is a direct
//         side-by-side test instead of a guess). While holding, each run opens a ~45s WebSocket
//         burst (real trade ticks) instead of a single poll. If the stop looks stuck (triggered
//         but not filled), chase it down as a maker — repeated LIMIT_MAKER re-places toward the
//         market, structurally unable to cross — for up to MAX_EXIT_REPRICE_ATTEMPTS before
//         falling back to a true market order as the last-resort backstop.
// Backtested (fixed $5000/trade, no compounding, no fees, 2yr): avg $1,695/week, 101/103
// weeks positive (98.1%), worst week -$74.90 — see conversation history for full comparison
// against the capped-TP no-filter and VWAP-armed strategies (this one dominated both).
//
// SIZING: unlike live-bot-sol-oco.ts (hard-capped at a fixed $ amount, deliberately left as-is),
// this bot COMPOUNDS — buy size is min(real free FDUSD balance, $100 seed + all-time realized
// PnL), so it grows with wins and shrinks with losses instead of staying fixed forever.
//
// SAFETY: every place-a-stop step (initial stop after fill, and each trail-up re-place) can be
// rejected by Binance with -2010 if price already moved past the intended level before the
// order landed (real incident: 2026-09-01, position sat unprotected until a manual market-sell).
// Every such placement is wrapped — on rejection, exit at market immediately instead of leaving
// the position with zero protection.
//
// FEES (2026-09-01): the stop-limit's limit leg used to sit a small buffer below the trigger
// "so it has a real chance to fill during a fast move" — but that buffer guarantees the order
// crosses the book the instant it triggers, so it fills as TAKER every single time (confirmed
// on real fills: 0/41 recent sells were maker). On a strategy whose entire edge is a 0.1% band,
// a guaranteed 0.1% taker fee on every exit was eating the edge outright. The buffer is now
// removed (limit = stop price exactly) so a normal trigger rests and fills as maker (free) — the
// periodic fill-check below now also watches for a stop that *should* have triggered but hasn't
// filled (a "phantom stop"). Instead of jumping straight to a market (taker) exit, it first
// chases the price down as a maker via repeated LIMIT_MAKER re-places (structurally cannot cross
// the book), and only falls back to a market order once MAX_EXIT_REPRICE_ATTEMPTS is exhausted —
// a real backstop for a genuine fast crash, not the default path.
//
// Also: PnL tracking used to use the order's cummulativeQuoteQty directly as "USD out" — that's
// GROSS proceeds before commission, not what actually lands in the account. Every exit now nets
// out the real commission via getNetSellProceeds so the tracked numbers match the real balance.
//
// CHASE ARCHITECTURE (2026-09-01): the in-position monitoring was upgraded from a single price
// poll (later two, 27s apart) to a ~50s WebSocket burst of real trade ticks, same mechanism
// already proven on the paper "SOL Trail Chase" bot — see BOT_BUGS_CHECKLIST.md for why that
// bot went through a long-lived-session design first and had to be rebuilt: every run here stays
// short and self-contained (well under the 55s maxDuration), so there's no cross-invocation
// session state and nothing that can race between runs, the same property that made the simple
// polling version safe. The one thing this version does that the paper bot didn't: it manages a
// REAL resting stop order, not a simulated one, so trailing up means actually cancelling and
// re-placing on the exchange, with the same -2010-rejection→market-exit fallback as before.
import { schedules } from "@trigger.dev/sdk/v3";
import {
  getPriceGlobal, getBookTickerGlobal, getFreeBalanceGlobal, getOrderGlobal, cancelOrderGlobal,
  placeLimitMakerBuySol, placeLimitMakerSellSol, placeStopLimitSellSol, placeMarketSellSol, getNetSellProceeds,
} from "../lib/binance-global";
import {
  getSolTrailState, updateSolTrailState, recordSolTrailTrade, logSolTrailRun,
  type SolTrailState,
} from "../lib/sol-trail-db";
import WebSocket from "ws";

const SYMBOL          = "SOLFDUSD";
const QUOTE_ASSET     = "FDUSD";
const SL_PCT          = 0.05; // was 0.1 — real losses consistently landed worse than the target
                               // (chase-down/market-exit slippage during fast moves), so the real
                               // average loss was already running bigger than a clean 0.1% would
                               // be. Tightening the target to try to land closer to what paper's
                               // frictionless 0.1% actually produces.
const SL_BUFFER_PCT   = 0;    // was 0.05 — guaranteed a taker fill every time, see FEES note above
const STUCK_STOP_PCT  = 0.02; // if price is this far past the stop with no fill, treat as phantom
const MAX_EXIT_REPRICE_ATTEMPTS = 5; // chase-down-as-maker attempts before falling back to market
const SEED_USD        = 100;  // starting size — compounds from here, not a ceiling
const MIN_NOTIONAL    = 5;    // SOLFDUSD exchange minimum is $5 notional
const CANDLE_MS       = 1 * 60 * 1000;
const CHASE_MS        = 45 * 1000; // WebSocket burst length — was 50s, real prod data (2026-09-01)
                                    // showed chase-alone runs consistently hitting 40-56s once you
                                    // add real overhead (state fetch, WS connect, DB writes, final
                                    // log write), causing runs to TIME_OUT past the 55s maxDuration
                                    // and cascade-queue behind each other (every run started ~30s
                                    // late, gated on the prior run finishing). Shrunk to 40s to fix
                                    // that, then back up to 45s once real prod data showed 40s left
                                    // more margin than needed (worst observed overhead was ~5.8s,
                                    // so 45s still leaves ~4s of margin under the 55s cap) — closer
                                    // to the paper Chase bot's 50s for a fairer side-by-side test.
const FILL_CHECK_MS   = 5000;      // periodic real-order-status check during the burst

// RELIABILITY (2026-09-01): a run can legitimately hit two slow phases in sequence — a chase
// burst (up to 50s) that closes the position, immediately followed by a fresh entry that then
// polls for its fill (up to another 40s). Chained together that's up to ~90s, well past the 55s
// maxDuration — real incident: the run got killed mid-flight after already placing live orders,
// leaving no log of what happened and the new position briefly without a stop until the next
// tick noticed. Each slow phase below now checks how much of the run's budget is already spent
// and skips itself (deferring to the next 1-min tick) rather than risk compounding past the cap.
// Safe to defer either way: a resting stop already protects an open position regardless of
// whether this tick's chase runs, and a resting buy has nothing to protect yet.
const CHASE_START_CUTOFF_MS = 5000;  // only start a fresh ~50s chase burst if the run just started
const POLL_START_CUTOFF_MS  = 10000; // only start the ~40s fill-poll if there's still room for it

// RE-ENTRY COOLDOWN: removed (2026-09-01) — the paper Chase bot re-enters immediately on the
// very next candle after every exit and that's working well for it over a real, large sample
// (194 trades). Re-entering immediately after a stop-loss risks catching more of the same drop,
// but the data doesn't support that costing more than it gains — testing without it, matching
// paper exactly, to see head-to-head which behavior actually wins.

// TRAIL STEP: removed (2026-09-01) — was gating trail-up moves to every 0.03% of new-high instead
// of every tick, to cut cancel/replace churn. Reverting to continuous (trail on every new-high
// tick, like the paper Chase bot) — backtested roughly a wash either way, so testing the exact
// same logic as paper for a fair side-by-side comparison rather than guessing which is better.

// ENTRY REPRICE DRIFT (2026-09-01, "can we improve the entry?"): a resting maker buy used to only
// get repriced once a full new candle had started — up to ~60s of sitting stale while price ran
// away, which is the main reason live entries lagged backtest on winning moves. Now, while
// actively polling a resting buy, if the market has moved this far past our resting price, cancel
// and re-place at the fresh bid immediately instead of waiting for the next candle.
const REPRICE_DRIFT_PCT = 0.02;

// BID IMPROVEMENT (2026-09-01, explicit user request): joining the bid exactly means waiting for
// a seller to come all the way down to us — during a fast move that can take a while, which is
// most of the "entry lag" cost measured earlier. SOLFDUSD's real spread is often only ~1 cent, so
// a blind fixed offset risks landing at or past the ask (rejected, or a taker cross) exactly when
// it matters most. Instead, improve the bid by BID_IMPROVEMENT_USD but never past
// (ask - BID_IMPROVEMENT_USD) — only take the improvement when the book has real room for it,
// otherwise fall back to the plain bid. Always leaves real margin below the ask, so it's still
// structurally maker (LIMIT_MAKER rejects rather than crossing) — this buys queue position when
// the book allows it, never risk when it doesn't.
const BID_IMPROVEMENT_USD = 0.02;

function round2(p: number): number { return Math.round(p * 100) / 100; }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function bestSafeBuyPrice(bid: number, ask: number): number {
  return Math.max(round2(bid), round2(ask - BID_IMPROVEMENT_USD));
}

// Polls a resting maker buy every 5s (up to ~40s total, well under the 55s run budget). If it's
// still open and the market has run away from our resting price by more than REPRICE_DRIFT_PCT,
// cancels and re-places at the fresh bid right away rather than waiting up to a minute for the
// next candle — see ENTRY REPRICE DRIFT note above. Returns the terminal order once it reaches
// one, or null (with the DB's buy_order_id left pointing at whatever order is currently resting)
// if still open after polling.
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

      const newPrice = bestSafeBuyPrice(book.bid, book.ask);
      const newOrder = await placeLimitMakerBuySol(SYMBOL, qty, newPrice);
      await updateSolTrailState({ buy_order_id: newOrder.orderId });
      orderId = newOrder.orderId;
    }

    if (i < attempts - 1) await sleep(delayMs);
  }
  return { order: null, orderId };
}

export const liveBotSolTrail = schedules.task({
  id:          "live-bot-sol-trail-1m",
  cron:        "*/1 * * * *",
  maxDuration: 55,

  run: async () => {
    const log: object[] = [];

    // Places the initial protective stop after a buy fill. If Binance rejects it (price already
    // moved past the intended level before the order landed), exits at market instead of leaving
    // the position unprotected — see SAFETY note at the top of this file.
    async function placeInitialStopOrExit(fillPrice: number, solQty: number) {
      const initialStop  = round2(fillPrice * (1 - SL_PCT / 100));
      const initialLimit = round2(initialStop * (1 - SL_BUFFER_PCT / 100));
      log.push({ action: "BUY_FILLED", price: fillPrice, qty: solQty });

      try {
        const stopOrder = await placeStopLimitSellSol(SYMBOL, solQty, initialStop, initialLimit);
        await updateSolTrailState({
          mode:          "SOL",
          sol_quantity:  solQty,
          entry_price:   fillPrice,
          entry_time:    new Date().toISOString(),
          usd_balance:   0,
          buy_order_id:  null,
          stop_order_id: stopOrder.orderId,
          peak_price:    fillPrice,
          stop_price:    initialStop,
          sl_chase_attempts: 0,
        });
        log.push({ action: "STOP_PLACED", stop: initialStop, limit: initialLimit, orderId: stopOrder.orderId });
      } catch (err) {
        const exitOrder  = await placeMarketSellSol(SYMBOL, solQty);
        const grossOut    = parseFloat(exitOrder.cummulativeQuoteQty);
        const exitPrice   = grossOut / parseFloat(exitOrder.executedQty);
        const { netProceeds: usdOut } = await getNetSellProceeds(SYMBOL, exitOrder.orderId, QUOTE_ASSET, grossOut);
        const usdIn     = fillPrice * solQty;
        const pnlUsd    = usdOut - usdIn;
        const pnlPct    = (pnlUsd / usdIn) * 100;

        await updateSolTrailState({
          mode: "USD", sol_quantity: null, entry_price: null, entry_time: null,
          usd_balance: usdOut, buy_order_id: null, stop_order_id: null, peak_price: null, stop_price: null,
          sl_chase_attempts: 0,
        });
        await recordSolTrailTrade({
          entry_price: fillPrice, exit_price: exitPrice, sol_quantity: solQty,
          usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct,
          entry_time: new Date().toISOString(),
        });
        log.push({ action: "EMERGENCY_MARKET_EXIT", reason: String(err), price: exitPrice, pnlUsd: pnlUsd.toFixed(2) });
      }
    }

    // Records a stop-order fill (natural exit, whether caught by the periodic fill-check or
    // discovered while trying to cancel for a trail-up) and returns the now-flat state.
    async function recordStopFill(
      order: { orderId: number; cummulativeQuoteQty: string; executedQty: string }, state: SolTrailState,
    ) {
      const grossOut   = parseFloat(order.cummulativeQuoteQty);
      const exitPrice  = grossOut / parseFloat(order.executedQty);
      const { netProceeds: usdOut } = await getNetSellProceeds(SYMBOL, order.orderId, QUOTE_ASSET, grossOut);
      const usdIn      = state.entry_price! * state.sol_quantity!;
      const pnlUsd      = usdOut - usdIn;
      const pnlPct      = (pnlUsd / usdIn) * 100;

      await updateSolTrailState({
        mode: "USD", sol_quantity: null, entry_price: null, entry_time: null,
        usd_balance: usdOut, stop_order_id: null, peak_price: null, stop_price: null,
        sl_chase_attempts: 0,
      });
      await recordSolTrailTrade({
        entry_price: state.entry_price!, exit_price: exitPrice, sol_quantity: state.sol_quantity!,
        usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct, entry_time: state.entry_time!,
      });
      log.push({ action: "STOP_FILLED", price: exitPrice, pnlUsd: pnlUsd.toFixed(2), pnlPct: pnlPct.toFixed(2) });
      return getSolTrailState();
    }

    // Exits at market and records the trade net of the real (taker) commission. Used both when
    // a trail-up placement is rejected and when a stop looks "phantom" — triggered by price but
    // not actually filled (see STUCK_STOP_PCT below, now that the limit leg no longer guarantees
    // a fill the instant it's rejected).
    async function emergencyMarketExit(state: SolTrailState, reason: unknown): Promise<SolTrailState> {
      const exitOrder = await placeMarketSellSol(SYMBOL, state.sol_quantity!);
      const grossOut   = parseFloat(exitOrder.cummulativeQuoteQty);
      const exitPrice  = grossOut / parseFloat(exitOrder.executedQty);
      const { netProceeds: usdOut } = await getNetSellProceeds(SYMBOL, exitOrder.orderId, QUOTE_ASSET, grossOut);
      const usdIn      = state.entry_price! * state.sol_quantity!;
      const pnlUsd      = usdOut - usdIn;
      const pnlPct      = (pnlUsd / usdIn) * 100;

      await updateSolTrailState({
        mode: "USD", sol_quantity: null, entry_price: null, entry_time: null,
        usd_balance: usdOut, stop_order_id: null, peak_price: null, stop_price: null,
        sl_chase_attempts: 0,
      });
      await recordSolTrailTrade({
        entry_price: state.entry_price!, exit_price: exitPrice, sol_quantity: state.sol_quantity!,
        usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct, entry_time: state.entry_time!,
      });
      log.push({ action: "EMERGENCY_MARKET_EXIT", reason: String(reason), price: exitPrice, pnlUsd: pnlUsd.toFixed(2) });
      return getSolTrailState();
    }

    // Chases the real stop order up using live WebSocket ticks for ~50s instead of a single
    // poll. Every tick and every periodic fill-check runs through one serial queue — exactly
    // one thing happening at a time — so nothing here can race itself the way the old paper
    // WS bot's concurrent handlers once did.
    async function chasePosition(startState: SolTrailState): Promise<SolTrailState> {
      let state = startState;
      let queue: Promise<void> = Promise.resolve();
      let lastTickPrice = startState.peak_price ?? startState.entry_price ?? 0;

      log.push({ action: "CHASE_START", peak: state.peak_price, stop: state.stop_price, chaseAttempts: state.sl_chase_attempts ?? 0 });

      await new Promise<void>((resolve) => {
        const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${SYMBOL.toLowerCase()}@trade`);
        const endTimer = setTimeout(() => { try { ws.close(); } catch { /* already closed */ } }, CHASE_MS);

        // The exchange fills the resting stop order itself — this just needs to notice it did,
        // so the trade gets recorded promptly instead of waiting for the next 1-min tick. Also
        // watches for a "phantom stop": since the limit leg no longer sits below the trigger,
        // it's possible for it to trigger and rest without filling if the market whips through
        // fast. Rather than jumping straight to a market (taker) exit, first try chasing it down
        // as a maker: cancel and re-place a LIMIT_MAKER sell at the current best ask — guaranteed
        // non-crossing (Binance rejects it outright rather than letting it cross), so this can
        // never itself become a taker fill. Repeat up to MAX_EXIT_REPRICE_ATTEMPTS times as price
        // keeps falling; only fall back to a true market order once that budget is exhausted, so
        // a genuine fast crash still has a hard backstop instead of chasing indefinitely.
        const fillCheck = setInterval(() => {
          queue = queue.then(async () => {
            if (state.mode !== "SOL" || !state.stop_order_id) return;
            const order = await getOrderGlobal(SYMBOL, state.stop_order_id);
            if (order.status === "FILLED") {
              state = await recordStopFill(order, state);
              try { ws.close(); } catch { /* already closed */ }
              return;
            }
            const stop = state.stop_price ?? 0;
            if (!(stop > 0 && lastTickPrice <= stop * (1 - STUCK_STOP_PCT / 100))) return;

            if ((state.sl_chase_attempts ?? 0) >= MAX_EXIT_REPRICE_ATTEMPTS) {
              try { await cancelOrderGlobal(SYMBOL, state.stop_order_id); } catch { /* may already be gone */ }
              state = await emergencyMarketExit(state, "phantom_stop_max_reprice");
              try { ws.close(); } catch { /* already closed */ }
              return;
            }

            try {
              await cancelOrderGlobal(SYMBOL, state.stop_order_id);
            } catch {
              const check = await getOrderGlobal(SYMBOL, state.stop_order_id);
              if (check.status === "FILLED") {
                state = await recordStopFill(check, state);
                try { ws.close(); } catch { /* already closed */ }
              }
              return;
            }

            // Persisted in the DB (not a local variable) so the 5-attempt cap holds across
            // separate runs too — a slow multi-minute decline used to reset this to 0 on every
            // new 1-min tick, so the market-exit backstop almost never actually fired (real
            // incident 2026-09-01: a stuck position got chased down far past the intended band
            // over several ticks because each one got a fresh budget). Now it accumulates for
            // the life of the position, so 5 real attempts means 5, not 5-per-minute.
            const newAttempts = (state.sl_chase_attempts ?? 0) + 1;
            try {
              const freshBook = await getBookTickerGlobal(SYMBOL);
              const newStop = round2(freshBook.ask);
              const newOrder = await placeLimitMakerSellSol(SYMBOL, state.sol_quantity!, newStop);
              await updateSolTrailState({ stop_price: newStop, stop_order_id: newOrder.orderId, sl_chase_attempts: newAttempts });
              log.push({ action: "CHASE_DOWN", to: newStop, attempt: newAttempts });
              state = { ...state, stop_price: newStop, stop_order_id: newOrder.orderId, sl_chase_attempts: newAttempts };
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
            if (state.mode !== "SOL" || !state.stop_order_id) return;
            const peak = state.peak_price ?? state.entry_price!;
            if (price <= peak) return; // no new high — nothing to do, let the fill-check handle exits

            const newPeak  = price;
            const newStop  = round2(newPeak * (1 - SL_PCT / 100));
            const newLimit = round2(newStop * (1 - SL_BUFFER_PCT / 100));

            try {
              await cancelOrderGlobal(SYMBOL, state.stop_order_id);
            } catch {
              // Cancel failed — likely because it just filled naturally.
              const check = await getOrderGlobal(SYMBOL, state.stop_order_id);
              if (check.status === "FILLED") {
                state = await recordStopFill(check, state);
                try { ws.close(); } catch { /* already closed */ }
              } else {
                log.push({ action: "TRAIL_UP_FAILED", error: "cancel failed, stop still open" });
              }
              return;
            }

            // Old stop is now gone — genuinely unprotected until the new one lands. If this
            // placement fails too (price already breached it), exit at market immediately
            // instead of retrying and leaving the position exposed (the real 2026-09-01 bug).
            try {
              const newStopOrder = await placeStopLimitSellSol(SYMBOL, state.sol_quantity!, newStop, newLimit);
              await updateSolTrailState({ peak_price: newPeak, stop_price: newStop, stop_order_id: newStopOrder.orderId });
              log.push({ action: "TRAIL_UP", from: state.stop_price, to: newStop, peak: newPeak });
              state = { ...state, peak_price: newPeak, stop_price: newStop, stop_order_id: newStopOrder.orderId };
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

      log.push({ action: "CHASE_END", peak: state.peak_price, stop: state.stop_price });
      return state;
    }

    let state;
    try {
      state = await getSolTrailState();
    } catch (err) {
      await logSolTrailRun({ actions: [{ action: "ERROR", stage: "state", error: String(err) }] });
      return { ok: false };
    }
    if (!state.enabled) return { ok: false, reason: "disabled" };

    const runStartMs = Date.now();

    try {
      const [livePrice, book] = await Promise.all([getPriceGlobal(SYMBOL), getBookTickerGlobal(SYMBOL)]);
      const nowMs = Date.now();
      const candleTs = Math.floor(nowMs / CANDLE_MS) * CANDLE_MS;
      const isNewCandle = candleTs > (state.last_candle_ts ?? 0);

      log.push({ action: "CHECK", mode: state.mode, price: livePrice, bid: book.bid, ask: book.ask, peak: state.peak_price, stop: state.stop_price });

      // ── Pending maker buy order: fast-poll for fill (every 10s, repricing on drift), or refresh on new candle ──
      if (state.mode === "USD" && state.buy_order_id) {
        const pendingOrder = await getOrderGlobal(SYMBOL, state.buy_order_id);
        const { order } = pendingOrder.status === "NEW" || pendingOrder.status === "PARTIALLY_FILLED"
          ? await pollAndRepriceBuy(state.buy_order_id, parseFloat(pendingOrder.origQty))
          : { order: pendingOrder };
        state = await getSolTrailState(); // refresh — pollAndRepriceBuy may have repriced buy_order_id

        if (order?.status === "FILLED") {
          const fillPrice = parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty);
          const solQty    = parseFloat(order.executedQty);
          await placeInitialStopOrExit(fillPrice, solQty);
          state = await getSolTrailState();

        } else if (order && (order.status === "CANCELED" || order.status === "EXPIRED" || order.status === "REJECTED")) {
          await updateSolTrailState({ buy_order_id: null });
          log.push({ action: "BUY_CANCELED", status: order.status });
          state = await getSolTrailState();

        } else if (isNewCandle) {
          // Still open after ~40s of fast polling and a new candle has started — stale, reprice.
          try { await cancelOrderGlobal(SYMBOL, state.buy_order_id); } catch { /* may already be filled/gone */ }
          await updateSolTrailState({ buy_order_id: null, last_candle_ts: candleTs });
          log.push({ action: "BUY_REPRICE_PENDING" });
          state = await getSolTrailState();

        } else {
          log.push({ action: "BUY_WAIT", orderId: state.buy_order_id });
        }
      }

      // ── Open position: chase the trail with a ~50s WebSocket burst instead of a poll ──
      if (state.mode === "SOL" && state.stop_order_id) {
        if (Date.now() - runStartMs < CHASE_START_CUTOFF_MS) {
          state = await chasePosition(state);
        } else {
          // Budget already spent (e.g. a lengthy pending-buy poll ran first this tick) — skip
          // this tick's chase rather than risk running past maxDuration. The real stop order
          // already resting on the exchange keeps protecting the position either way; this only
          // costs one minute of not trailing it up sooner.
          log.push({ action: "SKIP_CHASE", reason: "time_budget", elapsedMs: Date.now() - runStartMs });
        }
      }

      // ── Entry: flat, no pending order → place a fresh maker buy, improved toward the ask ──
      if (state.mode === "USD" && !state.buy_order_id) {
        const usdFree    = await getFreeBalanceGlobal("FDUSD");
        // Compounds: target pool grows with all-time realized PnL, not fixed like sol-oco's
        // hard cap. Still floored by actual free balance — can never spend money you don't have.
        const targetPool = SEED_USD + (state.realized_pnl_usd ?? 0);
        const buyAmount  = Math.min(usdFree, targetPool);

        if (buyAmount >= MIN_NOTIONAL) {
          // Re-fetch the book right before placing — the top-of-run snapshot can now be up to
          // ~50s stale if a chase burst ran earlier this same invocation (real 2026-09-01
          // incident: stale bid crossed the spread, maker buy got rejected with -2010).
          const freshBook = await getBookTickerGlobal(SYMBOL);
          const price = bestSafeBuyPrice(freshBook.bid, freshBook.ask);
          const qty   = buyAmount / price;
          const order = await placeLimitMakerBuySol(SYMBOL, qty, price);
          await updateSolTrailState({ buy_order_id: order.orderId, last_candle_ts: candleTs });
          log.push({ action: "START_BUY", price, qty, buyAmount });

          // Fast-poll this same order too — a maker buy can fill within seconds if it happens
          // to rest right at the touch price, don't wait for the next 1-min tick to protect it.
          // Only if there's still enough of this run's budget left for the ~40s poll — if a
          // chase burst already ran this tick, skip waiting around and let the next tick's
          // pending-buy check (which does the same poll) pick up the fill instead.
          if (Date.now() - runStartMs < POLL_START_CUTOFF_MS) {
            const { order: filled } = await pollAndRepriceBuy(order.orderId, qty);
            if (filled?.status === "FILLED") {
              const fillPrice = parseFloat(filled.cummulativeQuoteQty) / parseFloat(filled.executedQty);
              const solQty    = parseFloat(filled.executedQty);
              await placeInitialStopOrExit(fillPrice, solQty);
            }
          } else {
            log.push({ action: "SKIP_FILL_POLL", reason: "time_budget", elapsedMs: Date.now() - runStartMs });
          }
        } else {
          log.push({ action: "SKIP_BUY", reason: "below_min_notional", buyAmount });
        }
      }

    } catch (err) {
      log.push({ action: "ERROR", stage: "trading", error: String(err) });
    }

    await logSolTrailRun({ actions: log });
    return { ok: true, actions: log };
  },
});
