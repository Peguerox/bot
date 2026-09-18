// Pure replay of trigger/live-bot-surfer-solusdt.ts's exact decision logic (RSI(14)-arm +
// EMA(7,25)-liveMode confirm, hard-stop/trailing-stop/trend exit), for the dashboard's Backtest
// comparison column. Uses 15m candle closes as the "live price" proxy for all continuous checks
// (hard stop, trailing stop, trend exit, EMA liveMode adjustment) instead of fetching separate
// 1-min data -- real trades on this bot hold for multiple DAYS, so 15-minute resolution is a
// reasonable approximation, not the tighter precision the faster-cycling bots need. The live bot's
// cron only fires every 5 minutes, but since this only ever reacts to already-closed 15m candles
// (isNewCandle gate) or continuous price levels sampled at whatever resolution we feed it, ticking
// once per 15m candle (rather than simulating the 5-min cron exactly, as the SOLBTC replay does)
// is sufficient here -- there's no faster-than-15m signal this strategy can react to.

export type Candle15m = { time: number; close: number };

const RSI_LOW = 30;
const MA_FAST = 7;
const MA_SLOW = 25;
const HARD_STOP_PCT = -6;
const TRAIL_ARM_PCT = 8;
const TRAIL_PP = 10;
const STEP_THRESH = 30;
const STEP_TRAIL_PP = 6;

export type SurferUsdtFill = { side: "SOL" | "USDT"; price: number; time: number };

function calcEMASeries(candles: Candle15m[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period) return out;
  out[period - 1] = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  for (let i = period; i < candles.length; i++) out[i] = candles[i].close * k + out[i - 1] * (1 - k);
  return out;
}

function calcRSISeries(candles: Candle15m[], period = 14): number[] {
  const rsi: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d > 0) avgGain += d; else avgLoss += -d;
  }
  avgGain /= period; avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

// `c15` = 15m closed candles covering the full replay window plus at least ~110 candles of
// warm-up before it (RSI(14) + a little slack). `c12hByTime` maps each 12h candle's OPEN time
// (ms) to its close, covering the same window plus ~100 candles of warm-up for EMA(25) -- must
// include enough history for both series to be defined by the start of the window you care about.
export function runSurferSolusdtReplay(c15: Candle15m[], c12h: Candle15m[]): { fills: SurferUsdtFill[]; totalReturnPct: number } {
  const fills: SurferUsdtFill[] = [];
  const rsiArr = calcRSISeries(c15);
  const ema7Full = calcEMASeries(c12h, MA_FAST);
  const ema25Full = calcEMASeries(c12h, MA_SLOW);

  let mode: "USDT" | "SOL" = "USDT";
  let armedForSol = false;
  let entryPrice: number | null = null;
  let bestPct = 0;
  let usdt = 1, sol = 0;

  // 12h-candle cursor: at each 15m tick, find the most recent 12h candle whose full period has
  // closed by that tick, then apply the SAME "liveMode" delta adjustment the live bot uses
  // (nudging EMA7/EMA25 toward the current price without waiting for the 12h candle to close).
  let h12Idx = -1;
  const twelveHMs = 12 * 60 * 60_000;

  for (let i = 1; i < c15.length; i++) {
    const tick = c15[i].time;
    const livePrice = c15[i].close;

    while (h12Idx + 1 < c12h.length && c12h[h12Idx + 1].time + twelveHMs <= tick) h12Idx++;
    if (h12Idx < MA_SLOW - 1) continue; // EMA25 not warmed up yet

    const lastEma7 = ema7Full[h12Idx], prevEma7 = h12Idx > 0 ? ema7Full[h12Idx - 1] : NaN;
    const lastEma25 = ema25Full[h12Idx];
    const lastClose12h = c12h[h12Idx].close;
    const delta = livePrice - lastClose12h;
    const liveEma7 = lastEma7 + delta / MA_FAST;
    const liveEma25 = lastEma25 + delta / MA_SLOW;
    const emaBullish = !isNaN(liveEma7) && !isNaN(liveEma25) && liveEma7 > liveEma25;
    const emaSloping = !isNaN(prevEma7) && liveEma7 > prevEma7;

    const curRSI = rsiArr[i], prevRSI = rsiArr[i - 1];

    // ── Track peak unrealized gain + hard/trailing stop while in SOL ──
    let hardStopHit = false, trailHit = false;
    let curPct = 0;
    if (mode === "SOL" && entryPrice !== null) {
      curPct = (livePrice - entryPrice) / entryPrice * 100;
      if (curPct > bestPct) bestPct = curPct;
      if (curPct <= HARD_STOP_PCT) hardStopHit = true;
      else if (bestPct >= TRAIL_ARM_PCT) {
        const trailPp = bestPct >= STEP_THRESH ? STEP_TRAIL_PP : TRAIL_PP;
        if (bestPct - curPct >= trailPp) trailHit = true;
      }
    }

    // ── New-candle RSI arm ──
    if (!isNaN(curRSI) && !isNaN(prevRSI) && mode === "USDT" && !armedForSol
        && prevRSI < RSI_LOW && curRSI >= RSI_LOW) {
      armedForSol = true;
    }

    // ── Entry ──
    if (mode === "USDT" && armedForSol && emaBullish && emaSloping) {
      sol = usdt / livePrice; usdt = 0;
      entryPrice = livePrice; bestPct = 0; armedForSol = false;
      mode = "SOL";
      fills.push({ side: "SOL", price: livePrice, time: tick });
      continue;
    }

    // ── Exit ──
    const trendExit = !emaBullish && curRSI < 50;
    if (mode === "SOL" && (hardStopHit || trailHit || trendExit)) {
      usdt = sol * livePrice; sol = 0;
      entryPrice = null;
      mode = "USDT";
      fills.push({ side: "USDT", price: livePrice, time: tick });
    }
  }

  const lastClose = c15[c15.length - 1].close;
  const finalValue = usdt + sol * lastClose;
  return { fills, totalReturnPct: (finalValue - 1) * 100 };
}
