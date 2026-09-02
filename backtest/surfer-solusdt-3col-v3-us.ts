// 3-column comparison v3: Hold SOL vs Gold standard (-6% stop, flat trail 10pp) vs
// + Stepped trail (10pp until +30% gain, then tighten to 6pp beyond). Same continuous
// ~5yr methodology. Read-only, does not touch live bots.
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
const STEP_THRESH     = 30;
const STEP_TRAIL_PP   = 6;

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

function runSim(c15: C[], c12h: C[], useStep: boolean) {
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

  const yearSnaps: { label: string; startEq: number; endEq: number }[] = [];
  let curYear = "", yearStartEq = ALLOCATION_USD;

  for (let i = 1; i < c15.length; i++) {
    if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
    const price = c15[i].c;
    const t     = c15[i].t;
    const eq    = mode === "SOL" ? solQty * price : usdt;

    const yr = new Date(t).toISOString().slice(0, 4);
    if (yr !== curYear) {
      if (curYear !== "") yearSnaps.push({ label: curYear, startEq: yearStartEq, endEq: eq });
      curYear = yr; yearStartEq = eq;
    }

    if (rsi[i-1] < RSI_LOW && rsi[i] >= RSI_LOW && mode === "USDT" && !armedForSol) armedForSol = true;

    const { bullish, sloping } = getTrend(t, price);

    if (mode === "USDT" && armedForSol && bullish && sloping) {
      entryUsdt = usdt; entryPrice = price; bestPct = 0;
      solQty    = usdt / price;
      usdt      = 0;
      mode      = "SOL";
      armedForSol = false;
    }

    let closeNow = false;
    if (mode === "SOL") {
      const curPct = (price - entryPrice) / entryPrice * 100;
      if (curPct > bestPct) bestPct = curPct;

      if (curPct <= HARD_STOP_PCT) closeNow = true;
      else if (bestPct >= TRAIL_ARM_PCT) {
        const trail = (useStep && bestPct >= STEP_THRESH) ? STEP_TRAIL_PP : TRAIL_PP;
        if ((bestPct - curPct) >= trail) closeNow = true;
      }
      if (!closeNow && !bullish && rsi[i] < 50) closeNow = true;
    }

    if (closeNow) {
      usdt = solQty * price;
      solQty = 0;
      mode   = "USDT";
    }
  }
  if (curYear !== "") {
    const finalEq = mode === "SOL" ? solQty * c15[c15.length-1].c : usdt;
    yearSnaps.push({ label: curYear, startEq: yearStartEq, endEq: finalEq });
  }
  return yearSnaps;
}

function holdSnapsFn(c15: C[]) {
  const yearSnaps: { label: string; startPx: number; endPx: number }[] = [];
  let curYear = "", yearStartPx = c15[0].c;
  for (const c of c15) {
    const yr = new Date(c.t).toISOString().slice(0, 4);
    if (yr !== curYear) {
      if (curYear !== "") yearSnaps.push({ label: curYear, startPx: yearStartPx, endPx: c.c });
      curYear = yr; yearStartPx = c.c;
    }
  }
  yearSnaps.push({ label: curYear, startPx: yearStartPx, endPx: c15[c15.length-1].c });
  return yearSnaps;
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

  const holdSnaps = holdSnapsFn(c15);
  const goldSnaps = runSim(c15, c12h, false);
  const stepSnaps = runSim(c15, c12h, true);

  console.log(`\n${"year".padEnd(8)}${"Hold SOL".padStart(12)}${"Gold std (flat 10pp)".padStart(24)}${"+ Stepped (30%->6pp)".padStart(24)}`);
  console.log("─".repeat(68));
  let holdMult = 1, goldMult = 1, stepMult = 1;
  for (let i = 0; i < goldSnaps.length; i++) {
    const h = holdSnaps[i], g = goldSnaps[i], s = stepSnaps[i];
    const hRet = (h.endPx - h.startPx) / h.startPx * 100;
    const gRet = (g.endEq - g.startEq) / g.startEq * 100;
    const sRet = (s.endEq - s.startEq) / s.startEq * 100;
    holdMult *= (1 + hRet/100); goldMult *= (1 + gRet/100); stepMult *= (1 + sRet/100);
    console.log(`${g.label.padEnd(8)}${(hRet>=0?"+":"")+hRet.toFixed(1).padStart(10)}%${(gRet>=0?"+":"")+gRet.toFixed(1).padStart(22)}%${(sRet>=0?"+":"")+sRet.toFixed(1).padStart(22)}%`);
  }
  console.log("─".repeat(68));
  const hTot = (holdMult-1)*100, gTot = (goldMult-1)*100, sTot = (stepMult-1)*100;
  console.log(`${"TOTAL".padEnd(8)}${(hTot>=0?"+":"")+hTot.toFixed(1).padStart(10)}%${(gTot>=0?"+":"")+gTot.toFixed(1).padStart(22)}%${(sTot>=0?"+":"")+sTot.toFixed(1).padStart(22)}%`);
  console.log(`\n(dollar terms on $50: Hold=$${(50*holdMult).toFixed(2)}  Gold std=$${(50*goldMult).toFixed(2)}  +Stepped=$${(50*stepMult).toFixed(2)})`);
})();
