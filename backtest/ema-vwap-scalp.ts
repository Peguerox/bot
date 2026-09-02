// Approximates the Beraudo & Oliinyk (2024) scalping pseudocode: buy when price > EMA AND
// VWAP signal is "strong" (price >= VWAP + threshold), confirmed by RSI(50-70, bullish but
// not overbought) and Bollinger Bands (price below upper band, not overextended). Paper
// didn't publish param values or exit rules, so using our own reasonable defaults + our
// established TP/SL (0.8%/0.3%), flagged clearly as an approximation. SOLFDUSD, 1 month.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const ALLOCATION_USD = 50;
const EMA_PERIOD = 20;
const VWAP_PERIOD = 20;
const VWAP_THRESHOLD_PCT = 0.1;
const RSI_PERIOD = 14;
const RSI_LOW = 50, RSI_HIGH = 70;
const BB_PERIOD = 20, BB_STD = 2;
const TP_PCT = 0.8;
const SL_PCT = 0.3;
const CANDLE_MS = 5 * 60 * 1000;
const MIN_MS = 60 * 1000;

type C5 = { t: number; c: number; v: number };
type C1 = { t: number; h: number; l: number; c: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
async function fetchKlines(symbol: string, interval: string, startMs: number, endMs: number): Promise<any[]> {
  const out: any[] = []; let from = startMs;
  while (from < endMs) {
    const res = await fetch(`${BASE}/klines?symbol=${symbol}&interval=${interval}&startTime=${from}&endTime=${endMs}&limit=1000`);
    if (res.status === 429) { await sleep(6000); continue; }
    if (!res.ok) return out;
    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) out.push(c);
    from = +raw[raw.length - 1][0] + 1;
    await sleep(90);
  }
  return out;
}

function calcEMA(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period) return out;
  out[period - 1] = closes.slice(0, period).reduce((a, c) => a + c, 0) / period;
  for (let i = period; i < closes.length; i++) out[i] = closes[i] * k + out[i - 1] * (1 - k);
  return out;
}

function calcRollingVWAP(candles: C5[], period: number): number[] {
  const out: number[] = new Array(candles.length).fill(NaN);
  for (let i = period - 1; i < candles.length; i++) {
    let pv = 0, vol = 0;
    for (let k = i - period + 1; k <= i; k++) { pv += candles[k].c * candles[k].v; vol += candles[k].v; }
    out[i] = vol > 0 ? pv / vol : NaN;
  }
  return out;
}

function calcRSI(closes: number[], period = 14): number[] {
  const rsi: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i-1]; if (d > 0) avgGain += d; else avgLoss += -d; }
  avgGain /= period; avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function calcBBUpper(closes: number[], period: number, stdMult: number): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    const window = closes.slice(i - period + 1, i + 1);
    const mean = window.reduce((a, c) => a + c, 0) / period;
    const variance = window.reduce((a, c) => a + (c - mean) ** 2, 0) / period;
    out[i] = mean + stdMult * Math.sqrt(variance);
  }
  return out;
}

function runSim(candles5: C5[], candles1: C1[], windowStartMs: number) {
  const closes = candles5.map(c => c.c);
  const ema = calcEMA(closes, EMA_PERIOD);
  const vwap = calcRollingVWAP(candles5, VWAP_PERIOD);
  const rsi = calcRSI(closes, RSI_PERIOD);
  const bbUpper = calcBBUpper(closes, BB_PERIOD, BB_STD);

  let usd = ALLOCATION_USD, qty = 0;
  let tradesCount = 0, wins = 0, tpHits = 0, slHits = 0, stillOpen = 0;
  let peak = ALLOCATION_USD, maxDD = 0;
  let m1Idx = 0;
  let signals = 0;

  let startIdx = candles5.findIndex(c => c.t >= windowStartMs);
  startIdx = Math.max(startIdx, EMA_PERIOD, VWAP_PERIOD, RSI_PERIOD, BB_PERIOD);

  let i = startIdx;
  while (i < candles5.length) {
    const candleCloseTime = candles5[i].t + CANDLE_MS;
    const closePrice = closes[i];

    const vwapStrongBuy = !isNaN(vwap[i]) && (closePrice - vwap[i]) / vwap[i] * 100 >= VWAP_THRESHOLD_PCT;
    const aboveEma = !isNaN(ema[i]) && closePrice > ema[i];
    const rsiOk = !isNaN(rsi[i]) && rsi[i] >= RSI_LOW && rsi[i] <= RSI_HIGH;
    const bbOk = !isNaN(bbUpper[i]) && closePrice < bbUpper[i];
    const signal = aboveEma && vwapStrongBuy && rsiOk && bbOk;
    if (signal) signals++;

    if (signal) {
      const entryPrice = closePrice;
      const entryTime = candleCloseTime;
      const tp = entryPrice * (1 + TP_PCT / 100);
      const sl = entryPrice * (1 - SL_PCT / 100);
      qty = usd / entryPrice; usd = 0;

      while (m1Idx < candles1.length && candles1[m1Idx].t + MIN_MS <= entryTime) m1Idx++;

      let j = m1Idx;
      let exitPrice: number | null = null;
      let reason = "";
      while (j < candles1.length) {
        const hitTP = candles1[j].h >= tp;
        const hitSL = candles1[j].l <= sl;
        if (hitTP && hitSL) { exitPrice = sl; reason = "SL"; break; }
        if (hitTP) { exitPrice = tp; reason = "TP"; break; }
        if (hitSL) { exitPrice = sl; reason = "SL"; break; }
        j++;
      }
      if (exitPrice === null) {
        const lastPrice = candles1.length ? candles1[candles1.length - 1].c : entryPrice;
        usd = qty * lastPrice; qty = 0; stillOpen++; break;
      }

      usd = qty * exitPrice;
      tradesCount++; if (usd > qty * entryPrice) wins++;
      if (reason === "TP") tpHits++; else slHits++;
      qty = 0;
      m1Idx = j;

      const eq = usd;
      if (eq > peak) peak = eq;
      const dd = (peak - eq) / peak * 100;
      if (dd > maxDD) maxDD = dd;

      const exitTime = (candles1[j]?.t ?? entryTime) + MIN_MS;
      let nextI = i;
      while (nextI < candles5.length && candles5[nextI].t + CANDLE_MS <= exitTime) nextI++;
      i = Math.max(nextI, i + 1);
      continue;
    }
    i++;
  }

  const finalVal = usd;
  const ret = (finalVal - ALLOCATION_USD) / ALLOCATION_USD * 100;
  const wr = tradesCount ? wins / tradesCount * 100 : 0;
  return { ret, trades: tradesCount, wr, maxDD, finalVal, tpHits, slHits, stillOpen, signals };
}

(async () => {
  const now = Date.now();
  const windowStart = now - 30 * 24 * 60 * 60 * 1000; // 1mo
  const candleFetchStart = windowStart - (Math.max(EMA_PERIOD, VWAP_PERIOD, BB_PERIOD) + 5) * CANDLE_MS;

  const symbol = "SOLFDUSD";
  process.stdout.write(`Fetching ${symbol} 5m... `);
  const raw5 = await fetchKlines(symbol, "5m", candleFetchStart, now);
  const c5: C5[] = raw5.map(c => ({ t: +c[0], c: +c[4], v: +c[5] }));
  console.log(`${c5.length}`);
  process.stdout.write(`Fetching ${symbol} 1m... `);
  const raw1 = await fetchKlines(symbol, "1m", windowStart, now);
  const c1: C1[] = raw1.map(c => ({ t: +c[0], h: +c[2], l: +c[3], c: +c[4] }));
  console.log(`${c1.length}`);

  const r = runSim(c5, c1, windowStart);
  console.log(`\nSOLFDUSD EMA/VWAP scalp (+RSI+BB confirm) · 1mo · TP=0.8%/SL=0.3%\n`);
  console.log(`Signals found: ${r.signals}`);
  console.log(`${(r.ret>=0?"+":"")+r.ret.toFixed(1)}%   $${r.finalVal.toFixed(2)}   trades=${r.trades}   WR=${r.wr.toFixed(1)}%   maxDD=${r.maxDD.toFixed(1)}%   TP=${r.tpHits} SL=${r.slHits}${r.stillOpen?` (${r.stillOpen} still open)`:""}`);
})();
