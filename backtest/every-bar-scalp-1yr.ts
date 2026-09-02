// Baseline: bet EVERY 5m candle unconditionally (no VWAP/BB/any armer), TP/SL from CLI args.
// 1-min HL execution. SOLFDUSD.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const ALLOCATION_USD = 50;
const TP_PCT = parseFloat(process.argv[2] ?? "0.1");
const SL_PCT = parseFloat(process.argv[3] ?? "0.1");
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
    await sleep(90);
  }
  return out;
}

function runSim(candles5: C5[], candles1: C1[], windowStartMs: number) {
  let usd = ALLOCATION_USD, qty = 0;
  let tradesCount = 0, wins = 0, tpHits = 0, slHits = 0, stillOpen = 0;
  let peak = ALLOCATION_USD, maxDD = 0;
  let m1Idx = 0;

  let startIdx = candles5.findIndex(c => c.t >= windowStartMs);
  if (startIdx < 0) startIdx = 0;

  let i = startIdx;
  while (i < candles5.length) {
    const candleCloseTime = candles5[i].t + CANDLE_MS;
    const closePrice = candles5[i].c;

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
    while (nextI < candles5.length && candles5[nextI].t + CANDLE_MS <= exitTime) nextI++;
    i = Math.max(nextI, i + 1);
  }

  const finalVal = usd;
  const ret = (finalVal - ALLOCATION_USD) / ALLOCATION_USD * 100;
  const wr = tradesCount ? wins / tradesCount * 100 : 0;
  return { ret, trades: tradesCount, wr, maxDD, finalVal, tpHits, slHits, stillOpen };
}

(async () => {
  const now = Date.now();
  const windowStart = now - 365 * 24 * 60 * 60 * 1000; // 1yr
  const candleFetchStart = windowStart - 10 * CANDLE_MS;

  const symbol = "SOLFDUSD";
  process.stdout.write(`[TP=${TP_PCT}%/SL=${SL_PCT}%] Fetching ${symbol} 5m... `);
  const raw5 = await fetchKlines(symbol, "5m", candleFetchStart, now);
  const c5: C5[] = raw5.map(c => ({ t: +c[0], c: +c[4] }));
  console.log(`${c5.length}`);
  process.stdout.write(`[TP=${TP_PCT}%/SL=${SL_PCT}%] Fetching ${symbol} 1m (1yr, will take a while)... `);
  const raw1 = await fetchKlines(symbol, "1m", windowStart, now);
  const c1: C1[] = raw1.map(c => ({ t: +c[0], h: +c[2], l: +c[3], c: +c[4] }));
  console.log(`${c1.length}`);

  const r = runSim(c5, c1, windowStart);
  console.log(`\nSOLFDUSD every-bar (no filter) · 1mo · TP=${TP_PCT}%/SL=${SL_PCT}%\n`);
  console.log(`${(r.ret>=0?"+":"")+r.ret.toFixed(1)}%   $${r.finalVal.toFixed(2)}   trades=${r.trades}   WR=${r.wr.toFixed(1)}%   maxDD=${r.maxDD.toFixed(1)}%   TP=${r.tpHits} SL=${r.slHits}${r.stillOpen?` (${r.stillOpen} still open)`:""}`);
})();
