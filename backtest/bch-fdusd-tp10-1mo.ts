// Sweeps the z-score lookback window (50/30/10 candles) on BCHFDUSD, 1 month, same execution
// method (1-min HL, no timeout, TP=0.8%/SL=0.3%) as the deployed paper bot.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const ALLOCATION_USD = 50;
const Z_ENTRY = -2.0;
const TP_PCT = 1.0;
const SL_PCT = 0.3;
const CANDLE_MS = 5 * 60 * 1000;
const MIN_MS = 60 * 1000;

type C5 = { t: number; c: number };
type C1 = { t: number; h: number; l: number; c: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
async function fetchKlines(symbol: string, interval: string, startMs: number, endMs: number): Promise<any[]> {
  const out: any[] = []; let from = startMs;
  while (from < endMs) {
    const res = await fetch(`${BASE}/klines?symbol=${symbol}&interval=${interval}&startTime=${from}&endTime=${endMs}&limit=1000`);
    if (res.status === 429) { await sleep(6000); continue; }
    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) out.push(c);
    from = +raw[raw.length - 1][0] + 1;
    await sleep(90);
  }
  return out;
}

function runSim(candles5: C5[], candles1: C1[], windowStartMs: number, zscoreWindow: number) {
  const prices = candles5.map(c => c.c);
  const zscores: number[] = new Array(candles5.length).fill(NaN);
  for (let i = zscoreWindow; i < candles5.length; i++) {
    const window = prices.slice(i - zscoreWindow, i);
    const mean = window.reduce((s, v) => s + v, 0) / window.length;
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
    const std = Math.sqrt(variance);
    zscores[i] = std > 0 ? (prices[i] - mean) / std : 0;
  }

  let usd = ALLOCATION_USD, qty = 0;
  let tradesCount = 0, wins = 0, tpHits = 0, slHits = 0, stillOpen = 0;
  let peak = ALLOCATION_USD, maxDD = 0;
  let m1Idx = 0;

  let startIdx = candles5.findIndex(c => c.t >= windowStartMs);
  startIdx = Math.max(startIdx, zscoreWindow);

  let i = startIdx;
  while (i < candles5.length) {
    const candleCloseTime = candles5[i].t + CANDLE_MS;
    const closePrice = prices[i];

    if (zscores[i] <= Z_ENTRY) {
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
  return { ret, trades: tradesCount, wr, maxDD, finalVal, tpHits, slHits, stillOpen };
}

(async () => {
  const now = Date.now();
  const windowStart = now - 30 * 24 * 60 * 60 * 1000; // 1mo
  const maxWindow = 10;
  const candleFetchStart = windowStart - (maxWindow + 5) * CANDLE_MS;

  const symbol = "BCHFDUSD";
  process.stdout.write(`Fetching ${symbol} 5m... `);
  const raw5 = await fetchKlines(symbol, "5m", candleFetchStart, now);
  const c5: C5[] = raw5.map(c => ({ t: +c[0], c: +c[4] }));
  console.log(`${c5.length}`);
  process.stdout.write(`Fetching ${symbol} 1m... `);
  const raw1 = await fetchKlines(symbol, "1m", windowStart, now);
  const c1: C1[] = raw1.map(c => ({ t: +c[0], h: +c[2], l: +c[3], c: +c[4] }));
  console.log(`${c1.length}`);

  console.log(`\nBCHFDUSD z-score window sweep · 1mo · 1-min HL execution · no timeout · TP=0.8%/SL=0.3%\n`);
  for (const zw of [10, 5]) {
    const r = runSim(c5, c1, windowStart, zw);
    console.log(`window=${String(zw).padEnd(3)}${(r.ret>=0?"+":"")+r.ret.toFixed(1).padStart(8)}%   $${r.finalVal.toFixed(2).padStart(8)}   trades=${String(r.trades).padStart(4)}   WR=${r.wr.toFixed(1).padStart(5)}%   maxDD=${r.maxDD.toFixed(1)}%   TP=${r.tpHits} SL=${r.slHits}`);
  }
})();
