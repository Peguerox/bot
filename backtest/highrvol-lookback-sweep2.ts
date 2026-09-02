// HighRVOL signal (volume >= 3x rolling average) with lookback window swept: 20 vs 10 vs 5.
// Same execution: TP=0.8%/SL=0.3%, 1-min HL, no timeout. SOLFDUSD, 3 months, monthly breakdown.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const ALLOCATION_USD = 50;
const TP_PCT = 0.8;
const SL_PCT = 0.3;
const CANDLE_MS = 5 * 60 * 1000;
const MIN_MS = 60 * 1000;
const VOL_MULT = 3;

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

function avgVol(c5: C5[], i: number, lookback: number): number {
  let sum = 0;
  for (let k = i - lookback; k < i; k++) sum += c5[k].v;
  return sum / lookback;
}

function runSim(candles5: C5[], candles1: C1[], windowStartMs: number, lookback: number) {
  let usd = ALLOCATION_USD, qty = 0;
  let tradesCount = 0, wins = 0, tpHits = 0, slHits = 0, stillOpen = 0;
  let peak = ALLOCATION_USD, maxDD = 0;
  let m1Idx = 0;
  let signalCount = 0;
  const monthlyStart: Record<string, number> = {};
  const monthlyEnd: Record<string, number> = {};

  let startIdx = candles5.findIndex(c => c.t >= windowStartMs);
  startIdx = Math.max(startIdx, lookback + 2);

  let i = startIdx;
  while (i < candles5.length) {
    const candleCloseTime = candles5[i].t + CANDLE_MS;
    const closePrice = candles5[i].c;
    const d = new Date(candles5[i].t);
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
    if (!(month in monthlyStart)) monthlyStart[month] = usd;
    monthlyEnd[month] = usd;

    const signal = candles5[i].v >= VOL_MULT * avgVol(candles5, i, lookback);
    if (signal) signalCount++;

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
  const monthly = Object.keys(monthlyStart).sort().map(m => ({
    month: m,
    ret: monthlyStart[m] > 0 ? (monthlyEnd[m] - monthlyStart[m]) / monthlyStart[m] * 100 : 0
  }));
  return { ret, trades: tradesCount, wr, maxDD, finalVal, signalCount, monthly };
}

(async () => {
  const now = Date.now();
  const windowStart = now - 90 * 24 * 60 * 60 * 1000; // 3mo
  const candleFetchStart = windowStart - 30 * CANDLE_MS;

  const symbol = "SOLFDUSD";
  process.stdout.write(`Fetching ${symbol} 5m... `);
  const raw5 = await fetchKlines(symbol, "5m", candleFetchStart, now);
  const c5: C5[] = raw5.map(c => ({ t: +c[0], c: +c[4], v: +c[5] }));
  console.log(`${c5.length}`);
  process.stdout.write(`Fetching ${symbol} 1m... `);
  const raw1 = await fetchKlines(symbol, "1m", windowStart, now);
  const c1: C1[] = raw1.map(c => ({ t: +c[0], h: +c[2], l: +c[3], c: +c[4] }));
  console.log(`${c1.length}`);

  console.log(`\nHighRVOL lookback sweep (20 vs 10 vs 5) · SOLFDUSD · 3mo · TP=0.8%/SL=0.3%\n`);
  for (const lookback of [25, 30]) {
    const r = runSim(c5, c1, windowStart, lookback);
    console.log(`lookback=${lookback}: ${(r.ret>=0?"+":"")+r.ret.toFixed(1)}%   signals=${r.signalCount}   trades=${r.trades}   WR=${r.wr.toFixed(1)}%   maxDD=${r.maxDD.toFixed(1)}%`);
    for (const m of r.monthly) console.log(`    ${m.month}: ${(m.ret>=0?"+":"")+m.ret.toFixed(1)}%`);
  }
})();
