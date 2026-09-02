// Window=5 z-score strategy on SOLFDUSD, 3mo, deployed config (TP=1.0%/SL=0.1%), 1-min HL
// execution, conservative tie-break. Compares no-cost vs realistic execution cost, same
// methodology as the every-bar fee-stress test, to see if the filtered/lower-frequency
// z-score signal survives cost better than no-filter every-bar did.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const ALLOCATION_USD = 50;
const ZSCORE_WINDOW = 5;
const Z_ENTRY = -2.0;
const TP_PCT = 1.0;
const SL_PCT = 0.1;
const ROUNDTRIP_COST_PCT = parseFloat(process.argv[2] ?? "0.05");
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
    if (!res.ok) return out;
    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) out.push(c);
    from = +raw[raw.length - 1][0] + 1;
    await sleep(70);
  }
  return out;
}

function runSim(candles5: C5[], candles1: C1[], windowStartMs: number, roundTripCostPct: number, slOnlyCostPct = 0) {
  const prices = candles5.map(c => c.c);
  const zscores: number[] = new Array(candles5.length).fill(NaN);
  for (let i = ZSCORE_WINDOW; i < candles5.length; i++) {
    const window = prices.slice(i - ZSCORE_WINDOW, i);
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
  startIdx = Math.max(startIdx, ZSCORE_WINDOW);

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
        usd = qty * lastPrice * (1 - roundTripCostPct / 100); qty = 0; stillOpen++; break;
      }

      const grossUsd = qty * exitPrice;
      const costPct = reason === "SL" ? roundTripCostPct + slOnlyCostPct : roundTripCostPct;
      usd = grossUsd * (1 - costPct / 100);
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
  const windowStart = now - 90 * 24 * 60 * 60 * 1000; // 3mo
  const candleFetchStart = windowStart - (ZSCORE_WINDOW + 5) * CANDLE_MS;

  const symbol = "SOLFDUSD";
  process.stdout.write(`Fetching ${symbol} 5m... `);
  const raw5 = await fetchKlines(symbol, "5m", candleFetchStart, now);
  const c5: C5[] = raw5.map(c => ({ t: +c[0], c: +c[4] }));
  console.log(`${c5.length}`);
  process.stdout.write(`Fetching ${symbol} 1m (3mo)... `);
  const raw1 = await fetchKlines(symbol, "1m", windowStart, now);
  const c1: C1[] = raw1.map(c => ({ t: +c[0], h: +c[2], l: +c[3], c: +c[4] }));
  console.log(`${c1.length}`);

  console.log(`\nSOLFDUSD z-score window=5 · 3mo · TP=${TP_PCT}%/SL=${SL_PCT}%\n`);

  const noFee = runSim(c5, c1, windowStart, 0);
  console.log(`NO COST (0%):                          ${(noFee.ret>=0?"+":"")+noFee.ret.toFixed(1)}%   $${noFee.finalVal.toFixed(2)}   trades=${noFee.trades}   WR=${noFee.wr.toFixed(1)}%   maxDD=${noFee.maxDD.toFixed(1)}%   TP=${noFee.tpHits} SL=${noFee.slHits}${noFee.stillOpen?` (${noFee.stillOpen} still open)`:""}`);

  const withFee = runSim(c5, c1, windowStart, ROUNDTRIP_COST_PCT);
  console.log(`WITH ${ROUNDTRIP_COST_PCT}% ROUND-TRIP COST (all trades): ${(withFee.ret>=0?"+":"")+withFee.ret.toFixed(1)}%   $${withFee.finalVal.toFixed(2)}   trades=${withFee.trades}   WR=${withFee.wr.toFixed(1)}%   maxDD=${withFee.maxDD.toFixed(1)}%   TP=${withFee.tpHits} SL=${withFee.slHits}${withFee.stillOpen?` (${withFee.stillOpen} still open)`:""}`);

  const slOnly = runSim(c5, c1, windowStart, 0, ROUNDTRIP_COST_PCT);
  console.log(`0% fee, ${ROUNDTRIP_COST_PCT}% SLIPPAGE ON SL-EXITS ONLY:   ${(slOnly.ret>=0?"+":"")+slOnly.ret.toFixed(1)}%   $${slOnly.finalVal.toFixed(2)}   trades=${slOnly.trades}   WR=${slOnly.wr.toFixed(1)}%   maxDD=${slOnly.maxDD.toFixed(1)}%   TP=${slOnly.tpHits} SL=${slOnly.slHits}${slOnly.stillOpen?` (${slOnly.stillOpen} still open)`:""}`);
})();
