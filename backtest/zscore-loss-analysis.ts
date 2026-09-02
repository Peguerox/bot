// Logs every z-score strategy trade (window=5, TP=0.8%/SL=0.3%) with context features —
// z-score magnitude at entry, trend context (price vs EMA100), hour of day (UTC), day of
// week — then breaks down win rate by each dimension to look for a pattern in the losses.
// BTCFDUSD, 1 year.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const ALLOCATION_USD = 50;
const ZSCORE_WINDOW = 5;
const Z_ENTRY = -2.0;
const EMA_TREND_PERIOD = 100;
const TP_PCT = 0.8;
const SL_PCT = 0.3;
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
    await sleep(70);
  }
  return out;
}

function calcEMA(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period) return out;
  out[period - 1] = closes.slice(0, period).reduce((a, c) => a + c, 0) / period;
  for (let i = period; i < closes.length; i++) out[i] = closes[i] * k + out[i - 1] * (1 - k);
  return out;
}

type TradeLog = { win: boolean; zAtEntry: number; uptrend: boolean; hour: number; dow: number };

function runSim(candles5: C5[], candles1: C1[], windowStartMs: number) {
  const closes = candles5.map(c => c.c);
  const zscores: number[] = new Array(closes.length).fill(NaN);
  for (let i = ZSCORE_WINDOW; i < closes.length; i++) {
    const window = closes.slice(i - ZSCORE_WINDOW, i);
    const mean = window.reduce((s, v) => s + v, 0) / window.length;
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
    const std = Math.sqrt(variance);
    zscores[i] = std > 0 ? (closes[i] - mean) / std : 0;
  }
  const ema100 = calcEMA(closes, EMA_TREND_PERIOD);

  let usd = ALLOCATION_USD, qty = 0;
  let m1Idx = 0;
  const trades: TradeLog[] = [];

  let startIdx = candles5.findIndex(c => c.t >= windowStartMs);
  startIdx = Math.max(startIdx, ZSCORE_WINDOW, EMA_TREND_PERIOD);

  let i = startIdx;
  while (i < candles5.length) {
    const candleCloseTime = candles5[i].t + CANDLE_MS;
    const closePrice = closes[i];

    if (zscores[i] <= Z_ENTRY) {
      const entryPrice = closePrice;
      const entryTime = candleCloseTime;
      const tp = entryPrice * (1 + TP_PCT / 100);
      const sl = entryPrice * (1 - SL_PCT / 100);
      qty = usd / entryPrice; usd = 0;

      const d = new Date(candles5[i].t);
      const zAtEntry = zscores[i];
      const uptrend = !isNaN(ema100[i]) && closePrice > ema100[i];
      const hour = d.getUTCHours();
      const dow = d.getUTCDay();

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
        usd = qty * lastPrice; qty = 0; break;
      }

      usd = qty * exitPrice;
      const win = usd > qty * entryPrice;
      trades.push({ win, zAtEntry, uptrend, hour, dow });
      qty = 0;
      m1Idx = j;

      const exitTime = (candles1[j]?.t ?? entryTime) + MIN_MS;
      let nextI = i;
      while (nextI < candles5.length && candles5[nextI].t + CANDLE_MS <= exitTime) nextI++;
      i = Math.max(nextI, i + 1);
      continue;
    }
    i++;
  }

  return trades;
}

function wr(trades: TradeLog[]): string {
  if (!trades.length) return "n/a";
  const wins = trades.filter(t => t.win).length;
  return `${(wins/trades.length*100).toFixed(1)}% (n=${trades.length})`;
}

(async () => {
  const now = Date.now();
  const windowStart = now - 365 * 24 * 60 * 60 * 1000; // 1yr
  const candleFetchStart = windowStart - (EMA_TREND_PERIOD + 5) * CANDLE_MS;

  const symbol = "BTCFDUSD";
  process.stdout.write(`Fetching ${symbol} 5m... `);
  const raw5 = await fetchKlines(symbol, "5m", candleFetchStart, now);
  const c5: C5[] = raw5.map(c => ({ t: +c[0], c: +c[4] }));
  console.log(`${c5.length}`);
  process.stdout.write(`Fetching ${symbol} 1m (1yr, will take a while)... `);
  const raw1 = await fetchKlines(symbol, "1m", windowStart, now);
  const c1: C1[] = raw1.map(c => ({ t: +c[0], h: +c[2], l: +c[3], c: +c[4] }));
  console.log(`${c1.length}`);

  const trades = runSim(c5, c1, windowStart);
  console.log(`\nTotal trades: ${trades.length}, overall WR: ${wr(trades)}\n`);

  console.log(`WR by trend context (price vs EMA100 at entry):`);
  console.log(`  Uptrend (price > EMA100):   ${wr(trades.filter(t => t.uptrend))}`);
  console.log(`  Downtrend (price < EMA100): ${wr(trades.filter(t => !t.uptrend))}`);

  console.log(`\nWR by z-score magnitude at entry:`);
  console.log(`  -2.0 to -2.5: ${wr(trades.filter(t => t.zAtEntry > -2.5))}`);
  console.log(`  -2.5 to -3.0: ${wr(trades.filter(t => t.zAtEntry <= -2.5 && t.zAtEntry > -3.0))}`);
  console.log(`  -3.0 to -4.0: ${wr(trades.filter(t => t.zAtEntry <= -3.0 && t.zAtEntry > -4.0))}`);
  console.log(`  beyond -4.0:  ${wr(trades.filter(t => t.zAtEntry <= -4.0))}`);

  console.log(`\nWR by hour of day (UTC):`);
  for (let h = 0; h < 24; h += 4) {
    console.log(`  ${String(h).padStart(2,"0")}-${String(h+3).padStart(2,"0")}h: ${wr(trades.filter(t => t.hour >= h && t.hour < h+4))}`);
  }

  console.log(`\nWR by day of week:`);
  const dowNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  for (let d = 0; d < 7; d++) {
    console.log(`  ${dowNames[d]}: ${wr(trades.filter(t => t.dow === d))}`);
  }
})();
