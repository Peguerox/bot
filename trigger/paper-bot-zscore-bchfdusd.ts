// Paper bot — BCH/FDUSD single-asset z-score mean-reversion (0% fee pair on Binance Global)
// Entry : 5m candle closes with z-score <= -2.0 (price 2 std-devs below its rolling 5-candle
//         mean, i.e. last ~25min) → buy at live price
// Exit  : whichever hits first — TP +0.8% or SL -0.3% from entry, checked every 1 minute
//         against the live price. No max-hold timeout (matches the validated backtest).
// Paper only: no real orders placed, tracks hypothetical USD/BCH balance in Supabase.
// ZSCORE_WINDOW swept 50/30/10/5/2/1 on BCHFDUSD across 1mo/3mo/1yr — window=5 won every
// time (1yr: +894.1% vs +247.7% at window=50, similar win rate ~31%, maxDD 16.0% vs 13.2%).
// window=2 was worse than window=5, window=1 is degenerate (std=0, never trades) — window=5
// sits at a real local optimum, not just "smallest tried so far".

import { schedules } from "@trigger.dev/sdk/v3";
import { getKlinesGlobal, getPriceGlobal } from "../lib/binance";
import {
  getBchZscoreState, updateBchZscoreState, recordBchZscoreTrade, logBchZscoreRun,
} from "../lib/bch-zscore-db";

const SYMBOL        = "BCHFDUSD";
const ZSCORE_WINDOW = 5;
const Z_ENTRY        = -2.0;
const TP_PCT         = 0.8;
const SL_PCT         = 0.3;
const C5_LIMIT       = ZSCORE_WINDOW + 10;

type Candle = { time: number; close: number };

function calcZScore(candles: Candle[]): number {
  const closes = candles.map(c => c.close);
  const window = closes.slice(-ZSCORE_WINDOW - 1, -1); // last 50 CLOSED candles, excluding current
  const current = closes[closes.length - 1];
  const mean = window.reduce((s, v) => s + v, 0) / window.length;
  const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
  const std = Math.sqrt(variance);
  return std > 0 ? (current - mean) / std : 0;
}

export const paperBotZscoreBchFdusd = schedules.task({
  id:          "paper-bot-zscore-bchfdusd-1m",
  cron:        "*/1 * * * *",
  maxDuration: 55,

  run: async () => {
    const log: object[] = [];

    let state;
    try {
      state = await getBchZscoreState();
    } catch (err) {
      await logBchZscoreRun({ actions: [{ action: "ERROR", stage: "state", error: String(err) }] });
      return { ok: false };
    }
    if (!state.enabled) return { ok: false, reason: "disabled" };

    try {
      const [raw5, livePrice] = await Promise.all([
        getKlinesGlobal(SYMBOL, "5m", C5_LIMIT),
        getPriceGlobal(SYMBOL),
      ]);

      // Exclude the forming candle — use only fully closed candles
      const c5: Candle[] = raw5.slice(0, -1).map((c: any) => ({ time: c.time, close: c.close }));
      const lastCandleTs = c5[c5.length - 1].time;
      const zscore = calcZScore(c5);

      log.push({
        action: "CHECK",
        mode: state.mode, price: livePrice, zscore: zscore.toFixed(2),
      });

      // ── New 5m candle: check entry signal ─────────────────────────────────
      const isNewCandle = lastCandleTs > (state.last_candle_ts ?? 0);
      if (isNewCandle) {
        await updateBchZscoreState({ last_candle_ts: lastCandleTs });

        if (state.mode === "USD" && zscore <= Z_ENTRY) {
          const bchQty = state.usd_balance / livePrice;
          await updateBchZscoreState({
            mode:         "BCH",
            bch_quantity: bchQty,
            entry_price:  livePrice,
            entry_time:   new Date().toISOString(),
            usd_balance:  0,
          });
          log.push({ action: "BUY", price: livePrice, qty: bchQty, zscore: zscore.toFixed(2) });
          state = await getBchZscoreState(); // refresh for exit check below
        }
      }

      // ── Exit check: TP or SL against live price, every run ────────────────
      if (state.mode === "BCH" && state.entry_price) {
        const tp = state.entry_price * (1 + TP_PCT / 100);
        const sl = state.entry_price * (1 - SL_PCT / 100);
        let exitPrice: number | null = null;
        let reason: "TP" | "SL" | null = null;

        if (livePrice >= tp) { exitPrice = tp; reason = "TP"; }
        else if (livePrice <= sl) { exitPrice = sl; reason = "SL"; }

        if (exitPrice !== null && reason !== null) {
          const usdOut = state.bch_quantity! * exitPrice;
          const usdIn  = state.bch_quantity! * state.entry_price;
          const pnlUsd = usdOut - usdIn;
          const pnlPct = (pnlUsd / usdIn) * 100;

          await updateBchZscoreState({
            mode:         "USD",
            bch_quantity: null,
            entry_price:  null,
            entry_time:   null,
            usd_balance:  usdOut,
          });
          await recordBchZscoreTrade({
            entry_price:  state.entry_price,
            exit_price:   exitPrice,
            bch_quantity: state.bch_quantity!,
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

    await logBchZscoreRun({ actions: log });
    return { ok: true, actions: log };
  },
});
