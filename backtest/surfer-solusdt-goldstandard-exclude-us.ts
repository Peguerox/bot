// Concentration check for the SOLUSDT gold standard (-6% hard stop + trailing arm@8%/trail@10pp):
// how much of the total return depends on the top 1/2/3 trades. Mirrors the SOLBTC check.
// Read-only, does not touch live bots.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE       = "https://api.binance.us/api/v3";
const RSI_LOW    = 30;
const MA_FAST    = 7;
const MA_SLOW    = 25;
const HARD_STOP_PCT = -6;
const TRAIL_ARM_PCT = 8;
const TRAIL_PP      = 10;

type C = { t: number; c: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string, interval: string, startMs: number, endMs: number): Promise<C[]> {
  const out: C[] = [];
  let from = startMs;
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

function calcRSI(candles: C[], period = 14): number[] {
  const rsi: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].c - candles[i-1].c;
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
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

type Trade = { entryTime: string; exitTime: string; pnlPct: number };

function runSim(c15: C[], c12h: C[]): Trade[] {
  const rsi = calcRSI(c15);
  const f12 = calcEMA(c12h, MA_FAST);
  const s12 = calcEMA(c12h, MA_SLOW);

  const trend12h: { t: number; fast: number; prevFast: number; slow: number; close: number }[] = c12h.map((c, i) => ({
    t: c.t, fast: f12[i], prevFast: i > 0 ? f12[i-1] : NaN, slow: s12[i], close: c.c,
  }));

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

  let mode: "USDT" | "SOL" = "USDT";
  let armedForSol = false;
  let entryIdx = 0, bestPct = 0;
  const trades: Trade[] = [];

  for (let i = 1; i < c15.length; i++) {
    if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
    const price = c15[i].c;
    const t     = c15[i].t;

    if (rsi[i-1] < RSI_LOW && rsi[i] >= RSI_LOW && mode === "USDT" && !armedForSol) armedForSol = true;

    const { bullish, sloping } = getTrend(t, price);

    if (mode === "USDT" && armedForSol && bullish && sloping) {
      entryIdx = i; bestPct = 0;
      mode = "SOL"; armedForSol = false;
    }

    let closeNow = false;
    if (mode === "SOL") {
      const entryPrice = c15[entryIdx].c;
      const curPct = (price - entryPrice) / entryPrice * 100;
      if (curPct > bestPct) bestPct = curPct;

      if (curPct <= HARD_STOP_PCT) closeNow = true;
      else if (bestPct >= TRAIL_ARM_PCT && (bestPct - curPct) >= TRAIL_PP) closeNow = true;
      else if (!bullish && rsi[i] < 50) closeNow = true;
    }

    if (closeNow) {
      const entryPrice = c15[entryIdx].c;
      const pnlPct = (price - entryPrice) / entryPrice * 100;
      trades.push({
        entryTime: new Date(c15[entryIdx].t).toISOString().slice(0,10),
        exitTime:  new Date(t).toISOString().slice(0,10),
        pnlPct,
      });
      mode = "USDT";
    }
  }
  return trades;
}

function compound(trades: Trade[], excludeIdxs: number[]): number {
  let mult = 1;
  trades.forEach((t, i) => { if (!excludeIdxs.includes(i)) mult *= (1 + t.pnlPct / 100); });
  return (mult - 1) * 100;
}

(async () => {
  const now   = Date.now();
  const start = now - 5 * 365 * 24 * 60 * 60 * 1000;
  const dLabel = `${new Date(start).toISOString().slice(0,10)} – ${new Date(now).toISOString().slice(0,10)}`;

  process.stdout.write(`Fetching SOLUSDT 15m (${dLabel})... `);
  const c15 = await fetchKlines("SOLUSDT", "15m", start, now);
  console.log(`${c15.length} candles`);

  process.stdout.write(`Fetching SOLUSDT 12h (${dLabel})... `);
  const c12h = await fetchKlines("SOLUSDT", "12h", start, now);
  console.log(`${c12h.length} candles`);

  const trades = runSim(c15, c12h);
  const sorted = [...trades].map((t, i) => ({ ...t, idx: i })).sort((a,b) => b.pnlPct - a.pnlPct);
  const top1 = sorted[0], top2 = sorted[1], top3 = sorted[2];
  const fullTotal = compound(trades, []);
  const without1 = compound(trades, [top1.idx]);
  const without2 = compound(trades, [top1.idx, top2.idx]);
  const without3 = compound(trades, [top1.idx, top2.idx, top3.idx]);

  console.log(`\nSOLUSDT gold standard (-6% stop + trailing arm@8/trail@10)`);
  console.log(`Trades: ${trades.length}`);
  console.log(`#1: ${top1.entryTime} -> ${top1.exitTime}  pnl=${top1.pnlPct.toFixed(1)}%`);
  console.log(`#2: ${top2.entryTime} -> ${top2.exitTime}  pnl=${top2.pnlPct.toFixed(1)}%`);
  console.log(`#3: ${top3.entryTime} -> ${top3.exitTime}  pnl=${top3.pnlPct.toFixed(1)}%`);
  console.log(`Full compounded total: ${fullTotal.toFixed(1)}%`);
  console.log(`Without top 1: ${without1.toFixed(1)}%  (${(without1/fullTotal*100).toFixed(1)}% of full retained)`);
  console.log(`Without top 2: ${without2.toFixed(1)}%  (${(without2/fullTotal*100).toFixed(1)}% of full retained)`);
  console.log(`Without top 3: ${without3.toFixed(1)}%  (${(without3/fullTotal*100).toFixed(1)}% of full retained)`);
})();
