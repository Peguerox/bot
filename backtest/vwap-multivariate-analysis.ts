// Multivariate follow-up to the univariate loss analysis: (1) 2-way interaction cross-tabs
// between trend/distance/hour, (2) a simple logistic regression combining all features to
// check for any combined learnable signal. SOLFDUSD VWAP-armed scalp, 1 year.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const ALLOCATION_USD = 50;
const VWAP_PERIOD = 20;
const EMA_TREND_PERIOD = 100;
const TP_PCT = 0.5;
const SL_PCT = 0.1;
const CANDLE_MS = 5 * 60 * 1000;
const MIN_MS = 60 * 1000;

type C5 = { t: number; c: number; v: number };
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

function calcRollingVWAP(candles: C5[], period: number): number[] {
  const out: number[] = new Array(candles.length).fill(NaN);
  for (let i = period - 1; i < candles.length; i++) {
    let pv = 0, vol = 0;
    for (let k = i - period + 1; k <= i; k++) { pv += candles[k].c * candles[k].v; vol += candles[k].v; }
    out[i] = vol > 0 ? pv / vol : NaN;
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
function calcATR(candles1: C1[], period = 14): number[] {
  // approximate ATR on 1m data collapsed to per-5m-candle avg true range over trailing period*5 1m bars
  return [];
}

type TradeLog = {
  win: boolean; distBelowVwap: number; uptrend: boolean; hour: number; dow: number;
};

function runSim(candles5: C5[], candles1: C1[], windowStartMs: number) {
  const closes = candles5.map(c => c.c);
  const vwap = calcRollingVWAP(candles5, VWAP_PERIOD);
  const ema100 = calcEMA(closes, EMA_TREND_PERIOD);

  let usd = ALLOCATION_USD, qty = 0;
  let m1Idx = 0;
  const trades: TradeLog[] = [];

  let startIdx = candles5.findIndex(c => c.t >= windowStartMs);
  startIdx = Math.max(startIdx, VWAP_PERIOD, EMA_TREND_PERIOD);

  let i = startIdx;
  while (i < candles5.length) {
    const candleCloseTime = candles5[i].t + CANDLE_MS;
    const closePrice = closes[i];
    const favorable = !isNaN(vwap[i]) && closePrice < vwap[i];

    if (favorable) {
      const entryPrice = closePrice;
      const entryTime = candleCloseTime;
      const tp = entryPrice * (1 + TP_PCT / 100);
      const sl = entryPrice * (1 - SL_PCT / 100);
      qty = usd / entryPrice; usd = 0;

      const d = new Date(candles5[i].t);
      const distBelowVwap = (vwap[i] - closePrice) / vwap[i] * 100;
      const uptrend = !isNaN(ema100[i]) && closePrice > ema100[i];
      const hour = d.getUTCHours();
      const dow = d.getUTCDay();

      while (m1Idx < candles1.length && candles1[m1Idx].t + MIN_MS <= entryTime) m1Idx++;

      let j = m1Idx;
      let exitPrice: number | null = null;
      while (j < candles1.length) {
        const hitTP = candles1[j].h >= tp;
        const hitSL = candles1[j].l <= sl;
        if (hitTP && hitSL) { exitPrice = sl; break; }
        if (hitTP) { exitPrice = tp; break; }
        if (hitSL) { exitPrice = sl; break; }
        j++;
      }
      if (exitPrice === null) {
        const lastPrice = candles1.length ? candles1[candles1.length - 1].c : entryPrice;
        usd = qty * lastPrice; qty = 0; break;
      }

      usd = qty * exitPrice;
      const win = usd > qty * entryPrice;
      trades.push({ win, distBelowVwap, uptrend, hour, dow });
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

function wr(trades: TradeLog[]): { pct: number; n: number } {
  if (!trades.length) return { pct: NaN, n: 0 };
  const wins = trades.filter(t => t.win).length;
  return { pct: wins / trades.length * 100, n: trades.length };
}

// simple logistic regression via gradient descent
function logisticRegression(X: number[][], y: number[], epochs = 2000, lr = 0.1) {
  const n = X.length, d = X[0].length;
  let w = new Array(d).fill(0);
  let b = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array(d).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let k = 0; k < d; k++) z += w[k] * X[i][k];
      const p = 1 / (1 + Math.exp(-z));
      const err = p - y[i];
      for (let k = 0; k < d; k++) gradW[k] += err * X[i][k];
      gradB += err;
    }
    for (let k = 0; k < d; k++) w[k] -= lr * gradW[k] / n;
    b -= lr * gradB / n;
  }
  return { w, b };
}

function standardize(col: number[]): { z: number[]; mean: number; std: number } {
  const mean = col.reduce((a, v) => a + v, 0) / col.length;
  const variance = col.reduce((a, v) => a + (v - mean) ** 2, 0) / col.length;
  const std = Math.sqrt(variance) || 1;
  return { z: col.map(v => (v - mean) / std), mean, std };
}

(async () => {
  const now = Date.now();
  const windowStart = now - 365 * 24 * 60 * 60 * 1000; // 1yr
  const candleFetchStart = windowStart - (EMA_TREND_PERIOD + 5) * CANDLE_MS;

  const symbol = "SOLFDUSD";
  process.stdout.write(`Fetching ${symbol} 5m... `);
  const raw5 = await fetchKlines(symbol, "5m", candleFetchStart, now);
  const c5: C5[] = raw5.map(c => ({ t: +c[0], c: +c[4], v: +c[5] }));
  console.log(`${c5.length}`);
  process.stdout.write(`Fetching ${symbol} 1m (1yr, will take a while)... `);
  const raw1 = await fetchKlines(symbol, "1m", windowStart, now);
  const c1: C1[] = raw1.map(c => ({ t: +c[0], h: +c[2], l: +c[3], c: +c[4] }));
  console.log(`${c1.length}`);

  const trades = runSim(c5, c1, windowStart);
  console.log(`\nTotal trades: ${trades.length}\n`);

  // ── 2-way interactions ──────────────────────────────────────────────
  console.log(`Interaction: trend × distance-below-VWAP bucket\n`);
  const distBuckets: [string, (t: TradeLog) => boolean][] = [
    ["near (≤0.1%)", t => t.distBelowVwap <= 0.1],
    ["far (>0.1%)", t => t.distBelowVwap > 0.1],
  ];
  for (const uptrendVal of [true, false]) {
    for (const [name, check] of distBuckets) {
      const subset = trades.filter(t => t.uptrend === uptrendVal && check(t));
      const r = wr(subset);
      console.log(`  ${uptrendVal ? "uptrend  " : "downtrend"} × ${name.padEnd(14)}: ${r.pct.toFixed(1)}% (n=${r.n})`);
    }
  }

  console.log(`\nInteraction: trend × hour block\n`);
  for (const uptrendVal of [true, false]) {
    for (let h = 0; h < 24; h += 6) {
      const subset = trades.filter(t => t.uptrend === uptrendVal && t.hour >= h && t.hour < h + 6);
      const r = wr(subset);
      console.log(`  ${uptrendVal ? "uptrend  " : "downtrend"} × ${String(h).padStart(2,"0")}-${String(h+5).padStart(2,"0")}h: ${r.pct.toFixed(1)}% (n=${r.n})`);
    }
  }

  // ── Logistic regression on all features combined ──────────────────
  const distCol = trades.map(t => t.distBelowVwap);
  const trendCol = trades.map(t => t.uptrend ? 1 : 0);
  const hourSinCol = trades.map(t => Math.sin(2 * Math.PI * t.hour / 24));
  const hourCosCol = trades.map(t => Math.cos(2 * Math.PI * t.hour / 24));
  const weekendCol = trades.map(t => (t.dow === 0 || t.dow === 6) ? 1 : 0);
  const y = trades.map(t => t.win ? 1 : 0);

  const distZ = standardize(distCol).z;
  const hourSinZ = standardize(hourSinCol).z;
  const hourCosZ = standardize(hourCosCol).z;

  const X = trades.map((_, i) => [distZ[i], trendCol[i], hourSinZ[i], hourCosZ[i], weekendCol[i]]);
  const { w, b } = logisticRegression(X, y, 1500, 0.3);

  // in-sample accuracy at 0.5 threshold, and compare to always-predict-majority baseline
  let correct = 0;
  for (let i = 0; i < X.length; i++) {
    let z = b;
    for (let k = 0; k < w.length; k++) z += w[k] * X[i][k];
    const p = 1 / (1 + Math.exp(-z));
    const pred = p >= 0.5 ? 1 : 0;
    if (pred === y[i]) correct++;
  }
  const baselineAcc = Math.max(y.filter(v => v === 1).length, y.filter(v => v === 0).length) / y.length * 100;
  const modelAcc = correct / X.length * 100;

  console.log(`\nLogistic regression (in-sample, all features combined):`);
  console.log(`  Coefficients: distBelowVwap=${w[0].toFixed(4)}  uptrend=${w[1].toFixed(4)}  hourSin=${w[2].toFixed(4)}  hourCos=${w[3].toFixed(4)}  weekend=${w[4].toFixed(4)}  bias=${b.toFixed(4)}`);
  console.log(`  Model accuracy:    ${modelAcc.toFixed(2)}%`);
  console.log(`  Baseline accuracy (always predict majority class "loss"): ${baselineAcc.toFixed(2)}%`);
  console.log(`  Improvement over baseline: ${(modelAcc - baselineAcc).toFixed(2)} points`);
})();
