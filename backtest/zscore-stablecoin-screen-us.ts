// Screens single-asset Z-score mean-reversion (coin's own price vs its rolling 50-candle
// mean, traded against USDT) across multiple established coins — this is the version that
// actually qualifies for Binance.US's 0% stablecoin-pair fee, unlike the direct crypto/crypto
// cross pairs (LINK/AVAX etc.) which don't get that treatment. Same TP/SL/hold (0.8%/0.3%/6
// candles), z<=-2.0, 0% fee, 1yr screening window on Binance.US data. Read-only.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://api.binance.us/api/v3";
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

function runSim(candles: C[]): { ret: number; trades: number; wr: number; maxDD: number } {
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

  for (let i = ZSCORE_WINDOW; i < candles.length; i++) {
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
  const start = now - 90 * 24 * 60 * 60 * 1000; // 3mo screen

  const coins = ["BTC","ETH","SOL","BNB","XRP","ADA","AVAX","DOT","LINK","LTC","BCH","ATOM","UNI","ETC","ALGO"];
  const results: { coin: string; ret: number; trades: number; wr: number; maxDD: number }[] = [];
  for (const coin of coins) {
    process.stdout.write(`Fetching ${coin}USDT 5m... `);
    const candles = await fetchKlines(`${coin}USDT`, "5m", start, now);
    console.log(`${candles.length}`);
    if (candles.length < ZSCORE_WINDOW + 10) { console.log(`  skipping ${coin}, insufficient data`); continue; }
    const r = runSim(candles);
    results.push({ coin, ...r });
  }

  results.sort((a, b) => b.ret - a.ret);
  console.log(`\nSingle-asset Z-score vs USDT · 1yr · Binance.US · 0% fee\n`);
  for (const r of results) {
    console.log(`${r.coin.padEnd(8)}${(r.ret>=0?"+":"")+r.ret.toFixed(1).padStart(9)}%   trades=${String(r.trades).padStart(4)}   WR=${r.wr.toFixed(1).padStart(5)}%   maxDD=${r.maxDD.toFixed(1)}%`);
  }
})();
