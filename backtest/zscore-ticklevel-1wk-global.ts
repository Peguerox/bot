// True tick-level (aggTrades) validation of the z-score strategy for the "SOL and up" coins
// from the 3mo realistic screen (ETC, BCH, DOT, LINK, BNB, SOL), over the last 1 week.
// Entry signal still comes from 5m candle closes (matches how the live bot actually decides,
// since it polls every 5min). But once in a trade, walks forward through the REAL trade-by-
// trade tick stream to find the exact chronological moment TP or SL was actually touched —
// no more "which hit first" ambiguity like the high/low-candle approximation had.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const ALLOCATION_USD = 50;
const ZSCORE_WINDOW = 50;
const Z_ENTRY = -2.0;
const TP_PCT = 0.8;
const SL_PCT = 0.3;
const MAX_HOLD = 6; // candles
const CANDLE_MS = 5 * 60 * 1000;
const MAX_HOLD_MS = MAX_HOLD * CANDLE_MS;

type C = { t: number; c: number };
type T = { t: number; p: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string, startMs: number, endMs: number): Promise<C[]> {
  const out: C[] = []; let from = startMs;
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

async function fetchAggTrades(symbol: string, startMs: number, endMs: number): Promise<T[]> {
  const out: T[] = []; let from = startMs;
  while (from < endMs) {
    const res = await fetch(`${BASE}/aggTrades?symbol=${symbol}&startTime=${from}&endTime=${endMs}&limit=1000`);
    if (res.status === 429) { await sleep(6000); continue; }
    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || !raw.length) break;
    for (const t of raw) out.push({ t: +t.T, p: +t.p });
    const lastT = +raw[raw.length - 1].T;
    if (lastT <= from) from = from + 1; else from = lastT + 1;
    await sleep(120);
  }
  return out;
}

function runTickSim(candles: C[], trades: T[], windowStartMs: number) {
  const prices = candles.map(c => c.c);
  const zscores: number[] = new Array(candles.length).fill(NaN);
  for (let i = ZSCORE_WINDOW; i < candles.length; i++) {
    const window = prices.slice(i - ZSCORE_WINDOW, i);
    const mean = window.reduce((s, v) => s + v, 0) / window.length;
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
    const std = Math.sqrt(variance);
    zscores[i] = std > 0 ? (prices[i] - mean) / std : 0;
  }

  let usd = ALLOCATION_USD, qty = 0;
  let tradesCount = 0, wins = 0, tpHits = 0, slHits = 0, holdHits = 0;
  let peak = ALLOCATION_USD, maxDD = 0;
  let tradeIdx = 0;

  let startIdx = candles.findIndex(c => c.t >= windowStartMs);
  startIdx = Math.max(startIdx, ZSCORE_WINDOW);

  let i = startIdx;
  while (i < candles.length) {
    const candleCloseTime = candles[i].t + CANDLE_MS;
    const closePrice = prices[i];

    if (zscores[i] <= Z_ENTRY) {
      const entryPrice = closePrice;
      const entryTime = candleCloseTime;
      const exitDeadline = entryTime + MAX_HOLD_MS;
      const tp = entryPrice * (1 + TP_PCT / 100);
      const sl = entryPrice * (1 - SL_PCT / 100);
      qty = usd / entryPrice; usd = 0;

      while (tradeIdx < trades.length && trades[tradeIdx].t < entryTime) tradeIdx++;

      let j = tradeIdx;
      let exitPrice: number | null = null;
      let reason = "";
      while (j < trades.length && trades[j].t < exitDeadline) {
        const p = trades[j].p;
        if (p >= tp) { exitPrice = tp; reason = "TP"; break; }
        if (p <= sl) { exitPrice = sl; reason = "SL"; break; }
        j++;
      }
      if (exitPrice === null) {
        let lastPrice = entryPrice, k = tradeIdx;
        while (k < trades.length && trades[k].t < exitDeadline) { lastPrice = trades[k].p; k++; }
        exitPrice = lastPrice; reason = "HOLD"; j = k;
      }

      usd = qty * exitPrice;
      tradesCount++; if (usd > qty * entryPrice) wins++;
      if (reason === "TP") tpHits++; else if (reason === "SL") slHits++; else holdHits++;
      qty = 0;
      tradeIdx = j;

      const eq = usd;
      if (eq > peak) peak = eq;
      const dd = (peak - eq) / peak * 100;
      if (dd > maxDD) maxDD = dd;

      // advance i to the candle covering the exit moment (approx by exitDeadline or actual exit time)
      const exitTime = reason === "HOLD" ? exitDeadline : (trades[j - 1]?.t ?? exitDeadline);
      let nextI = i;
      while (nextI < candles.length && candles[nextI].t + CANDLE_MS <= exitTime) nextI++;
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
  const candleFetchStart = windowStart - (ZSCORE_WINDOW + 5) * CANDLE_MS; // buffer for z-score

  const coins = ["ETC", "BCH", "DOT", "LINK", "BNB", "SOL"]; // "SOL and up" from the 3mo global screen
  const results: any[] = [];

  for (const coin of coins) {
    const symbol = `${coin}USDT`;
    process.stdout.write(`Fetching ${symbol} candles... `);
    const candles = await fetchKlines(symbol, candleFetchStart, now);
    console.log(`${candles.length} candles`);

    process.stdout.write(`Fetching ${symbol} aggTrades (1wk)... `);
    const trades = await fetchAggTrades(symbol, windowStart, now);
    console.log(`${trades.length} trades`);

    if (candles.length < ZSCORE_WINDOW + 10) { console.log(`  skipping ${coin}, insufficient candle data`); continue; }

    const r = runTickSim(candles, trades, windowStart);
    results.push({ coin, ...r });
  }

  results.sort((a, b) => b.ret - a.ret);
  console.log(`\nZ-score, TRUE tick-level execution (real aggTrades) · 1 week · Binance Global · 0% fee\n`);
  for (const r of results) {
    console.log(`${r.coin.padEnd(6)}${(r.ret >= 0 ? "+" : "") + r.ret.toFixed(1).padStart(8)}%   $${r.finalVal.toFixed(2).padStart(8)}   trades=${String(r.trades).padStart(3)}   WR=${r.wr.toFixed(1).padStart(5)}%   maxDD=${r.maxDD.toFixed(1)}%   TP=${r.tpHits} SL=${r.slHits} HOLD=${r.holdHits}`);
  }
})();
