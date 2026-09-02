// Paper bot — SOL/FDUSD VWAP-armed scalp (0% fee pair on Binance Global)
// Entry : while the 5m candle closes below the rolling 20-period VWAP, buy at live price —
//         re-enters on every new 5m candle as long as that condition holds
// Exit  : whichever hits first — TP +0.5% or SL -0.1% from entry, checked every 1 minute
//         against the live price. No max-hold timeout.
// Paper only: no real orders placed, tracks hypothetical USD/SOL balance in Supabase.
// Backtested (SOLFDUSD, VWAP-armed, TP=0.5%/SL=0.1%): 1yr +436.0%, WR 18.0%, maxDD 17.8%,
// 22,267 trades (~61/day). Beat every other SOL strategy tested this session, including the
// currently-deployed pure z-score config (+184.4%/1yr). Running as a SEPARATE bot from the
// existing SOL Z-Score bot so both can be compared live rather than replacing it outright.
import { schedules } from "@trigger.dev/sdk/v3";
import { getKlinesGlobal, getPriceGlobal } from "../lib/binance";
import {
  getSolVwapScalpState, updateSolVwapScalpState, recordSolVwapScalpTrade, logSolVwapScalpRun,
} from "../lib/sol-vwap-scalp-db";

const SYMBOL      = "SOLFDUSD";
const VWAP_PERIOD = 20;
const TP_PCT      = 0.5;
const SL_PCT      = 0.1;
const C5_LIMIT    = VWAP_PERIOD + 10;

type Candle = { time: number; close: number; volume: number };

function calcRollingVWAP(candles: Candle[]): number {
  const window = candles.slice(-VWAP_PERIOD - 1, -1); // last 20 CLOSED candles, excluding current
  let pv = 0, vol = 0;
  for (const c of window) { pv += c.close * c.volume; vol += c.volume; }
  return vol > 0 ? pv / vol : NaN;
}

export const paperBotVwapScalpSolFdusd = schedules.task({
  id:          "paper-bot-vwap-scalp-solfdusd-1m",
  cron:        "*/1 * * * *",
  maxDuration: 55,

  run: async () => {
    const log: object[] = [];

    let state;
    try {
      state = await getSolVwapScalpState();
    } catch (err) {
      await logSolVwapScalpRun({ actions: [{ action: "ERROR", stage: "state", error: String(err) }] });
      return { ok: false };
    }
    if (!state.enabled) return { ok: false, reason: "disabled" };

    try {
      const [raw5, livePrice] = await Promise.all([
        getKlinesGlobal(SYMBOL, "5m", C5_LIMIT),
        getPriceGlobal(SYMBOL),
      ]);

      // Exclude the forming candle — use only fully closed candles
      const c5: Candle[] = raw5.slice(0, -1).map((c: any) => ({ time: c.time, close: c.close, volume: c.volume }));
      const lastCandleTs = c5[c5.length - 1].time;
      const vwap = calcRollingVWAP(c5);
      const lastClose = c5[c5.length - 1].close;
      const favorable = !isNaN(vwap) && lastClose < vwap;

      log.push({
        action: "CHECK",
        mode: state.mode, price: livePrice, vwap: vwap.toFixed(4), favorable,
      });

      // ── New 5m candle: check entry signal (re-arm each candle while favorable) ────────
      const isNewCandle = lastCandleTs > (state.last_candle_ts ?? 0);
      if (isNewCandle) {
        await updateSolVwapScalpState({ last_candle_ts: lastCandleTs });

        if (state.mode === "USD" && favorable) {
          const solQty = state.usd_balance / livePrice;
          await updateSolVwapScalpState({
            mode:         "SOL",
            sol_quantity: solQty,
            entry_price:  livePrice,
            entry_time:   new Date().toISOString(),
            usd_balance:  0,
          });
          log.push({ action: "BUY", price: livePrice, qty: solQty, vwap: vwap.toFixed(4) });
          state = await getSolVwapScalpState(); // refresh for exit check below
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

          await updateSolVwapScalpState({
            mode:         "USD",
            sol_quantity: null,
            entry_price:  null,
            entry_time:   null,
            usd_balance:  usdOut,
          });
          await recordSolVwapScalpTrade({
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

    await logSolVwapScalpRun({ actions: log });
    return { ok: true, actions: log };
  },
});
