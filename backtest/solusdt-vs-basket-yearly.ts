// Year-by-year comparison: current SOLUSDT gold standard (-6% hard stop + stepped trail
// 10pp until +30%, then 6pp) vs the basket rotation (BTC/SOL/ETH, lookback=15d, rebalance=7d).
// Both expressed in USD terms (dollar growth from $50) for direct comparison, even though the
// basket's native unit is BTC. Read-only, does not touch live bots.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://api.binance.us/api/v3";
const ALLOCATION_USD = 50;

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
function priceAt(c: C[], t: number): number {
  let lo = 0, hi = c.length - 1, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (c[mid].t <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  return idx >= 0 ? c[idx].c : c[0].c;
}

function runSolUsdt(cN: C[], c12h: C[]) {
  const MA_FAST = 7, MA_SLOW = 25, RSI_LOW = 30;
  const HARD_STOP = -6, TRAIL_ARM = 8, TRAIL_PP = 10, STEP_THRESH = 30, STEP_PP = 6;
  const rsi = calcRSI(cN);
  const f12 = calcEMA(c12h, MA_FAST), s12 = calcEMA(c12h, MA_SLOW);
  const trend12h = c12h.map((c, i) => ({ t: c.t, fast: f12[i], prevFast: i > 0 ? f12[i-1] : NaN, slow: s12[i], close: c.c }));
  function getTrend(t: number, livePrice: number) {
    let idx = -1;
    for (let i = trend12h.length - 1; i >= 0; i--) { if (trend12h[i].t <= t) { idx = i; break; } }
    if (idx < 0) return { bullish: false, sloping: false };
    const { fast, prevFast, slow, close } = trend12h[idx];
    if (isNaN(fast) || isNaN(slow)) return { bullish: false, sloping: false };
    const delta = livePrice - close;
    const liveFast = fast + delta / MA_FAST, liveSlow = slow + delta / MA_SLOW;
    return { bullish: liveFast > liveSlow, sloping: !isNaN(prevFast) && liveFast > prevFast };
  }

  let usdt = ALLOCATION_USD, solQty = 0, mode: "USDT"|"SOL" = "USDT";
  let armedForSol = false, entryPrice = 0, bestPct = 0;
  const yearSnaps: { label: string; startEq: number; endEq: number }[] = [];
  let curYear = "", yearStartEq = ALLOCATION_USD;

  for (let i = 1; i < cN.length; i++) {
    if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
    const price = cN[i].c, t = cN[i].t;
    const eq = mode === "SOL" ? solQty * price : usdt;
    const yr = new Date(t).toISOString().slice(0, 4);
    if (yr !== curYear) { if (curYear !== "") yearSnaps.push({ label: curYear, startEq: yearStartEq, endEq: eq }); curYear = yr; yearStartEq = eq; }

    if (rsi[i-1] < RSI_LOW && rsi[i] >= RSI_LOW && mode === "USDT" && !armedForSol) armedForSol = true;
    const { bullish, sloping } = getTrend(t, price);
    if (mode === "USDT" && armedForSol && bullish && sloping) {
      entryPrice = price; bestPct = 0; solQty = usdt / price; usdt = 0; mode = "SOL"; armedForSol = false;
    }
    let closeNow = false;
    if (mode === "SOL") {
      const curPct = (price - entryPrice) / entryPrice * 100;
      if (curPct > bestPct) bestPct = curPct;
      if (curPct <= HARD_STOP) closeNow = true;
      else if (bestPct >= TRAIL_ARM) {
        const trail = bestPct >= STEP_THRESH ? STEP_PP : TRAIL_PP;
        if (bestPct - curPct >= trail) closeNow = true;
      }
      if (!closeNow && !bullish && rsi[i] < 50) closeNow = true;
    }
    if (closeNow) { usdt = solQty * price; solQty = 0; mode = "USDT"; }
  }
  if (curYear !== "") {
    const finalEq = mode === "SOL" ? solQty * cN[cN.length-1].c : usdt;
    yearSnaps.push({ label: curYear, startEq: yearStartEq, endEq: finalEq });
  }
  return yearSnaps;
}

function runBasket(btcUsd: C[], solUsd: C[], ethUsd: C[], lookbackDays: number, rebalanceDays: number) {
  const assets = [{ name: "BTC", series: btcUsd }, { name: "SOL", series: solUsd }, { name: "ETH", series: ethUsd }];
  const startT = btcUsd[0].t + lookbackDays * 86_400_000;
  const endT = btcUsd[btcUsd.length - 1].t;
  let holding = "BTC", holdingQty = ALLOCATION_USD / priceAt(btcUsd, startT), lastRebalance = startT;

  const yearSnaps: { label: string; startUsd: number; endUsd: number }[] = [];
  let curYear = "", yearStartUsd = ALLOCATION_USD;

  function valueUsd(t: number): number {
    const series = holding === "BTC" ? btcUsd : holding === "SOL" ? solUsd : ethUsd;
    return holdingQty * priceAt(series, t);
  }

  let t = startT;
  while (t <= endT) {
    if (t - lastRebalance >= rebalanceDays * 86_400_000 || t === startT) {
      const rets = assets.map(a => {
        const now_ = priceAt(a.series, t), then = priceAt(a.series, t - lookbackDays * 86_400_000);
        return { name: a.name, ret: (now_ - then) / then };
      });
      rets.sort((a, b) => b.ret - a.ret);
      const best = rets[0].name;
      if (best !== holding) {
        const usdVal = valueUsd(t);
        const newSeries = best === "BTC" ? btcUsd : best === "SOL" ? solUsd : ethUsd;
        holding = best; holdingQty = usdVal / priceAt(newSeries, t);
      }
      lastRebalance = t;
    }
    const eqUsd = valueUsd(t);
    const yr = new Date(t).toISOString().slice(0, 4);
    if (yr !== curYear) { if (curYear !== "") yearSnaps.push({ label: curYear, startUsd: yearStartUsd, endUsd: eqUsd }); curYear = yr; yearStartUsd = eqUsd; }
    t += 12 * 60 * 60 * 1000;
  }
  if (curYear !== "") yearSnaps.push({ label: curYear, startUsd: yearStartUsd, endUsd: valueUsd(endT) });
  return yearSnaps;
}

(async () => {
  const now = Date.now(), start = now - 5 * 365 * 24 * 60 * 60 * 1000 - 30 * 86_400_000;

  process.stdout.write(`Fetching SOLUSDT 15m... `); const u15 = await fetchKlines("SOLUSDT", "15m", start, now); console.log(`${u15.length}`);
  process.stdout.write(`Fetching SOLUSDT 12h... `); const u12h = await fetchKlines("SOLUSDT", "12h", start, now); console.log(`${u12h.length}`);
  process.stdout.write(`Fetching BTCUSDT 12h... `); const btcUsd = await fetchKlines("BTCUSDT", "12h", start, now); console.log(`${btcUsd.length}`);
  process.stdout.write(`Fetching SOLUSDT 12h (basket)... `); const solUsd = await fetchKlines("SOLUSDT", "12h", start, now); console.log(`${solUsd.length}`);
  process.stdout.write(`Fetching ETHUSDT 12h... `); const ethUsd = await fetchKlines("ETHUSDT", "12h", start, now); console.log(`${ethUsd.length}`);

  const usdtSnaps = runSolUsdt(u15, u12h);
  const basketSnaps = runBasket(btcUsd, solUsd, ethUsd, 15, 7);

  console.log(`\n${"year".padEnd(8)}${"SOLUSDT surfer (stop+trail)".padStart(30)}${"Basket BTC/SOL/ETH 15d/7d".padStart(28)}`);
  console.log("─".repeat(66));
  let sMult = 1, bMult = 1;
  const n = Math.max(usdtSnaps.length, basketSnaps.length);
  for (let i = 0; i < n; i++) {
    const s = usdtSnaps[i], b = basketSnaps[i];
    const sRet = s ? (s.endEq - s.startEq) / s.startEq * 100 : NaN;
    const bRet = b ? (b.endUsd - b.startUsd) / b.startUsd * 100 : NaN;
    if (!isNaN(sRet)) sMult *= (1 + sRet/100);
    if (!isNaN(bRet)) bMult *= (1 + bRet/100);
    const yl = s?.label ?? b?.label ?? "?";
    console.log(`${yl.padEnd(8)}${(isNaN(sRet)?"n/a":(sRet>=0?"+":"")+sRet.toFixed(1)+"%").padStart(28)}${(isNaN(bRet)?"n/a":(bRet>=0?"+":"")+bRet.toFixed(1)+"%").padStart(26)}`);
  }
  console.log("─".repeat(66));
  const sT = (sMult-1)*100, bT = (bMult-1)*100;
  console.log(`${"TOTAL".padEnd(8)}${((sT>=0?"+":"")+sT.toFixed(1)+"%").padStart(28)}${((bT>=0?"+":"")+bT.toFixed(1)+"%").padStart(26)}`);
  console.log(`\n$50 -> SOLUSDT surfer=$${(50*sMult).toFixed(2)}  Basket=$${(50*bMult).toFixed(2)}`);
})();
