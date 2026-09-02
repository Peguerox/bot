// Paper bot — SOL/FDUSD "every-bar" no-filter scalp (0% fee pair on Binance Global)
// Entry : buy at live price on EVERY new 1-minute candle close, unconditionally — no filter,
//         no signal, just always in a trade as soon as the previous one closes
// Exit  : whichever hits first — TP +1.0% or SL -0.1% from entry, checked every 1 minute
//         against the live price. No max-hold timeout.
// Paper only: no real orders placed, tracks hypothetical USD/SOL balance in Supabase.
// Backtested (SOLFDUSD, every-bar, 1-min entries, TP=1.0%/SL=0.1%): 3mo +303.4%, WR 11.4%,
// maxDD 8.6%, ~5,600 trades. Beat every filtered variant (VWAP, BB, z-score) tested this
// session on raw return, though with less margin of safety since win rate is thin (~11%,
// vs ~9.1% breakeven for this TP/SL ratio). NOTE: this is the highest-frequency bot running —
// real-money execution would need resting stop orders, not 1-min polling, before ever going
// live (flagged explicitly, this is paper-only for now).
import { schedules } from "@trigger.dev/sdk/v3";
import { getKlinesGlobal, getPriceGlobal } from "../lib/binance";
import {
  getSolEverybarState, updateSolEverybarState, recordSolEverybarTrade, logSolEverybarRun,
} from "../lib/sol-everybar-db";

const SYMBOL   = "SOLFDUSD";
const TP_PCT   = 1.0;
const SL_PCT   = 0.1;
const C1_LIMIT = 5;

type Candle = { time: number; close: number };

export const paperBotEverybarSolFdusd = schedules.task({
  id:          "paper-bot-everybar-solfdusd-1m",
  cron:        "*/1 * * * *",
  maxDuration: 55,

  run: async () => {
    const log: object[] = [];

    let state;
    try {
      state = await getSolEverybarState();
    } catch (err) {
      await logSolEverybarRun({ actions: [{ action: "ERROR", stage: "state", error: String(err) }] });
      return { ok: false };
    }
    if (!state.enabled) return { ok: false, reason: "disabled" };

    try {
      const [raw1, livePrice] = await Promise.all([
        getKlinesGlobal(SYMBOL, "1m", C1_LIMIT),
        getPriceGlobal(SYMBOL),
      ]);

      // Exclude the forming candle — use only fully closed candles
      const c1: Candle[] = raw1.slice(0, -1).map((c: any) => ({ time: c.time, close: c.close }));
      const lastCandleTs = c1[c1.length - 1].time;

      log.push({ action: "CHECK", mode: state.mode, price: livePrice });

      // ── New 1m candle: buy unconditionally if flat ─────────────────────────
      const isNewCandle = lastCandleTs > (state.last_candle_ts ?? 0);
      if (isNewCandle) {
        await updateSolEverybarState({ last_candle_ts: lastCandleTs });

        if (state.mode === "USD") {
          const solQty = state.usd_balance / livePrice;
          await updateSolEverybarState({
            mode:         "SOL",
            sol_quantity: solQty,
            entry_price:  livePrice,
            entry_time:   new Date().toISOString(),
            usd_balance:  0,
          });
          log.push({ action: "BUY", price: livePrice, qty: solQty });
          state = await getSolEverybarState(); // refresh for exit check below
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

          await updateSolEverybarState({
            mode:         "USD",
            sol_quantity: null,
            entry_price:  null,
            entry_time:   null,
            usd_balance:  usdOut,
          });
          await recordSolEverybarTrade({
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

    await logSolEverybarRun({ actions: log });
    return { ok: true, actions: log };
  },
});
