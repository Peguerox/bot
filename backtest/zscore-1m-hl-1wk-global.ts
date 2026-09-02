// Z-score strategy validation using 1-minute candle high/low for TP/SL execution (instead of
// raw tick-by-tick trades, which was accurate but too slow to fetch). 1-minute high/low still
// catches virtually every real threshold touch since SL/TP moves of 0.3-0.8% essentially never
// spike and fully reverse within under a minute. Entry signal still from 5m candle closes
// (matches how the live bot actually decides). "SOL and up" coins from the 3mo global screen:
// ETC, BCH, DOT, LINK, BNB, SOL. 1 week window, Binance Global, 0% fee.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const ALLOCATION_USD = 50;
const ZSCORE_WINDOW = 50;
const Z_ENTRY = -2.0;
const TP_PCT = 0.8;
const SL_PCT = 0.3;
const MAX_HOLD = 6; // 5m candles
const CANDLE_MS = 5 * 60 * 1000;
const MAX_HOLD_MS = MAX_HOLD * CANDLE_MS;
const MIN_MS = 60 * 1000;

type C5 = { t: number; c: number };
type C1 = { t: number; h: number; l: number; c: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines5m(symbol: string, startMs: number, endMs: number): Promise<C5[]> {
  const out: C5[] = []; let from = startMs;
  while (from < endMs) {
    const res = await fetch(`${BASE}/klines?symbol=${symbol}&interval=5m&startTime=${from}&endTime=${endMs}&limit=1000`);
    if (res.status === 429) { await sleep(6000); continue; }
    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) out.push({ t: +c[0], c: +c[4] });
    from = +raw[raw.length - 1][0] + 1;
    await sleep(100);
  }
  return out;
}

async function fetchKlines1m(symbol: string, startMs: number, endMs: number): Promise<C1[]> {
  const out: C1[] = []; let from = startMs;
  while (from < endMs) {
    const res = await fetch(`${BASE}/klines?symbol=${symbol}&interval=1m&startTime=${from}&endTime=${endMs}&limit=1000`);
    if (res.status === 429) { await sleep(6000); continue; }
    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) out.push({ t: +c[0], h: +c[2], l: +c[3], c: +c[4] });
    from = +raw[raw.length - 1][0] + 1;
    await sleep(100);
  }
  return out;
}

function runSim(candles5: C5[], candles1: C1[], windowStartMs: number) {
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
  let tradesCount = 0, wins = 0, tpHits = 0, slHits = 0, holdHits = 0;
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
      const exitDeadline = entryTime + MAX_HOLD_MS;
      const tp = entryPrice * (1 + TP_PCT / 100);
      const sl = entryPrice * (1 - SL_PCT / 100);
      qty = usd / entryPrice; usd = 0;

      while (m1Idx < candles1.length && candles1[m1Idx].t + MIN_MS <= entryTime) m1Idx++;

      let j = m1Idx;
      let exitPrice: number | null = null;
      let reason = "";
      while (j < candles1.length && candles1[j].t < exitDeadline) {
        const hitTP = candles1[j].h >= tp;
        const hitSL = candles1[j].l <= sl;
        if (hitTP && hitSL) { exitPrice = sl; reason = "SL"; break; } // conservative
        if (hitTP) { exitPrice = tp; reason = "TP"; break; }
        if (hitSL) { exitPrice = sl; reason = "SL"; break; }
        j++;
      }
      if (exitPrice === null) {
        let lastPrice = entryPrice, k = m1Idx;
        while (k < candles1.length && candles1[k].t < exitDeadline) { lastPrice = candles1[k].c; k++; }
        exitPrice = lastPrice; reason = "HOLD"; j = k;
      }

      usd = qty * exitPrice;
      tradesCount++; if (usd > qty * entryPrice) wins++;
      if (reason === "TP") tpHits++; else if (reason === "SL") slHits++; else holdHits++;
      qty = 0;
      m1Idx = j;

      const eq = usd;
      if (eq > peak) peak = eq;
      const dd = (peak - eq) / peak * 100;
      if (dd > maxDD) maxDD = dd;

      const exitTime = reason === "HOLD" ? exitDeadline : (candles1[j]?.t ?? exitDeadline) + MIN_MS;
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
  return { ret, trades: tradesCount, wr, maxDD, finalVal, tpHits, slHits, holdHits };
}

(async () => {
  const now = Date.now();
  const windowStart = now - 7 * 24 * 60 * 60 * 1000; // 1 week
  const candleFetchStart = windowStart - (ZSCORE_WINDOW + 5) * CANDLE_MS;

  const coins = ["ETC", "BCH", "DOT", "LINK", "BNB", "SOL"];
  const results: any[] = [];

  for (const coin of coins) {
    const symbol = `${coin}USDT`;
    process.stdout.write(`Fetching ${symbol} 5m candles... `);
    const c5 = await fetchKlines5m(symbol, candleFetchStart, now);
    console.log(`${c5.length}`);
    process.stdout.write(`Fetching ${symbol} 1m candles... `);
    const c1 = await fetchKlines1m(symbol, windowStart, now);
    console.log(`${c1.length}`);

    if (c5.length < ZSCORE_WINDOW + 10) { console.log(`  skipping ${coin}, insufficient data`); continue; }

    const r = runSim(c5, c1, windowStart);
    results.push({ coin, ...r });
  }

  results.sort((a, b) => b.ret - a.ret);
  console.log(`\nZ-score, 1-min high/low execution · 1 week · Binance Global · 0% fee\n`);
  for (const r of results) {
    console.log(`${r.coin.padEnd(6)}${(r.ret >= 0 ? "+" : "") + r.ret.toFixed(1).padStart(8)}%   $${r.finalVal.toFixed(2).padStart(8)}   trades=${String(r.trades).padStart(3)}   WR=${r.wr.toFixed(1).padStart(5)}%   maxDD=${r.maxDD.toFixed(1)}%   TP=${r.tpHits} SL=${r.slHits} HOLD=${r.holdHits}`);
  }
})();
