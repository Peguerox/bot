// Paper bot — SOL/FDUSD single-asset z-score mean-reversion (0% fee pair on Binance Global)
// Entry : 5m candle closes with z-score <= -2.0 (price 2 std-devs below its rolling 5-candle
//         mean, i.e. last ~25min) → buy at live price
// Exit  : whichever hits first — TP +1.0% or SL -0.1% from entry, checked every 1 minute
//         against the live price. No max-hold timeout.
// Paper only: no real orders placed, tracks hypothetical USD/SOL balance in Supabase.
// Backtested (SOLFDUSD, window=5, TP=1.0%/SL=0.1%): 2yr +635.1%, WR 9.9%, maxDD 19.7%,
// positive every year (2024 +16.4%, 2025 +111.3%, 2026 +196.1%). ~31 trades/day expected,
// win rate is intentionally low — payout ratio (10:1) is what makes it profitable, not
// hit rate. SOL is genuinely liquid (unlike BCHFDUSD's SL=0.1% result, which was a thin-
// liquidity artifact) so this number is trusted.
import { schedules } from "@trigger.dev/sdk/v3";
import { getKlinesGlobal, getPriceGlobal } from "../lib/binance";
import {
  getSolZscoreState, updateSolZscoreState, recordSolZscoreTrade, logSolZscoreRun,
} from "../lib/sol-zscore-db";

const SYMBOL        = "SOLFDUSD";
const ZSCORE_WINDOW = 5;
const Z_ENTRY        = -2.0;
const TP_PCT         = 1.0;
const SL_PCT         = 0.1;
const C5_LIMIT       = ZSCORE_WINDOW + 10;

type Candle = { time: number; close: number };

function calcZScore(candles: Candle[]): number {
  const closes = candles.map(c => c.close);
  const window = closes.slice(-ZSCORE_WINDOW - 1, -1); // last 5 CLOSED candles, excluding current
  const current = closes[closes.length - 1];
  const mean = window.reduce((s, v) => s + v, 0) / window.length;
  const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
  const std = Math.sqrt(variance);
  return std > 0 ? (current - mean) / std : 0;
}

export const paperBotZscoreSolFdusd = schedules.task({
  id:          "paper-bot-zscore-solfdusd-1m",
  cron:        "*/1 * * * *",
  maxDuration: 55,

  run: async () => {
    const log: object[] = [];

    let state;
    try {
      state = await getSolZscoreState();
    } catch (err) {
      await logSolZscoreRun({ actions: [{ action: "ERROR", stage: "state", error: String(err) }] });
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
        await updateSolZscoreState({ last_candle_ts: lastCandleTs });

        if (state.mode === "USD" && zscore <= Z_ENTRY) {
          const solQty = state.usd_balance / livePrice;
          await updateSolZscoreState({
            mode:         "SOL",
            sol_quantity: solQty,
            entry_price:  livePrice,
            entry_time:   new Date().toISOString(),
            usd_balance:  0,
          });
          log.push({ action: "BUY", price: livePrice, qty: solQty, zscore: zscore.toFixed(2) });
          state = await getSolZscoreState(); // refresh for exit check below
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

          await updateSolZscoreState({
            mode:         "USD",
            sol_quantity: null,
            entry_price:  null,
            entry_time:   null,
            usd_balance:  usdOut,
          });
          await recordSolZscoreTrade({
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

    await logSolZscoreRun({ actions: log });
    return { ok: true, actions: log };
  },
});
