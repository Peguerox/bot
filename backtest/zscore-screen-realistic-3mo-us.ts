// Redo of the original 15-coin single-asset z-score screen, but using realistic high/low-aware
// TP/SL execution (checks if price actually touched the stop/target intra-candle) instead of
// the flawed close-only version used in the original screen. 3mo window, Binance.US, 0% fee.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://api.binance.us/api/v3";
const ALLOCATION_USD = 50;
const ZSCORE_WINDOW = 50;
const Z_ENTRY = -2.0;
const TP_PCT = 0.8;
const SL_PCT = 0.3;
const MAX_HOLD = 6;

type OHLC = { t: number; h: number; l: number; c: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
async function fetchKlines(symbol: string, interval: string, startMs: number, endMs: number): Promise<OHLC[]> {
  const out: OHLC[] = []; let from = startMs;
  while (from < endMs) {
    const res = await fetch(`${BASE}/klines?symbol=${symbol}&interval=${interval}&startTime=${from}&endTime=${endMs}&limit=1000`);
    if (res.status === 429) { await sleep(6000); continue; }
    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) out.push({ t: +c[0], h: +c[2], l: +c[3], c: +c[4] });
    from = +raw[raw.length - 1][0] + 1;
    await sleep(120);
  }
  return out;
}

function runSim(candles: OHLC[]): { ret: number; trades: number; wr: number; maxDD: number } {
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

  for (let i = ZSCORE_WINDOW; i < candles.length; i++) {
    const closePrice = candles[i].c;
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
  return { ret, trades, wr: trades ? wins/trades*100 : 0, maxDD };
}

(async () => {
  const now = Date.now();
  const start = now - 90 * 24 * 60 * 60 * 1000; // 3mo

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
  console.log(`\nSingle-asset Z-score vs USDT · 3mo · Binance.US · realistic HL execution · 0% fee\n`);
  for (const r of results) {
    console.log(`${r.coin.padEnd(8)}${(r.ret>=0?"+":"")+r.ret.toFixed(1).padStart(9)}%   trades=${String(r.trades).padStart(4)}   WR=${r.wr.toFixed(1).padStart(5)}%   maxDD=${r.maxDD.toFixed(1)}%`);
  }
})();
