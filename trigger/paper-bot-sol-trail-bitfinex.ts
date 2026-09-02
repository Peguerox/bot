// Paper bot — SOL/USD trailing-stop-only on BITFINEX. Same strategy and entry cadence as
// paper-bot-sol-trail-chase.ts (every 1-min bar, no TP, 0.1% trailing stop, $100 seed, compounds)
// — the only difference is the price source: Bitfinex's public WS trades feed instead of
// Binance's. Built to directly test whether the same strategy behaves differently on Bitfinex's
// native price action, after a backtest showed it losing badly there even fee-free (Bitfinex's
// median 1-min candle range is wider than Binance's, per direct comparison this session).
// Paper only: no real orders, no API key needed (public stream), tracks hypothetical balance.
//
// Same short-burst architecture as every WS-chase bot in this codebase (see
// paper-bot-sol-trail-chase.ts's header for why long-lived sessions are avoided).
//
// WORST-CASE SPREAD MODEL (2026-09-02): same fix as paper-bot-sol-trail-chase.ts — entry and
// every peak/stop check use the real measured Bitfinex SOLUSD half-spread (~0.022%) instead of
// the raw trade-tick price, applied continuously through the hold, not just at the final exit.
import { schedules } from "@trigger.dev/sdk/v3";
import WebSocket from "ws";
import { getBitfinexCandles, getBitfinexPrice } from "../lib/bitfinex";
import {
  getSolTrailBitfinexState, updateSolTrailBitfinexState, recordSolTrailBitfinexTrade, logSolTrailBitfinexRun,
  type SolTrailBitfinexState,
} from "../lib/sol-trail-bitfinex-db";

const SYMBOL      = "tSOLUSD";
const SL_PCT      = 0.1;
const SEED_USD    = 100;
const CHASE_MS    = 50 * 1000;
const HALF_SPREAD_PCT = 0.022; // real measured Bitfinex SOLUSD half-spread

function entryFill(price: number): number { return price * (1 + HALF_SPREAD_PCT / 100); } // ask-adjusted
function exitFill(price: number): number { return price * (1 - HALF_SPREAD_PCT / 100); }  // bid-adjusted

async function chase(startState: SolTrailBitfinexState, log: object[]): Promise<SolTrailBitfinexState> {
  let state = startState;
  let ticks = 0;
  let queue: Promise<void> = Promise.resolve();

  log.push({ action: "CHASE_START", peak: state.peak_price, stop: state.stop_price });

  await new Promise<void>((resolve) => {
    const ws = new WebSocket("wss://api-pub.bitfinex.com/ws/2");
    let chanId: number | null = null;
    const endTimer = setTimeout(() => { try { ws.close(); } catch { /* already closed */ } }, CHASE_MS);

    ws.on("open", () => {
      ws.send(JSON.stringify({ event: "subscribe", channel: "trades", symbol: SYMBOL }));
    });

    ws.on("message", (raw: Buffer) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.event === "subscribed" && msg.channel === "trades") { chanId = msg.chanId; return; }
      if (!Array.isArray(msg) || msg[0] !== chanId) return;
      if (msg[1] !== "te") return; // ignore heartbeats, snapshot, and "tu" (duplicate confirmation of the same trade)

      const price = msg[2][3];
      if (!price || isNaN(price)) return;
      ticks++;

      queue = queue.then(async () => {
        if (state.mode !== "SOL") return; // already exited earlier this burst

        const effSell = exitFill(price); // worst-case sell price at this tick
        const peak = state.peak_price ?? state.entry_price!;
        const stop = state.stop_price ?? peak * (1 - SL_PCT / 100);

        if (effSell <= stop) {
          const exitPrice = stop; // already bid-consistent
          const usdOut = state.sol_quantity! * exitPrice;
          const usdIn  = state.entry_price! * state.sol_quantity!;
          const pnlUsd = usdOut - usdIn;
          const pnlPct = (pnlUsd / usdIn) * 100;

          await updateSolTrailBitfinexState({
            mode: "USD", sol_quantity: null, entry_price: null, entry_time: null,
            usd_balance: usdOut, peak_price: null, stop_price: null,
          });
          await recordSolTrailBitfinexTrade({
            entry_price: state.entry_price!, exit_price: exitPrice, sol_quantity: state.sol_quantity!,
            usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct, entry_time: state.entry_time!,
          });
          log.push({ action: "STOP_FILLED", price: exitPrice, pnlUsd: pnlUsd.toFixed(4), pnlPct: pnlPct.toFixed(4) });
          state = await getSolTrailBitfinexState();
          try { ws.close(); } catch { /* already closed */ }

        } else if (effSell > peak) {
          const newStop = effSell * (1 - SL_PCT / 100);
          log.push({ action: "TRAIL_UP", from: stop, to: newStop, peak: effSell });
          state = { ...state, peak_price: effSell, stop_price: newStop };
        }
      }).catch((err) => log.push({ action: "ERROR", stage: "chase", error: String(err) }));
    });

    ws.on("error", (err) => log.push({ action: "ERROR", stage: "ws", error: String(err) }));
    ws.on("close", () => {
      clearTimeout(endTimer);
      queue.finally(resolve);
    });
  });

  if (state.mode === "SOL") {
    await updateSolTrailBitfinexState({ peak_price: state.peak_price, stop_price: state.stop_price });
  }
  log.push({ action: "CHASE_END", ticks, peak: state.peak_price, stop: state.stop_price });
  return state;
}

export const paperBotSolTrailBitfinex = schedules.task({
  id:          "paper-bot-sol-trail-bitfinex-1m",
  cron:        "*/1 * * * *",
  maxDuration: 55,

  run: async () => {
    const log: object[] = [];

    let state = await getSolTrailBitfinexState();
    if (!state.enabled) return { ok: false, reason: "disabled" };

    try {
      const [raw1, livePrice] = await Promise.all([
        getBitfinexCandles(SYMBOL, 5),
        getBitfinexPrice(SYMBOL),
      ]);
      const c1 = raw1.slice(0, -1);
      const lastCandleTs = c1[c1.length - 1].time;
      const isNewCandle = lastCandleTs > (state.last_candle_ts ?? 0);

      log.push({ action: "CHECK", mode: state.mode, price: livePrice });

      // ── Entry: flat, new 1-min candle → buy at live price (paper, unconditional) ──
      if (isNewCandle) {
        await updateSolTrailBitfinexState({ last_candle_ts: lastCandleTs });

        if (state.mode === "USD") {
          const targetPool = SEED_USD + (state.realized_pnl_usd ?? 0);
          const entryPrice = entryFill(livePrice); // ask-adjusted — worse than the raw tick, on purpose
          const solQty = targetPool / entryPrice;
          const initialPeak = exitFill(livePrice); // best sell price achievable right after entry
          await updateSolTrailBitfinexState({
            mode: "SOL", sol_quantity: solQty, entry_price: entryPrice,
            entry_time: new Date().toISOString(), usd_balance: 0,
            peak_price: initialPeak, stop_price: initialPeak * (1 - SL_PCT / 100),
          });
          log.push({ action: "BUY", price: entryPrice, qty: solQty });
          state = await getSolTrailBitfinexState();
        }
      }

      // ── Chase: holding → short WebSocket burst instead of a single price check ──
      if (state.mode === "SOL") {
        state = await chase(state, log);
      }

    } catch (err) {
      log.push({ action: "ERROR", stage: "trading", error: String(err) });
    }

    await logSolTrailBitfinexRun({ actions: log });
    return { ok: true };
  },
});
