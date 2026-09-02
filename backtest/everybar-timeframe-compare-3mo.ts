// Every-bar (no filter) strategy, TP=1.0%/SL=0.1%, compared across different entry candle
// timeframes: 1m, 3m, 5m, 15m (all native Binance intervals). Execution/exit always checked
// via 1-min HL regardless of entry timeframe. SOLFDUSD, 1 month.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const ALLOCATION_USD = 50;
const TP_PCT = 1.0;
const SL_PCT = 0.1;
const MIN_MS = 60 * 1000;

type C = { t: number; c: number };
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
    await sleep(80);
  }
  return out;
}

function runSim(candles: C[], candles1: C1[], windowStartMs: number, candleMs: number) {
  let usd = ALLOCATION_USD, qty = 0;
  let tradesCount = 0, wins = 0, tpHits = 0, slHits = 0, stillOpen = 0;
  let peak = ALLOCATION_USD, maxDD = 0;
  let m1Idx = 0;

  let startIdx = candles.findIndex(c => c.t >= windowStartMs);
  if (startIdx < 0) startIdx = 0;

  let i = startIdx;
  while (i < candles.length) {
    const candleCloseTime = candles[i].t + candleMs;
    const closePrice = candles[i].c;

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

    const eq = usd;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak * 100;
    if (dd > maxDD) maxDD = dd;

    m1Idx = j;
    const exitTime = (candles1[j]?.t ?? entryTime) + MIN_MS;
    let nextI = i;
    while (nextI < candles.length && candles[nextI].t + candleMs <= exitTime) nextI++;
    i = Math.max(nextI, i + 1);
  }

  const finalVal = usd;
  const ret = (finalVal - ALLOCATION_USD) / ALLOCATION_USD * 100;
  const wr = tradesCount ? wins / tradesCount * 100 : 0;
  return { ret, trades: tradesCount, wr, maxDD, finalVal, tpHits, slHits, stillOpen };
}

(async () => {
  const now = Date.now();
  const windowStart = now - 90 * 24 * 60 * 60 * 1000; // 3mo
  const candleFetchStart = windowStart - 20 * 60 * 1000;

  const symbol = "SOLFDUSD";
  process.stdout.write(`Fetching ${symbol} 1m execution data... `);
  const raw1 = await fetchKlines(symbol, "1m", windowStart, now);
  const c1: C1[] = raw1.map(c => ({ t: +c[0], h: +c[2], l: +c[3], c: +c[4] }));
  console.log(`${c1.length}`);

  const results: { name: string; r: ReturnType<typeof runSim> }[] = [];

  const timeframes: [string, string, number][] = [
    ["1m", "1m", 60 * 1000],
    ["3m", "3m", 3 * 60 * 1000],
    ["5m", "5m", 5 * 60 * 1000],
    ["15m", "15m", 15 * 60 * 1000],
  ];

  for (const [name, interval, ms] of timeframes) {
    process.stdout.write(`Fetching ${symbol} ${interval} entry candles... `);
    const raw = await fetchKlines(symbol, interval, candleFetchStart, now);
    const c: C[] = raw.map((x: any) => ({ t: +x[0], c: +x[4] }));
    console.log(`${c.length}`);
    const r = runSim(c, c1, windowStart, ms);
    results.push({ name, r });
  }

  console.log(`\nEvery-bar timeframe comparison · SOLFDUSD · 1mo · TP=1.0%/SL=0.1%\n`);
  for (const { name, r } of results) {
    console.log(`${name.padEnd(6)}${(r.ret>=0?"+":"")+r.ret.toFixed(1).padStart(9)}%   trades=${String(r.trades).padStart(5)}   WR=${r.wr.toFixed(1).padStart(5)}%   maxDD=${r.maxDD.toFixed(1)}%`);
  }
})();
