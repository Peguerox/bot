// Tests a STEPPED trailing stop on SOLUSDT: instead of one fixed trail distance the whole
// time, tighten it once a trade is up a lot, to lock in more of a big trend trade instead of
// giving back a fixed percentage of an ever-growing peak. Built on top of the current gold
// standard (-6% hard stop, arm@8%, trail@10pp) as the baseline for this test.
// Read-only, does not touch live bots.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE       = "https://api.binance.us/api/v3";
const RSI_LOW    = 30;
const MA_FAST    = 7;
const MA_SLOW    = 25;
const ALLOCATION_USD = 50;
const HARD_STOP_PCT  = -6;
const TRAIL_ARM_PCT  = 8;
const TRAIL_PP        = 10;

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

// stages: sorted list of [peakThreshold, trailPP] — once bestPct crosses a threshold, use that trail
type Stage = { threshold: number; trailPp: number };

function trailForPeak(bestPct: number, stages: Stage[]): number {
  let trail = TRAIL_PP;
  for (const s of stages) if (bestPct >= s.threshold) trail = s.trailPp;
  return trail;
}

function runSim(c15: C[], c12h: C[], stages: Stage[], label: string) {
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

  let usdt = ALLOCATION_USD, solQty = 0;
  let mode: "USDT" | "SOL" = "USDT";
  let armedForSol = false;
  let entryUsdt = 0, entryPrice = 0, bestPct = 0;
  let trades = 0, wins = 0;
  let peak = ALLOCATION_USD, maxDD = 0;

  for (let i = 1; i < c15.length; i++) {
    if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
    const price = c15[i].c;
    const t     = c15[i].t;

    if (rsi[i-1] < RSI_LOW && rsi[i] >= RSI_LOW && mode === "USDT" && !armedForSol) armedForSol = true;

    const { bullish, sloping } = getTrend(t, price);

    if (mode === "USDT" && armedForSol && bullish && sloping) {
      entryUsdt = usdt; entryPrice = price; bestPct = 0;
      solQty    = usdt / price;
      usdt      = 0;
      mode      = "SOL";
      armedForSol = false;
      const eq = solQty * price;
      if (eq > peak) peak = eq;
    }

    let closeNow = false;
    if (mode === "SOL") {
      const curPct = (price - entryPrice) / entryPrice * 100;
      if (curPct > bestPct) bestPct = curPct;

      if (curPct <= HARD_STOP_PCT) closeNow = true;
      else if (bestPct >= TRAIL_ARM_PCT) {
        const trail = trailForPeak(bestPct, stages);
        if ((bestPct - curPct) >= trail) closeNow = true;
      }
      if (!closeNow && !bullish && rsi[i] < 50) closeNow = true;
    }

    if (closeNow) {
      usdt = solQty * price;
      const pnl = usdt - entryUsdt;
      trades++;
      if (pnl > 0) wins++;
      if (usdt > peak) peak = usdt;
      const dd = (peak - usdt) / peak * 100;
      if (dd > maxDD) maxDD = dd;
      solQty = 0;
      mode   = "USDT";
    }

    if (mode === "SOL") {
      const eq = solQty * price;
      if (eq > peak) peak = eq;
      const dd = (peak - eq) / peak * 100;
      if (dd > maxDD) maxDD = dd;
    }
  }

  const finalVal = mode === "SOL" ? solQty * c15[c15.length-1].c : usdt;
  const totalRet = (finalVal - ALLOCATION_USD) / ALLOCATION_USD * 100;
  const wr = trades > 0 ? (wins / trades * 100).toFixed(1) : "—";

  console.log(`${label.padEnd(48)}${(totalRet>=0?"+":"")+totalRet.toFixed(1).padStart(9)}%   $${finalVal.toFixed(2).padStart(9)}   trades=${String(trades).padStart(3)}   WR=${wr.padStart(5)}%   maxDD=${maxDD.toFixed(1)}%`);
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

  console.log(`\nSOLUSDT · continuous ~5yr · stepped trailing stop test · Binance.US\n`);

  runSim(c15, c12h, [{ threshold: 30, trailPp: 6 }], `[CURRENT BEST] 10pp until 30%, then 6pp`);
  runSim(c15, c12h, [{ threshold: 15, trailPp: 8 }, { threshold: 30, trailPp: 6 }], `10pp until 15%, 8pp until 30%, then 6pp`);
  runSim(c15, c12h, [{ threshold: 15, trailPp: 7 }, { threshold: 30, trailPp: 6 }], `10pp until 15%, 7pp until 30%, then 6pp`);
  runSim(c15, c12h, [{ threshold: 12, trailPp: 8 }, { threshold: 30, trailPp: 6 }], `10pp until 12%, 8pp until 30%, then 6pp`);
  runSim(c15, c12h, [{ threshold: 10, trailPp: 8 }, { threshold: 30, trailPp: 6 }], `10pp until 10%, 8pp until 30%, then 6pp`);
  runSim(c15, c12h, [{ threshold: 20, trailPp: 8 }, { threshold: 30, trailPp: 6 }], `10pp until 20%, 8pp until 30%, then 6pp`);
})();
