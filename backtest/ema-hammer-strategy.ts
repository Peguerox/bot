// Approximates the paper's described strategy: 9-EMA/15-EMA bullish crossover + hammer or
// inverted-hammer candlestick pattern on the crossover candle. Paper didn't specify exit
// rules, so pairing with our own established TP/SL (0.8%/0.3%), 1-min HL execution, no
// timeout, matching the rest of this session's methodology. SOLFDUSD, 1 month.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const ALLOCATION_USD = 50;
const EMA_FAST = 9;
const EMA_SLOW = 15;
const TP_PCT = 0.8;
const SL_PCT = 0.3;
const CANDLE_MS = 5 * 60 * 1000;
const MIN_MS = 60 * 1000;

type C5 = { t: number; o: number; h: number; l: number; c: number };
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

function isHammer(c: C5): boolean {
  const body = Math.abs(c.c - c.o);
  const lowerWick = Math.min(c.o, c.c) - c.l;
  const upperWick = c.h - Math.max(c.o, c.c);
  return body > 0 && lowerWick >= 2 * body && upperWick <= 0.3 * body;
}
function isInvertedHammer(c: C5): boolean {
  const body = Math.abs(c.c - c.o);
  const lowerWick = Math.min(c.o, c.c) - c.l;
  const upperWick = c.h - Math.max(c.o, c.c);
  return body > 0 && upperWick >= 2 * body && lowerWick <= 0.3 * body;
}

function runSim(candles5: C5[], candles1: C1[], windowStartMs: number) {
  const closes = candles5.map(c => c.c);
  const emaFast = calcEMA(closes, EMA_FAST);
  const emaSlow = calcEMA(closes, EMA_SLOW);

  let usd = ALLOCATION_USD, qty = 0;
  let tradesCount = 0, wins = 0, tpHits = 0, slHits = 0, stillOpen = 0;
  let peak = ALLOCATION_USD, maxDD = 0;
  let m1Idx = 0;
  let signals = 0;

  let startIdx = candles5.findIndex(c => c.t >= windowStartMs);
  startIdx = Math.max(startIdx, EMA_SLOW + 1);

  let i = startIdx;
  while (i < candles5.length) {
    const candleCloseTime = candles5[i].t + CANDLE_MS;
    const closePrice = closes[i];

    const bullishCross = !isNaN(emaFast[i-1]) && !isNaN(emaSlow[i-1]) &&
      emaFast[i-1] <= emaSlow[i-1] && emaFast[i] > emaSlow[i];
    const pattern = isHammer(candles5[i]) || isInvertedHammer(candles5[i]);
    const signal = bullishCross && pattern;
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
  const candleFetchStart = windowStart - (EMA_SLOW + 5) * CANDLE_MS;

  const symbol = "SOLFDUSD";
  process.stdout.write(`Fetching ${symbol} 5m... `);
  const raw5 = await fetchKlines(symbol, "5m", candleFetchStart, now);
  const c5: C5[] = raw5.map(c => ({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4] }));
  console.log(`${c5.length}`);
  process.stdout.write(`Fetching ${symbol} 1m... `);
  const raw1 = await fetchKlines(symbol, "1m", windowStart, now);
  const c1: C1[] = raw1.map(c => ({ t: +c[0], h: +c[2], l: +c[3], c: +c[4] }));
  console.log(`${c1.length}`);

  const r = runSim(c5, c1, windowStart);
  console.log(`\nSOLFDUSD 9/15 EMA crossover + hammer/inverted-hammer · 1mo · TP=0.8%/SL=0.3%\n`);
  console.log(`Signals found: ${r.signals}`);
  console.log(`${(r.ret>=0?"+":"")+r.ret.toFixed(1)}%   $${r.finalVal.toFixed(2)}   trades=${r.trades}   WR=${r.wr.toFixed(1)}%   maxDD=${r.maxDD.toFixed(1)}%   TP=${r.tpHits} SL=${r.slHits}${r.stillOpen?` (${r.stillOpen} still open)`:""}`);
})();
