// Paper bot — SOL/USDT "every-bar" no-filter scalp on Binance.US (mirrors the Global
// SOLFDUSD version, same strategy, different exchange, for direct live comparison).
// Entry : buy at live price on EVERY new 1-minute candle close, unconditionally — no filter,
//         no signal, just always in a trade as soon as the previous one closes
// Exit  : whichever hits first — TP +1.0% or SL -0.1% from entry, checked every 1 minute
//         against the live price. No max-hold timeout.
// Paper only: no real orders placed, tracks hypothetical USD/SOL balance in Supabase.
// NOTE: backtests on Binance.US showed inflated returns due to much thinner liquidity than
// Binance Global (confirmed directly via order book depth this session) — this bot exists to
// see how the live paper numbers actually compare to the Global version, not because the
// backtest numbers are trusted at face value.
import { schedules } from "@trigger.dev/sdk/v3";
import { getKlines, getPrice } from "../lib/binance";
import {
  getSolEverybarUsState, updateSolEverybarUsState, recordSolEverybarUsTrade, logSolEverybarUsRun,
} from "../lib/sol-everybar-us-db";

const SYMBOL   = "SOLUSDT";
const TP_PCT   = 1.0;
const SL_PCT   = 0.1;
const C1_LIMIT = 5;

type Candle = { time: number; close: number };

export const paperBotEverybarSolUsdtUs = schedules.task({
  id:          "paper-bot-everybar-solusdt-us-1m",
  cron:        "*/1 * * * *",
  maxDuration: 55,

  run: async () => {
    const log: object[] = [];

    let state;
    try {
      state = await getSolEverybarUsState();
    } catch (err) {
      await logSolEverybarUsRun({ actions: [{ action: "ERROR", stage: "state", error: String(err) }] });
      return { ok: false };
    }
    if (!state.enabled) return { ok: false, reason: "disabled" };

    try {
      const [raw1, livePrice] = await Promise.all([
        getKlines(SYMBOL, "1m", C1_LIMIT),
        getPrice(SYMBOL),
      ]);

      // Exclude the forming candle — use only fully closed candles
      const c1: Candle[] = raw1.slice(0, -1).map((c: any) => ({ time: c.time, close: c.close }));
      const lastCandleTs = c1[c1.length - 1].time;

      log.push({ action: "CHECK", mode: state.mode, price: livePrice });

      // ── New 1m candle: buy unconditionally if flat ─────────────────────────
      const isNewCandle = lastCandleTs > (state.last_candle_ts ?? 0);
      if (isNewCandle) {
        await updateSolEverybarUsState({ last_candle_ts: lastCandleTs });

        if (state.mode === "USD") {
          const solQty = state.usd_balance / livePrice;
          await updateSolEverybarUsState({
            mode:         "SOL",
            sol_quantity: solQty,
            entry_price:  livePrice,
            entry_time:   new Date().toISOString(),
            usd_balance:  0,
          });
          log.push({ action: "BUY", price: livePrice, qty: solQty });
          state = await getSolEverybarUsState(); // refresh for exit check below
        }
      }

      // ── Exit check: TP or SL against live price, every run ────────────────
      if (state.mode === "SOL" && state.entry_price) {
        const tp = state.entry_price * (1 + TP_PCT / 100);
        const sl = state.entry_price * (1 - SL_PCT / 100);
        let exitPrice: number | null = null;
        let reason: "TP" | "SL" | null = null;

        if (livePrice >= tp) { exitPrice = tp; reason = "TP"; }
        else if (livePrice <= sl) { exitPrice = sl; reason = "SL"; }

        if (exitPrice !== null && reason !== null) {
          const usdOut = state.sol_quantity! * exitPrice;
          const usdIn  = state.sol_quantity! * state.entry_price;
          const pnlUsd = usdOut - usdIn;
          const pnlPct = (pnlUsd / usdIn) * 100;

          await updateSolEverybarUsState({
            mode:         "USD",
            sol_quantity: null,
            entry_price:  null,
            entry_time:   null,
            usd_balance:  usdOut,
          });
          await recordSolEverybarUsTrade({
            entry_price:  state.entry_price,
            exit_price:   exitPrice,
            sol_quantity: state.sol_quantity!,
            usd_in:       usdIn,
            usd_out:      usdOut,
            pnl_usd:      pnlUsd,
            pnl_pct:      pnlPct,
            exit_reason:  reason,
            entry_time:   state.entry_time!,
          });
          log.push({ action: "SELL", reason, price: exitPrice, pnlUsd: pnlUsd.toFixed(2), pnlPct: pnlPct.toFixed(2) });
        }
      }

    } catch (err) {
      log.push({ action: "ERROR", stage: "trading", error: String(err) });
    }

    await logSolEverybarUsRun({ actions: log });
    return { ok: true, actions: log };
  },
});
