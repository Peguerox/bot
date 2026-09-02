// Volume pattern audit for SOLBTC (arm@6%/trail@7.5pp) — checks entry-time volume (both raw
// and relative to recent average) against trade outcome, looking for a pattern in losers.
// Read-only, does not touch live bots.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE       = "https://api.binance.us/api/v3";
const LOOKBACK   = 365 * 24 * 60 * 60 * 1000;
const RSI_LOW    = 30;
const RSI_HIGH   = 70;
const MA_FAST    = 7;
const MA_SLOW    = 25;
const TRAIL_ARM_PCT  = 6;
const TRAIL_PP       = 7.5;

type OHLCV = { t: number; c: number; v: number };
type C = { t: number; c: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
async function fetchOHLCV(symbol: string, interval: string, startMs: number, endMs: number): Promise<OHLCV[]> {
  const out: OHLCV[] = []; let from = startMs;
  while (from < endMs) {
    const res = await fetch(`${BASE}/klines?symbol=${symbol}&interval=${interval}&startTime=${from}&endTime=${endMs}&limit=1000`);
    if (res.status === 429) { await sleep(5000); continue; }
    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) out.push({ t: +c[0], c: +c[4], v: +c[5] });
    from = +raw[raw.length - 1][0] + 1;
    await sleep(80);
  }
  return out;
}
function calcRSI(candles: C[], period = 14): number[] {
  const rsi: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) { const d = candles[i].c - candles[i-1].c; if (d > 0) avgGain += d; else avgLoss += Math.abs(d); }
  avgGain /= period; avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].c - candles[i-1].c;
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}
function calcEMA(candles: C[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = new Array(candles.length).fill(NaN);
  out[period - 1] = candles.slice(0, period).reduce((a, c) => a + c.c, 0) / period;
  for (let i = period; i < candles.length; i++) out[i] = candles[i].c * k + out[i-1] * (1 - k);
  return out;
}
function volMaAt(c15v: OHLCV[], idx: number, period = 20): number {
  if (idx < period) return NaN;
  let sum = 0; for (let j = idx - period + 1; j <= idx; j++) sum += c15v[j].v;
  return sum / period;
}

type Trade = { entryTime: string; pnlPct: number; entryVol: number; volRatio: number; exitReason: string };

function runSim(c15v: OHLCV[], c12h: C[]): Trade[] {
  const c15: C[] = c15v.map(c => ({ t: c.t, c: c.c }));
  const rsi = calcRSI(c15);
  const f12 = calcEMA(c12h, MA_FAST);
  const s12 = calcEMA(c12h, MA_SLOW);
  const trend12h = c12h.map((c, i) => ({ t: c.t, fast: f12[i], prevFast: i > 0 ? f12[i-1] : NaN, slow: s12[i], close: c.c }));

  function getTrend(t: number, livePrice: number) {
    let idx = -1;
    for (let i = trend12h.length - 1; i >= 0; i--) { if (trend12h[i].t <= t) { idx = i; break; } }
    if (idx < 0) return { bullish: false, sloping: false };
    const { fast, prevFast, slow, close } = trend12h[idx];
    if (isNaN(fast) || isNaN(slow)) return { bullish: false, sloping: false };
    const delta = livePrice - close;
    const liveFast = fast + delta / MA_FAST;
    const liveSlow = slow + delta / MA_SLOW;
    return { bullish: liveFast > liveSlow, sloping: !isNaN(prevFast) && liveFast > prevFast };
  }

  let mode: "BTC" | "SOL" = "BTC";
  let armedForSol = false, armedForBtc = false;
  let entryIdx = 0, bestPct = 0;
  const trades: Trade[] = [];

  for (let i = 1; i < c15.length; i++) {
    if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
    const price = c15[i].c, t = c15[i].t;

    if (rsi[i-1] < RSI_LOW && rsi[i] >= RSI_LOW && mode === "BTC" && !armedForSol) armedForSol = true;
    if (rsi[i-1] > RSI_HIGH && rsi[i] <= RSI_HIGH && mode === "SOL" && !armedForBtc) armedForBtc = true;

    const { bullish, sloping } = getTrend(t, price);

    if (mode === "BTC" && armedForSol && bullish && sloping) {
      entryIdx = i; bestPct = 0;
      mode = "SOL"; armedForSol = false;
    }

    let closeNow = false, reason = "";
    if (mode === "SOL") {
      const entryPrice = c15[entryIdx].c;
      const curPct = (price - entryPrice) / entryPrice * 100;
      if (curPct > bestPct) bestPct = curPct;
      if (bestPct >= TRAIL_ARM_PCT && (bestPct - curPct) >= TRAIL_PP) { closeNow = true; reason = "trail"; }
      else if (armedForBtc && !bullish) { closeNow = true; reason = "trend"; }
    }

    if (closeNow) {
      const entryPrice = c15[entryIdx].c;
      const pnlPct = (price - entryPrice) / entryPrice * 100;
      const entryVol = c15v[entryIdx].v;
      const volMa = volMaAt(c15v, entryIdx, 20);
      const volRatio = !isNaN(volMa) && volMa > 0 ? entryVol / volMa : NaN;
      trades.push({
        entryTime: new Date(c15[entryIdx].t).toISOString().slice(0,10),
        pnlPct, entryVol, volRatio, exitReason: reason,
      });
      mode = "BTC"; armedForBtc = false;
    }
  }
  return trades;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length; const mx = xs.reduce((a,b)=>a+b,0)/n, my = ys.reduce((a,b)=>a+b,0)/n;
  let num=0, dx2=0, dy2=0;
  for (let i=0;i<n;i++){ const dx=xs[i]-mx, dy=ys[i]-my; num+=dx*dy; dx2+=dx*dx; dy2+=dy*dy; }
  return num / Math.sqrt(dx2*dy2);
}
function rank(xs: number[]): number[] {
  const idx = xs.map((v,i)=>[v,i] as [number,number]).sort((a,b)=>a[0]-b[0]);
  const r = new Array(xs.length).fill(0);
  idx.forEach(([_,i], pos) => r[i] = pos+1);
  return r;
}

(async () => {
  const now = Date.now(), start = now - 5 * LOOKBACK;
  process.stdout.write(`Fetching SOLBTC 15m (OHLCV)... `); const c15v = await fetchOHLCV("SOLBTC", "15m", start, now); console.log(`${c15v.length}`);
  process.stdout.write(`Fetching SOLBTC 12h... `); const c12hv = await fetchOHLCV("SOLBTC", "12h", start, now); console.log(`${c12hv.length}`);
  const c12h: C[] = c12hv.map(c => ({ t: c.t, c: c.c }));

  const trades = runSim(c15v, c12h).filter(t => !isNaN(t.volRatio));
  const winners = trades.filter(t => t.pnlPct >= 0);
  const losers  = trades.filter(t => t.pnlPct < 0);

  const volRatios = trades.map(t => t.volRatio);
  const pnls = trades.map(t => t.pnlPct);
  const pr = pearson(volRatios, pnls);
  const sr = pearson(rank(volRatios), rank(pnls));
  console.log(`\nVolume ratio (entry vol / 20-period avg) vs pnl%: pearson r=${pr.toFixed(3)}  spearman ρ=${sr.toFixed(3)}  (n=${trades.length})`);

  const medW = (() => { const s=[...winners.map(t=>t.volRatio)].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; })();
  const medL = (() => { const s=[...losers.map(t=>t.volRatio)].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; })();
  console.log(`Median vol ratio: winners=${medW.toFixed(2)}x  losers=${medL.toFixed(2)}x`);

  const bigLosers = losers.filter(t => t.pnlPct < -5);
  const medBigL = (() => { const s=[...bigLosers.map(t=>t.volRatio)].sort((a,b)=>a-b); return s.length ? s[Math.floor(s.length/2)] : NaN; })();
  console.log(`Median vol ratio for BIG losers (pnl<-5%, n=${bigLosers.length}): ${medBigL.toFixed(2)}x`);

  const sorted = [...trades].sort((a,b) => a.pnlPct - b.pnlPct);
  console.log(`\nWorst 15 trades by pnl — volume ratio at entry:`);
  console.log(`${"entry".padEnd(12)}${"pnl%".padStart(8)}${"volRatio".padStart(10)}${"exitR".padStart(8)}`);
  for (const t of sorted.slice(0, 15)) {
    console.log(`${t.entryTime.padEnd(12)}${t.pnlPct.toFixed(1).padStart(7)}%${t.volRatio.toFixed(2).padStart(9)}x${t.exitReason.padStart(8)}`);
  }

  console.log(`\nBest 15 trades by pnl — volume ratio at entry:`);
  const sortedTop = [...trades].sort((a,b) => b.pnlPct - a.pnlPct);
  for (const t of sortedTop.slice(0, 15)) {
    console.log(`${t.entryTime.padEnd(12)}${t.pnlPct.toFixed(1).padStart(7)}%${t.volRatio.toFixed(2).padStart(9)}x${t.exitReason.padStart(8)}`);
  }
})();
