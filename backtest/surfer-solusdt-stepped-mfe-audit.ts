// MFE audit on the NEW stepped-trail gold standard's own trades (-6% stop, trail 10pp until
// +30% gain then tighten to 6pp). Checks whether there's still meaningful giveback left to
// capture with a further refinement (e.g. a third, even-tighter step at higher gains).
// Read-only, does not touch live bots.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE       = "https://api.binance.us/api/v3";
const RSI_LOW    = 30;
const MA_FAST    = 7;
const MA_SLOW    = 25;
const HARD_STOP_PCT = -6;
const TRAIL_ARM_PCT = 8;
const TRAIL_PP       = 10;
const STEP_THRESH    = 30;
const STEP_TRAIL_PP  = 6;

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

type Trade = { entryTime: string; exitTime: string; pnlPct: number; mfePct: number; giveback: number; exitReason: string };

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

    let closeNow = false, reason = "";
    if (mode === "SOL") {
      const entryPrice = c15[entryIdx].c;
      const curPct = (price - entryPrice) / entryPrice * 100;
      if (curPct > bestPct) bestPct = curPct;

      if (curPct <= HARD_STOP_PCT) { closeNow = true; reason = "hardstop"; }
      else if (bestPct >= TRAIL_ARM_PCT) {
        const trail = bestPct >= STEP_THRESH ? STEP_TRAIL_PP : TRAIL_PP;
        if ((bestPct - curPct) >= trail) { closeNow = true; reason = "trail"; }
      }
      if (!closeNow && !bullish && rsi[i] < 50) { closeNow = true; reason = "trend"; }
    }

    if (closeNow) {
      const entryPrice = c15[entryIdx].c;
      const pnlPct = (price - entryPrice) / entryPrice * 100;
      trades.push({
        entryTime: new Date(c15[entryIdx].t).toISOString().slice(0,10),
        exitTime:  new Date(t).toISOString().slice(0,10),
        pnlPct, mfePct: bestPct, giveback: bestPct - pnlPct, exitReason: reason,
      });
      mode = "USDT";
    }
  }
  return trades;
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
  const sorted = [...trades].sort((a,b) => b.mfePct - a.mfePct);

  console.log(`\nTop 15 trades by peak — giveback after the stepped trail:`);
  console.log(`${"entry".padEnd(12)}${"exit".padEnd(12)}${"peak%".padStart(8)}${"final%".padStart(8)}${"giveback".padStart(10)}${"exitReason".padStart(12)}`);
  for (const t of sorted.slice(0, 15)) {
    console.log(`${t.entryTime.padEnd(12)}${t.exitTime.padEnd(12)}${(t.mfePct>=0?"+":"")+t.mfePct.toFixed(1).padStart(6)}%${(t.pnlPct>=0?"+":"")+t.pnlPct.toFixed(1).padStart(6)}%${t.giveback.toFixed(1).padStart(9)}pp${t.exitReason.padStart(12)}`);
  }

  const exitCounts: Record<string, number> = {};
  for (const t of trades) exitCounts[t.exitReason] = (exitCounts[t.exitReason] || 0) + 1;
  console.log(`\nExit reason breakdown: ${JSON.stringify(exitCounts)}`);

  const withGain = trades.filter(t => t.mfePct > 30); // trades that reached the stepped zone
  const avgGiveback = withGain.length ? withGain.reduce((a,t)=>a+t.giveback,0) / withGain.length : NaN;
  console.log(`\nTrades that reached the stepped zone (peak > 30%): ${withGain.length}`);
  console.log(`Average giveback among those: ${avgGiveback.toFixed(2)}pp`);

  const middleZone = trades.filter(t => t.mfePct >= 8 && t.mfePct <= 30);
  const avgGivebackMid = middleZone.length ? middleZone.reduce((a,t)=>a+t.giveback,0) / middleZone.length : NaN;
  const medianGivebackMidPct = (() => {
    const ratios = middleZone.map(t => t.mfePct > 0 ? t.giveback / t.mfePct * 100 : 0).sort((a,b)=>a-b);
    return ratios.length ? ratios[Math.floor(ratios.length/2)] : NaN;
  })();
  console.log(`\nMiddle-zone trades (peak 8-30%, only ever get the 10pp trail): ${middleZone.length}`);
  console.log(`Average giveback: ${avgGivebackMid.toFixed(2)}pp  |  Median giveback as % of peak: ${medianGivebackMidPct.toFixed(1)}%`);

  const noTrailZone = trades.filter(t => t.mfePct < 8);
  console.log(`\nTrades that never armed the trail at all (peak < 8%): ${noTrailZone.length}`);
})();
