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
    if (res.status === 429) { await sleep(8000); continue; }
    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) out.push({ t: +c[0], c: +c[4] });
    from = +raw[raw.length - 1][0] + 1;
    await sleep(150);
  }
  return out;
}

function runSim(candles: C[], sliceFromMs: number) {
  const startIdx = candles.findIndex(c => c.t >= sliceFromMs);
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

  const firstIdx = Math.max(ZSCORE_WINDOW, startIdx);
  for (let i = firstIdx; i < candles.length; i++) {
    const price = prices[i];
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
  return { ret, trades, wr: trades ? wins/trades*100 : 0, maxDD };
}

(async () => {
  const now = Date.now();
  const fiveYrStart = now - 5 * 365 * 24 * 60 * 60 * 1000;
  const threeYrStart = now - 3 * 365 * 24 * 60 * 60 * 1000;
  const oneYrStart = now - 365 * 24 * 60 * 60 * 1000;

  const coins = ["LINK", "UNI", "DOT", "ATOM"];
  console.log(`Coin     1yr             3yr             5yr`);
  for (const coin of coins) {
    process.stdout.write(`Fetching ${coin}USDT 5m (5yr)... `);
    const candles = await fetchKlines(`${coin}USDT`, "5m", fiveYrStart, now);
    console.log(`${candles.length}`);
    if (candles.length < ZSCORE_WINDOW + 10) { console.log(`  skipping ${coin}, insufficient data`); continue; }

    const r1 = runSim(candles, oneYrStart);
    const r3 = runSim(candles, threeYrStart);
    const r5 = runSim(candles, fiveYrStart);
    console.log(`${coin.padEnd(8)} ${(r1.ret>=0?"+":"")+r1.ret.toFixed(1)}% (dd${r1.maxDD.toFixed(0)}%)   ${(r3.ret>=0?"+":"")+r3.ret.toFixed(1)}% (dd${r3.maxDD.toFixed(0)}%)   ${(r5.ret>=0?"+":"")+r5.ret.toFixed(1)}% (dd${r5.maxDD.toFixed(0)}%)`);
  }
})();
