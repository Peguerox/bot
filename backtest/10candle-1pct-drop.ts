// Over a rolling 10 five-minute candle window, compute the highest high and lowest low. If
// the drop from high to low is at least 1%, place a resting limit buy at that low point
// (continuously monitored via 1-min data). Once filled: TP=0.8%/SL=0.3%. SOLFDUSD, 3 months.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const ALLOCATION_USD = 50;
const LOOKBACK = 10;
const MIN_DROP_PCT = 1.0;
const TP_PCT = 0.8;
const SL_PCT = 0.3;
const CANDLE_MS = 5 * 60 * 1000;
const MIN_MS = 60 * 1000;

type C5 = { t: number; h: number; l: number };
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
  let tradesCount = 0, wins = 0, tpHits = 0, slHits = 0;
  let peak = ALLOCATION_USD, maxDD = 0;
  let inTrade = false;
  let entryPrice = 0, tp = 0, sl = 0;
  let fills = 0, windowsQualified = 0;

  let c5Idx = 0;
  let start1Idx = candles1.findIndex(c => c.t >= windowStartMs);
  if (start1Idx < 0) start1Idx = 0;

  for (let i = start1Idx; i < candles1.length; i++) {
    const t = candles1[i].t;
    while (c5Idx + 1 < candles5.length && candles5[c5Idx + 1].t + CANDLE_MS <= t) c5Idx++;

    if (!inTrade) {
      if (c5Idx >= LOOKBACK) {
        let highestHigh = -Infinity, lowestLow = Infinity;
        for (let k = c5Idx - LOOKBACK; k < c5Idx; k++) {
          highestHigh = Math.max(highestHigh, candles5[k].h);
          lowestLow = Math.min(lowestLow, candles5[k].l);
        }
        const dropPct = (highestHigh - lowestLow) / highestHigh * 100;
        if (dropPct >= MIN_DROP_PCT) {
          windowsQualified++;
          if (candles1[i].l <= lowestLow) {
            entryPrice = lowestLow;
            tp = entryPrice * (1 + TP_PCT / 100);
            sl = entryPrice * (1 - SL_PCT / 100);
            qty = usd / entryPrice; usd = 0;
            inTrade = true;
            fills++;
            continue;
          }
        }
      }
    } else {
      const hitTP = candles1[i].h >= tp;
      const hitSL = candles1[i].l <= sl;
      let exitPrice: number | null = null, reason = "";
      if (hitTP && hitSL) { exitPrice = sl; reason = "SL"; }
      else if (hitTP) { exitPrice = tp; reason = "TP"; }
      else if (hitSL) { exitPrice = sl; reason = "SL"; }

      if (exitPrice !== null) {
        usd = qty * exitPrice;
        tradesCount++; if (usd > qty * entryPrice) wins++;
        if (reason === "TP") tpHits++; else slHits++;
        qty = 0; inTrade = false;

        const eq = usd;
        if (eq > peak) peak = eq;
        const dd = (peak - eq) / peak * 100;
        if (dd > maxDD) maxDD = dd;
      }
    }
  }

  const finalVal = inTrade ? qty * candles1[candles1.length-1].c : usd;
  const ret = (finalVal - ALLOCATION_USD) / ALLOCATION_USD * 100;
  const wr = tradesCount ? wins / tradesCount * 100 : 0;
  return { ret, trades: tradesCount, wr, maxDD, finalVal, tpHits, slHits, fills };
}

(async () => {
  const now = Date.now();
  const windowStart = now - 90 * 24 * 60 * 60 * 1000; // 3mo
  const candleFetchStart = windowStart - (LOOKBACK + 5) * CANDLE_MS;

  const symbol = "SOLFDUSD";
  process.stdout.write(`Fetching ${symbol} 5m... `);
  const raw5 = await fetchKlines(symbol, "5m", candleFetchStart, now);
  const c5: C5[] = raw5.map(c => ({ t: +c[0], h: +c[2], l: +c[3] }));
  console.log(`${c5.length}`);
  process.stdout.write(`Fetching ${symbol} 1m... `);
  const raw1 = await fetchKlines(symbol, "1m", windowStart, now);
  const c1: C1[] = raw1.map(c => ({ t: +c[0], h: +c[2], l: +c[3], c: +c[4] }));
  console.log(`${c1.length}`);

  const r = runSim(c5, c1, windowStart);
  console.log(`\nSOLFDUSD 10-candle 1%+ drop, buy at low (limit) · 3mo · TP=0.8%/SL=0.3%\n`);
  console.log(`Fills: ${r.fills}`);
  console.log(`${(r.ret>=0?"+":"")+r.ret.toFixed(1)}%   $${r.finalVal.toFixed(2)}   trades=${r.trades}   WR=${r.wr.toFixed(1)}%   maxDD=${r.maxDD.toFixed(1)}%   TP=${r.tpHits} SL=${r.slHits}`);
})();
