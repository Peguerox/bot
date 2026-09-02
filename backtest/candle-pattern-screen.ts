// Screens 8 standard bullish candlestick patterns individually as entry signals (no EMA/VWAP/
// z-score involved) — pure price-action patterns. Same execution: TP=0.8%/SL=0.3%, 1-min HL,
// no timeout. SOLFDUSD, 1 month.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const ALLOCATION_USD = 50;
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

function body(c: C5) { return Math.abs(c.c - c.o); }
function range(c: C5) { return c.h - c.l; }
function upperWick(c: C5) { return c.h - Math.max(c.o, c.c); }
function lowerWick(c: C5) { return Math.min(c.o, c.c) - c.l; }
function isGreen(c: C5) { return c.c > c.o; }
function isRed(c: C5) { return c.c < c.o; }

type Pattern = { name: string; check: (c5: C5[], i: number) => boolean };

const patterns: Pattern[] = [
  { name: "Hammer", check: (c, i) => body(c[i]) > 0 && lowerWick(c[i]) >= 2 * body(c[i]) && upperWick(c[i]) <= 0.3 * body(c[i]) },
  { name: "InvertedHammer", check: (c, i) => body(c[i]) > 0 && upperWick(c[i]) >= 2 * body(c[i]) && lowerWick(c[i]) <= 0.3 * body(c[i]) },
  { name: "BullishEngulfing", check: (c, i) => i >= 1 && isRed(c[i-1]) && isGreen(c[i]) && c[i].o <= c[i-1].c && c[i].c >= c[i-1].o },
  { name: "BullishHarami", check: (c, i) => i >= 1 && isRed(c[i-1]) && isGreen(c[i]) && c[i].o >= c[i-1].c && c[i].c <= c[i-1].o },
  { name: "PiercingLine", check: (c, i) => {
      if (i < 1 || !isRed(c[i-1]) || !isGreen(c[i])) return false;
      const mid = (c[i-1].o + c[i-1].c) / 2;
      return c[i].o < c[i-1].c && c[i].c > mid && c[i].c < c[i-1].o;
    } },
  { name: "MorningStar", check: (c, i) => {
      if (i < 2) return false;
      const c1 = c[i-2], c2 = c[i-1], c3 = c[i];
      if (!isRed(c1) || body(c1) === 0) return false;
      if (body(c2) > 0.3 * body(c1)) return false;
      if (!isGreen(c3)) return false;
      const mid1 = (c1.o + c1.c) / 2;
      return c3.c > mid1;
    } },
  { name: "ThreeWhiteSoldiers", check: (c, i) => {
      if (i < 2) return false;
      const c1 = c[i-2], c2 = c[i-1], c3 = c[i];
      if (!isGreen(c1) || !isGreen(c2) || !isGreen(c3)) return false;
      if (!(c2.c > c1.c && c3.c > c2.c)) return false;
      if (!(c2.o > c1.o && c2.o < c1.c)) return false;
      if (!(c3.o > c2.o && c3.o < c2.c)) return false;
      return upperWick(c3) <= 0.3 * body(c3);
    } },
  { name: "BullishMarubozu", check: (c, i) => isGreen(c[i]) && range(c[i]) > 0 && upperWick(c[i]) <= 0.05 * range(c[i]) && lowerWick(c[i]) <= 0.05 * range(c[i]) },
];

function runSim(candles5: C5[], candles1: C1[], windowStartMs: number, check: (c5: C5[], i: number) => boolean) {
  let usd = ALLOCATION_USD, qty = 0;
  let tradesCount = 0, wins = 0, tpHits = 0, slHits = 0, stillOpen = 0;
  let peak = ALLOCATION_USD, maxDD = 0;
  let m1Idx = 0;
  let signals = 0;

  let startIdx = candles5.findIndex(c => c.t >= windowStartMs);
  startIdx = Math.max(startIdx, 3);

  let i = startIdx;
  while (i < candles5.length) {
    const candleCloseTime = candles5[i].t + CANDLE_MS;
    const closePrice = candles5[i].c;

    const signal = check(candles5, i);
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
  const candleFetchStart = windowStart - 10 * CANDLE_MS;

  const symbol = "SOLFDUSD";
  process.stdout.write(`Fetching ${symbol} 5m... `);
  const raw5 = await fetchKlines(symbol, "5m", candleFetchStart, now);
  const c5: C5[] = raw5.map(c => ({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4] }));
  console.log(`${c5.length}`);
  process.stdout.write(`Fetching ${symbol} 1m... `);
  const raw1 = await fetchKlines(symbol, "1m", windowStart, now);
  const c1: C1[] = raw1.map(c => ({ t: +c[0], h: +c[2], l: +c[3], c: +c[4] }));
  console.log(`${c1.length}`);

  const results = [];
  for (const p of patterns) {
    const r = runSim(c5, c1, windowStart, p.check);
    results.push({ name: p.name, ...r });
  }
  results.sort((a, b) => b.ret - a.ret);

  console.log(`\nCandlestick pattern screen · SOLFDUSD · 1mo · TP=0.8%/SL=0.3%\n`);
  for (const r of results) {
    console.log(`${r.name.padEnd(20)}${(r.ret>=0?"+":"")+r.ret.toFixed(1).padStart(8)}%   signals=${String(r.signals).padStart(4)}   trades=${String(r.trades).padStart(4)}   WR=${r.wr.toFixed(1).padStart(5)}%   maxDD=${r.maxDD.toFixed(1)}%`);
  }
})();
