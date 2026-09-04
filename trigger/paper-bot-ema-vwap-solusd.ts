// Paper bot — EMA9/EMA21 + VWAP scalping strategy, SOL/USD (Bitfinex), 5m timeframe.
// Long-only (spot can't short without margin, same constraint as every other bot this session).
//
// SIGNAL (translated from a strategy video, several vague parts pinned to concrete numbers —
// see the session notes for exactly which choices were made and why):
//   1. EMA9 crosses above EMA21 on a closed 5m candle -> ARM (not an entry yet).
//   2. While ARMED, wait for a candle whose range touches VWAP (low <= VWAP <= high), closes
//      bullish (close > open) and back above VWAP, with EMA9 still above EMA21 and VWAP itself
//      sloping up over the last 4 candles (~20min) -> that's the entry, at the live ask.
//   3. 15m filter: 15m EMA9 must also be above EMA21 at entry time, or skip.
//   4. ARMED state expires after 1 hour (12x 5m candles) with no valid bounce, or if EMA9
//      crosses back below EMA21 first -> back to FLAT.
//
// EXIT:
//   - SL = VWAP at entry candle, minus a 0.05% buffer (the video just says "just below VWAP" --
//     picked a concrete number since code needs one).
//   - TP = entry + 2x the SL distance (1:2 risk:reward, the low end of the video's 1:2-1:2.5
//     suggestion). At TP, close HALF the position and move the stop for the other half to
//     breakeven (entry price) -- the "free trade" the video describes. The remaining half then
//     rides with only a breakeven stop, no further cap, until that stop is hit.
//   - Checked every 1 min against the live bid (worst-case-consistent, same as every other bot).
//
// NOT implemented from the video (flagged as a real simplification, not an oversight): the
// "check the next candle's volume, trim if weak" secondary confirmation. Established the core
// entry/exit logic first; can layer that in later if this shows any signal.
import { schedules } from "@trigger.dev/sdk/v3";
import { getBitfinexCandlesOHLCV, getBitfinexBidAsk, type BitfinexOHLCV } from "../lib/bitfinex";
import {
  getSolEmaVwapState, updateSolEmaVwapState, recordSolEmaVwapTrade, logSolEmaVwapRun,
} from "../lib/sol-ema-vwap-db";

const SYMBOL          = "tSOLUSD";
const SEED_USD        = 100;
const EMA_FAST         = 9;
const EMA_SLOW         = 21;
const RR_RATIO         = 2; // TP = entry + RR_RATIO * (entry - SL)
const SL_VWAP_BUFFER_PCT = 0.05; // SL sits this much below VWAP, not exactly on it
const VWAP_SLOPE_LOOKBACK = 4;   // candles back to check VWAP is sloping up (~20min on 5m)
const ARM_TIMEOUT_CANDLES = 12;  // ~1hr on 5m -- cancel the arm if no bounce happens by then
const CANDLE_LIMIT_5M  = 300;    // enough for stable EMA21 + same-day VWAP in most cases
const CANDLE_LIMIT_15M = 50;

function calcEMA(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const emas: number[] = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    emas.push(closes[i] * k + emas[i - 1] * (1 - k));
  }
  return emas;
}

// Session VWAP, reset at UTC midnight -- only sums candles from the start of the current UTC day.
function calcVWAP(candles: BitfinexOHLCV[]): number[] {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();

  let cumPV = 0, cumVol = 0;
  const vwaps: number[] = [];
  for (const c of candles) {
    if (c.time < todayStartMs) { vwaps.push(NaN); continue; }
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumPV += typicalPrice * c.volume;
    cumVol += c.volume;
    vwaps.push(cumVol > 0 ? cumPV / cumVol : typicalPrice);
  }
  return vwaps;
}

export const paperBotEmaVwapSolUsd = schedules.task({
  id:          "paper-bot-ema-vwap-solusd-1m",
  cron:        "*/1 * * * *",
  maxDuration: 55,

  run: async () => {
    const log: object[] = [];

    let state;
    try {
      state = await getSolEmaVwapState();
    } catch (err) {
      await logSolEmaVwapRun({ actions: [{ action: "ERROR", stage: "state", error: String(err) }] });
      return { ok: false };
    }
    if (!state.enabled) return { ok: false, reason: "disabled" };

    try {
      const [c5, c15, bidAsk] = await Promise.all([
        getBitfinexCandlesOHLCV(SYMBOL, "5m", CANDLE_LIMIT_5M),
        getBitfinexCandlesOHLCV(SYMBOL, "15m", CANDLE_LIMIT_15M),
        getBitfinexBidAsk(SYMBOL),
      ]);
      // Exclude the still-forming candle -- only fully closed ones count.
      const closed5 = c5.slice(0, -1);
      const closed15 = c15.slice(0, -1);
      if (closed5.length < EMA_SLOW + VWAP_SLOPE_LOOKBACK + 2 || closed15.length < EMA_SLOW + 2) {
        await logSolEmaVwapRun({ actions: [{ action: "ERROR", stage: "data", error: "not enough candle history yet" }] });
        return { ok: false };
      }

      const closes5 = closed5.map(c => c.close);
      const ema9_5 = calcEMA(closes5, EMA_FAST);
      const ema21_5 = calcEMA(closes5, EMA_SLOW);
      const vwap5 = calcVWAP(closed5);

      const closes15 = closed15.map(c => c.close);
      const ema9_15 = calcEMA(closes15, EMA_FAST);
      const ema21_15 = calcEMA(closes15, EMA_SLOW);

      const i = closed5.length - 1; // latest closed 5m candle
      const lastCandleTs = closed5[i].time;
      const isNewCandle = lastCandleTs > (state.last_5m_candle_ts ?? 0);

      const crossUpNow = ema9_5[i] > ema21_5[i] && ema9_5[i - 1] <= ema21_5[i - 1];
      const emaFastAboveSlow = ema9_5[i] > ema21_5[i];
      const vwapNow = vwap5[i];
      const vwapSlopeUp = !isNaN(vwap5[i - VWAP_SLOPE_LOOKBACK]) && vwapNow > vwap5[i - VWAP_SLOPE_LOOKBACK];
      const touchedVwap = closed5[i].low <= vwapNow && vwapNow <= closed5[i].high;
      const closedBullish = closed5[i].close > closed5[i].open;
      const closedAboveVwap = closed5[i].close > vwapNow;
      const higherTfBullish = ema9_15[closed15.length - 1] > ema21_15[closed15.length - 1];

      log.push({
        action: "CHECK", position_state: state.position_state,
        ema9: ema9_5[i].toFixed(4), ema21: ema21_5[i].toFixed(4), vwap: vwapNow.toFixed(4),
        emaFastAboveSlow, vwapSlopeUp, bid: bidAsk.bid, ask: bidAsk.ask,
      });

      if (isNewCandle) {
        await updateSolEmaVwapState({ last_5m_candle_ts: lastCandleTs });

        if (state.position_state === "FLAT" && crossUpNow) {
          await updateSolEmaVwapState({ position_state: "ARMED", armed_since_ts: lastCandleTs });
          log.push({ action: "ARM", candleTs: lastCandleTs });
          state = await getSolEmaVwapState();
        }

        if (state.position_state === "ARMED") {
          const candlesSinceArm = (lastCandleTs - (state.armed_since_ts ?? lastCandleTs)) / (5 * 60 * 1000);
          if (!emaFastAboveSlow) {
            await updateSolEmaVwapState({ position_state: "FLAT", armed_since_ts: null });
            log.push({ action: "DISARM", reason: "EMA crossed back down" });
            state = await getSolEmaVwapState();
          } else if (candlesSinceArm > ARM_TIMEOUT_CANDLES) {
            await updateSolEmaVwapState({ position_state: "FLAT", armed_since_ts: null });
            log.push({ action: "DISARM", reason: "timeout, no bounce" });
            state = await getSolEmaVwapState();
          } else if (touchedVwap && closedBullish && closedAboveVwap && vwapSlopeUp && higherTfBullish) {
            const entry = bidAsk.ask;
            const sl = vwapNow * (1 - SL_VWAP_BUFFER_PCT / 100);
            const risk = entry - sl;
            const tp = entry + RR_RATIO * risk;
            const qty = (SEED_USD + (state.realized_pnl_usd ?? 0)) / entry;
            await updateSolEmaVwapState({
              position_state: "FULL", entry_price: entry, entry_time: new Date().toISOString(),
              full_qty: qty, remaining_qty: qty, sl_price: sl, tp_price: tp, usd_balance: 0,
              armed_since_ts: null,
            });
            log.push({ action: "ENTER", price: entry, qty, sl, tp });
            state = await getSolEmaVwapState();
          } else {
            log.push({ action: "WAITING", touchedVwap, closedBullish, closedAboveVwap, vwapSlopeUp, higherTfBullish });
          }
        }
      }

      // ── Exit checks: every run, against live bid ───────────────────────────
      if (state.position_state === "FULL") {
        const { bid } = bidAsk;
        if (bid <= state.sl_price!) {
          const usdOut = state.remaining_qty! * bid;
          const usdIn = state.remaining_qty! * state.entry_price!;
          const pnlUsd = usdOut - usdIn;
          const pnlPct = (pnlUsd / usdIn) * 100;
          await updateSolEmaVwapState({
            position_state: "FLAT", entry_price: null, entry_time: null,
            full_qty: null, remaining_qty: null, sl_price: null, tp_price: null, usd_balance: usdOut,
          });
          await recordSolEmaVwapTrade({
            entry_price: state.entry_price!, exit_price: bid, qty: state.remaining_qty!,
            usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct,
            exit_reason: "SL", entry_time: state.entry_time!,
          });
          log.push({ action: "SL_FULL", price: bid, pnlUsd: pnlUsd.toFixed(4) });
        } else if (bid >= state.tp_price!) {
          const halfQty = state.full_qty! / 2;
          const usdOut = halfQty * bid;
          const usdIn = halfQty * state.entry_price!;
          const pnlUsd = usdOut - usdIn;
          const pnlPct = (pnlUsd / usdIn) * 100;
          await recordSolEmaVwapTrade({
            entry_price: state.entry_price!, exit_price: bid, qty: halfQty,
            usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct,
            exit_reason: "TP_PARTIAL", entry_time: state.entry_time!,
          });
          await updateSolEmaVwapState({
            position_state: "HALF", remaining_qty: state.full_qty! - halfQty,
            sl_price: state.entry_price, // move to breakeven
            usd_balance: (state.usd_balance ?? 0) + usdOut,
          });
          log.push({ action: "TP_PARTIAL", price: bid, pnlUsd: pnlUsd.toFixed(4), remaining: state.full_qty! - halfQty });
        }
      } else if (state.position_state === "HALF") {
        const { bid } = bidAsk;
        if (bid <= state.sl_price!) {
          const usdOut = state.remaining_qty! * bid;
          const usdIn = state.remaining_qty! * state.entry_price!;
          const pnlUsd = usdOut - usdIn;
          const pnlPct = (pnlUsd / usdIn) * 100;
          await updateSolEmaVwapState({
            position_state: "FLAT", entry_price: null, entry_time: null,
            full_qty: null, remaining_qty: null, sl_price: null, tp_price: null,
            usd_balance: (state.usd_balance ?? 0) + usdOut,
          });
          await recordSolEmaVwapTrade({
            entry_price: state.entry_price!, exit_price: bid, qty: state.remaining_qty!,
            usd_in: usdIn, usd_out: usdOut, pnl_usd: pnlUsd, pnl_pct: pnlPct,
            exit_reason: "BREAKEVEN", entry_time: state.entry_time!,
          });
          log.push({ action: "BREAKEVEN_EXIT", price: bid, pnlUsd: pnlUsd.toFixed(4) });
        }
      }

    } catch (err) {
      log.push({ action: "ERROR", stage: "trading", error: String(err) });
    }

    await logSolEmaVwapRun({ actions: log });
    return { ok: true, actions: log };
  },
});
