// 5-year SOL single-asset z-score test, close-only execution (matches how the live bot actually
// runs: polls every 5min via cron, decides off the current close, no resting stop orders).
// Binance Global data, SOLUSDT, 0% fee, per-year breakdown.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const ALLOCATION_USD = 50;
const ZSCORE_WINDOW = 50;
const Z_ENTRY = -2.0;
const TP_PCT = 0.8;
const SL_PCT = 0.3;
const MAX_HOLD = 6;

type C = { t: number; c: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
async function fetchKlines(symbol: string, interval: string, startMs: number, endMs: number): Promise<C[]> {
  const out: C[] = []; let from = startMs;
  while (from < endMs) {
    const res = await fetch(`${BASE}/klines?symbol=${symbol}&interval=${interval}&startTime=${from}&endTime=${endMs}&limit=1000`);
    if (res.status === 429) { await sleep(5000); continue; }
    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) out.push({ t: +c[0], c: +c[4] });
    from = +raw[raw.length - 1][0] + 1;
    await sleep(80);
  }
  return out;
}

function runSim(candles: C[]) {
  const prices = candles.map(c => c.c);
  const zscores: number[] = new Array(candles.length).fill(NaN);
  for (let i = ZSCORE_WINDOW; i < candles.length; i++) {
    const window = prices.slice(i - ZSCORE_WINDOW, i);
    const mean = window.reduce((s, v) => s + v, 0) / window.length;
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
    const std = Math.sqrt(variance);
    zscores[i] = std > 0 ? (prices[i] - mean) / std : 0;
  }

  let usd = ALLOCATION_USD, qty = 0, inTrade = false;
  let entryPrice = 0, entryIdx = 0, trades = 0, wins = 0;
  let peak = ALLOCATION_USD, maxDD = 0;
  const yearlyStart: Record<string, number> = {};
  const yearlyEnd: Record<string, number> = {};

  for (let i = ZSCORE_WINDOW; i < candles.length; i++) {
    const price = prices[i];
    const year = new Date(candles[i].t).getUTCFullYear().toString();
    const eqNow = inTrade ? qty * price : usd;
    if (!(year in yearlyStart)) yearlyStart[year] = eqNow;
    yearlyEnd[year] = eqNow;

    if (!inTrade && zscores[i] <= Z_ENTRY) { entryPrice = price; entryIdx = i; qty = usd / price; usd = 0; inTrade = true; }
    if (inTrade) {
      const curPct = (price - entryPrice) / entryPrice * 100;
      const held = i - entryIdx;
      let closeNow = false;
      if (curPct >= TP_PCT) closeNow = true;
      else if (curPct <= -SL_PCT) closeNow = true;
      else if (held >= MAX_HOLD) closeNow = true;
      if (closeNow) { usd = qty * price; trades++; if (usd > qty * entryPrice) wins++; qty = 0; inTrade = false; }
    }
    const eq = inTrade ? qty * price : usd;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  const finalVal = inTrade ? qty * prices[prices.length-1] : usd;
  const ret = (finalVal - ALLOCATION_USD) / ALLOCATION_USD * 100;
  const wr = trades ? wins/trades*100 : 0;

  const yearly = Object.keys(yearlyStart).sort().map(y => ({
    year: y,
    ret: (yearlyEnd[y] - yearlyStart[y]) / yearlyStart[y] * 100
  }));

  return { ret, trades, wr, maxDD, finalVal, yearly };
}

(async () => {
  const now = Date.now();
  const start = now - 5 * 365 * 24 * 60 * 60 * 1000; // 5yr
  process.stdout.write(`Fetching SOLUSDT 5m (close, 5yr, global)... `);
  const candles = await fetchKlines("SOLUSDT", "5m", start, now);
  console.log(`${candles.length}`);

  const r = runSim(candles);
  console.log(`\nSOL z-score (single-asset, close-only, 0% fee) · 5yr · Binance Global\n`);
  console.log(`Total: ${(r.ret>=0?"+":"")+r.ret.toFixed(1)}%   $${ALLOCATION_USD} -> $${r.finalVal.toFixed(2)}   trades=${r.trades}   WR=${r.wr.toFixed(1)}%   maxDD=${r.maxDD.toFixed(1)}%\n`);
  console.log(`By year:`);
  for (const y of r.yearly) {
    console.log(`  ${y.year}: ${(y.ret>=0?"+":"")+y.ret.toFixed(1)}%`);
  }
})();
