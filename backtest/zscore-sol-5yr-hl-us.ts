// 5-year SOL single-asset z-score test using realistic high/low-aware TP/SL execution
// (per audit in zscore-audit-hl-us.ts). Binance Global data, SOLUSDT, 0% fee, per-year breakdown.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const ALLOCATION_USD = 50;
const ZSCORE_WINDOW = 50;
const Z_ENTRY = -2.0;
const TP_PCT = 0.8;
const SL_PCT = 0.3;
const MAX_HOLD = 6;

type OHLC = { t: number; o: number; h: number; l: number; c: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
async function fetchKlines(symbol: string, interval: string, startMs: number, endMs: number): Promise<OHLC[]> {
  const out: OHLC[] = []; let from = startMs;
  while (from < endMs) {
    const res = await fetch(`${BASE}/klines?symbol=${symbol}&interval=${interval}&startTime=${from}&endTime=${endMs}&limit=1000`);
    if (res.status === 429) { await sleep(5000); continue; }
    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) out.push({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4] });
    from = +raw[raw.length - 1][0] + 1;
    await sleep(80);
  }
  return out;
}

function runSim(candles: OHLC[]) {
  const closes = candles.map(c => c.c);
  const zscores: number[] = new Array(candles.length).fill(NaN);
  for (let i = ZSCORE_WINDOW; i < candles.length; i++) {
    const window = closes.slice(i - ZSCORE_WINDOW, i);
    const mean = window.reduce((s, v) => s + v, 0) / window.length;
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
    const std = Math.sqrt(variance);
    zscores[i] = std > 0 ? (closes[i] - mean) / std : 0;
  }

  let usd = ALLOCATION_USD, qty = 0, inTrade = false;
  let entryPrice = 0, entryIdx = 0, trades = 0, wins = 0;
  let peak = ALLOCATION_USD, maxDD = 0;
  const yearlyStart: Record<string, number> = {};
  const yearlyEnd: Record<string, number> = {};

  for (let i = ZSCORE_WINDOW; i < candles.length; i++) {
    const closePrice = candles[i].c;
    const year = new Date(candles[i].t).getUTCFullYear().toString();
    const eqNow = inTrade ? qty * closePrice : usd;
    if (!(year in yearlyStart)) yearlyStart[year] = eqNow;
    yearlyEnd[year] = eqNow;

    if (!inTrade && zscores[i] <= Z_ENTRY) { entryPrice = closePrice; entryIdx = i; qty = usd / closePrice; usd = 0; inTrade = true; }

    if (inTrade) {
      const held = i - entryIdx;
      let exitPrice: number | null = null;
      if (held > 0) {
        const tpPrice = entryPrice * (1 + TP_PCT / 100);
        const slPrice = entryPrice * (1 - SL_PCT / 100);
        const hitTP = candles[i].h >= tpPrice;
        const hitSL = candles[i].l <= slPrice;
        if (hitTP && hitSL) exitPrice = slPrice; // conservative: assume SL first
        else if (hitTP) exitPrice = tpPrice;
        else if (hitSL) exitPrice = slPrice;
      }
      if (exitPrice === null && held >= MAX_HOLD) exitPrice = closePrice;

      if (exitPrice !== null) {
        usd = qty * exitPrice;
        trades++; if (usd > qty * entryPrice) wins++;
        qty = 0; inTrade = false;
      }
    }
    const eq = inTrade ? qty * closePrice : usd;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  const finalVal = inTrade ? qty * closes[closes.length-1] : usd;
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
  process.stdout.write(`Fetching SOLUSDT 5m (OHLC, 5yr, global)... `);
  const candles = await fetchKlines("SOLUSDT", "5m", start, now);
  console.log(`${candles.length}`);

  const r = runSim(candles);
  console.log(`\nSOL z-score (single-asset, HL-aware, 0% fee) · 5yr · Binance Global\n`);
  console.log(`Total: ${(r.ret>=0?"+":"")+r.ret.toFixed(1)}%   $${ALLOCATION_USD} -> $${r.finalVal.toFixed(2)}   trades=${r.trades}   WR=${r.wr.toFixed(1)}%   maxDD=${r.maxDD.toFixed(1)}%\n`);
  console.log(`By year:`);
  for (const y of r.yearly) {
    console.log(`  ${y.year}: ${(y.ret>=0?"+":"")+y.ret.toFixed(1)}%`);
  }
})();
