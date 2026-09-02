// DCA ladder (same mechanics as dca-hyper: $5000 cap, $10/tranche, TP=0.1% above weighted
// avg entry, no SL, 500 max tranches) but gated by an armer — only START a new ladder while
// the favorable condition holds. Once started, a ladder continues every 5m bar regardless of
// arm state (matching the original armed-ladder design) until it hits TP or maxes out capital.
// Tests 3 armers: Bollinger Bands (price < lower BB 20,2), VWAP (price < rolling VWAP20),
// RSI (RSI14 < 30). SOLFDUSD, 5-min, 3mo.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const TOTAL_CAPITAL = 5000;
const TRANCHE_USD = 10;
const TP_PCT = 0.3;
const PERIOD = 20;
const RSI_PERIOD = 14;
const RSI_OVERSOLD = 30;
const ZSCORE_WINDOW = 5;
const Z_ENTRY = -2.0;
const CANDLE_MS = 5 * 60 * 1000;

type C5 = { t: number; c: number; v: number };

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

function calcBBLower(closes: number[], period: number, stdMult: number): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    const window = closes.slice(i - period + 1, i + 1);
    const mean = window.reduce((a, c) => a + c, 0) / period;
    const variance = window.reduce((a, c) => a + (c - mean) ** 2, 0) / period;
    out[i] = mean - stdMult * Math.sqrt(variance);
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
function calcZScore(closes: number[], period: number): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  for (let i = period; i < closes.length; i++) {
    const window = closes.slice(i - period, i);
    const mean = window.reduce((a, c) => a + c, 0) / window.length;
    const variance = window.reduce((a, c) => a + (c - mean) ** 2, 0) / window.length;
    const std = Math.sqrt(variance);
    out[i] = std > 0 ? (closes[i] - mean) / std : 0;
  }
  return out;
}
function calcRSI(closes: number[], period = 14): number[] {
  const rsi: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i-1]; if (d > 0) avgGain += d; else avgLoss += -d; }
  avgGain /= period; avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function runSim(candles5: C5[], windowStartMs: number, favorable: boolean[]) {
  let inLadder = false;
  let totalInvested = 0, totalQty = 0, tranches = 0;
  let laddersCompleted = 0, laddersMaxedOut = 0;
  let realizedPnl = 0;
  let maxTranchesUsed = 0;
  let totalBarsInLadder = 0, curLadderBars = 0;

  let startIdx = candles5.findIndex(c => c.t >= windowStartMs);
  startIdx = Math.max(startIdx, PERIOD);

  let i = startIdx;
  while (i < candles5.length) {
    const price = candles5[i].c;

    if (!inLadder) {
      if (favorable[i]) {
        totalInvested = TRANCHE_USD;
        totalQty = TRANCHE_USD / price;
        tranches = 1;
        inLadder = true;
        curLadderBars = 1;
      }
      i++;
      continue;
    }

    const avgEntry = totalInvested / totalQty;
    const tp = avgEntry * (1 + TP_PCT / 100);

    // TP check via this 5m candle's high isn't available here (close-only series) —
    // use close-crossing as a conservative proxy: exit once close >= tp.
    if (price >= tp) {
      const usdOut = totalQty * tp;
      realizedPnl += usdOut - totalInvested;
      laddersCompleted++;
      totalBarsInLadder += curLadderBars;
      if (tranches >= TOTAL_CAPITAL / TRANCHE_USD) laddersMaxedOut++;
      maxTranchesUsed = Math.max(maxTranchesUsed, tranches);
      inLadder = false; totalInvested = 0; totalQty = 0; tranches = 0; curLadderBars = 0;
      i++;
      continue;
    }

    curLadderBars++;
    if (totalInvested + TRANCHE_USD <= TOTAL_CAPITAL) {
      totalInvested += TRANCHE_USD;
      totalQty += TRANCHE_USD / price;
      tranches++;
    }
    i++;
  }

  const stillOpen = inLadder;
  const lastPrice = candles5.length ? candles5[candles5.length - 1].c : 0;
  const openUnrealized = stillOpen ? (totalQty * lastPrice - totalInvested) : 0;
  const finalVal = TOTAL_CAPITAL + realizedPnl;
  const ret = realizedPnl / TOTAL_CAPITAL * 100;
  const avgLadderBars = laddersCompleted ? totalBarsInLadder / laddersCompleted : 0;

  return {
    ret, realizedPnl, finalVal, laddersCompleted, laddersMaxedOut, maxTranchesUsed,
    avgLadderBars, stillOpen, openUnrealized, openTranches: tranches, openInvested: totalInvested,
  };
}

(async () => {
  const now = Date.now();
  const windowStart = now - 90 * 24 * 60 * 60 * 1000; // 3mo
  const candleFetchStart = windowStart - (PERIOD + 5) * CANDLE_MS;

  const symbol = "SOLFDUSD";
  process.stdout.write(`Fetching ${symbol} 5m (3mo)... `);
  const raw5 = await fetchKlines(symbol, "5m", candleFetchStart, now);
  const c5: C5[] = raw5.map(c => ({ t: +c[0], c: +c[4], v: +c[5] }));
  console.log(`${c5.length}`);

  const closes = c5.map(c => c.c);
  const bbLower = calcBBLower(closes, PERIOD, 2);
  const vwap    = calcRollingVWAP(c5, PERIOD);
  const rsi     = calcRSI(closes, RSI_PERIOD);
  const zscore  = calcZScore(closes, ZSCORE_WINDOW);

  const armers = [
    { name: "BollingerBands", fav: closes.map((c, i) => !isNaN(bbLower[i]) && c < bbLower[i]) },
    { name: "VWAP",           fav: closes.map((c, i) => !isNaN(vwap[i]) && c < vwap[i]) },
    { name: "RSI<30",         fav: rsi.map(r => !isNaN(r) && r < RSI_OVERSOLD) },
    { name: "ZScore<=-2",     fav: zscore.map(z => !isNaN(z) && z <= Z_ENTRY) },
  ];

  console.log(`\nSOLFDUSD DCA ladder, armed variants · 3mo · $${TOTAL_CAPITAL} cap, $${TRANCHE_USD}/tranche, TP=${TP_PCT}%, no SL, 5-min\n`);

  for (const armer of armers) {
    const r = runSim(c5, windowStart, armer.fav);
    console.log(`${armer.name.padEnd(16)} ${(r.ret>=0?"+":"")+r.ret.toFixed(1)}%   $${TOTAL_CAPITAL}->$${r.finalVal.toFixed(2)}   ladders=${r.laddersCompleted}   maxedOut=${r.laddersMaxedOut}   avgBars=${r.avgLadderBars.toFixed(1)} (~${(r.avgLadderBars*5/60).toFixed(1)}h)   ${r.stillOpen ? `STUCK: ${r.openTranches}tr $${r.openInvested} unrealized ${(r.openUnrealized>=0?"+":"")+r.openUnrealized.toFixed(2)}` : "clean at window end"}`);
  }
})();
