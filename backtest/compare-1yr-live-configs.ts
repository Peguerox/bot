// Runs the CURRENT LIVE deployed configs for SOLBTC and SOLUSDT surfer bots, restricted to
// the last 1 year only, for direct comparison against the BCH z-score 1yr result.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://api.binance.us/api/v3";
const RSI_LOW = 30, RSI_HIGH = 70, MA_FAST = 7, MA_SLOW = 25, ALLOCATION_USD = 50;

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
function getTrend(trend12h: any[], t: number, livePrice: number) {
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
function btcUsdAt(btcUsd: C[], t: number): number {
  let lo = 0, hi = btcUsd.length - 1, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (btcUsd[mid].t <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  return idx >= 0 ? btcUsd[idx].c : btcUsd[0].c;
}

// ---- SOLBTC live config: arm@6%, trail 7.5pp (flat, no stepping) ----
function runSOLBTC(c15: C[], c12h: C[], btcUsd: C[]) {
  const TRAIL_ARM_PCT = 6, TRAIL_PP = 7.5;
  const rsi = calcRSI(c15);
  const f12 = calcEMA(c12h, MA_FAST), s12 = calcEMA(c12h, MA_SLOW);
  const trend12h = c12h.map((c, i) => ({ t: c.t, fast: f12[i], prevFast: i > 0 ? f12[i-1] : NaN, slow: s12[i], close: c.c }));

  const startBtc = ALLOCATION_USD / btcUsdAt(btcUsd, c15[0].t);
  let btc = startBtc, solQty = 0, mode: "BTC"|"SOL" = "BTC";
  let armedForSol = false, armedForBtc = false, entryPrice = 0, bestPct = 0, trades = 0;
  let peakUsd = ALLOCATION_USD, maxDD = 0;

  for (let i = 1; i < c15.length; i++) {
    if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
    const price = c15[i].c, t = c15[i].t, usdPx = btcUsdAt(btcUsd, t);
    if (rsi[i-1] < RSI_LOW && rsi[i] >= RSI_LOW && mode === "BTC" && !armedForSol) armedForSol = true;
    if (rsi[i-1] > RSI_HIGH && rsi[i] <= RSI_HIGH && mode === "SOL" && !armedForBtc) armedForBtc = true;
    const { bullish, sloping } = getTrend(trend12h, t, price);
    if (mode === "BTC" && armedForSol && bullish && sloping) {
      entryPrice = price; bestPct = 0; solQty = btc / price; btc = 0; mode = "SOL"; armedForSol = false;
    }
    let closeNow = false;
    if (mode === "SOL") {
      const curPct = (price - entryPrice) / entryPrice * 100;
      if (curPct > bestPct) bestPct = curPct;
      if (bestPct >= TRAIL_ARM_PCT && (bestPct - curPct) >= TRAIL_PP) closeNow = true;
      if (!closeNow && armedForBtc && !bullish) closeNow = true;
    }
    if (closeNow) { btc = solQty * price; trades++; solQty = 0; mode = "BTC"; armedForBtc = false; }
    const eq = (mode === "SOL" ? solQty * price : btc) * usdPx;
    if (eq > peakUsd) peakUsd = eq;
    const dd = (peakUsd - eq) / peakUsd * 100;
    if (dd > maxDD) maxDD = dd;
  }
  const lastUsdPx = btcUsdAt(btcUsd, c15[c15.length-1].t);
  const finalBtc = mode === "SOL" ? solQty * c15[c15.length-1].c : btc;
  const btcAccumRet = (finalBtc - startBtc) / startBtc * 100;
  return { ret: btcAccumRet, finalVal: finalBtc * lastUsdPx, trades, maxDD };
}

// ---- SOLUSDT live config: hardstop -6%, arm@8%, trail 10pp -> 6pp after 30% peak ----
function runSOLUSDT(c15: C[], c12h: C[]) {
  const HARD_STOP_PCT = -6, TRAIL_ARM_PCT = 8, TRAIL_PP = 10, STEP_THRESH = 30, STEP_TRAIL_PP = 6;
  const rsi = calcRSI(c15);
  const f12 = calcEMA(c12h, MA_FAST), s12 = calcEMA(c12h, MA_SLOW);
  const trend12h = c12h.map((c, i) => ({ t: c.t, fast: f12[i], prevFast: i > 0 ? f12[i-1] : NaN, slow: s12[i], close: c.c }));

  let usdt = ALLOCATION_USD, solQty = 0, mode: "USDT"|"SOL" = "USDT";
  let armedForSol = false, entryPrice = 0, bestPct = 0, trades = 0;
  let peak = ALLOCATION_USD, maxDD = 0;

  for (let i = 1; i < c15.length; i++) {
    if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
    const price = c15[i].c, t = c15[i].t;
    if (rsi[i-1] < RSI_LOW && rsi[i] >= RSI_LOW && mode === "USDT" && !armedForSol) armedForSol = true;
    const { bullish, sloping } = getTrend(trend12h, t, price);
    if (mode === "USDT" && armedForSol && bullish && sloping) {
      entryPrice = price; bestPct = 0; solQty = usdt / price; usdt = 0; mode = "SOL"; armedForSol = false;
    }
    let closeNow = false;
    if (mode === "SOL") {
      const curPct = (price - entryPrice) / entryPrice * 100;
      if (curPct > bestPct) bestPct = curPct;
      if (curPct <= HARD_STOP_PCT) closeNow = true;
      else if (bestPct >= TRAIL_ARM_PCT) {
        const trail = bestPct >= STEP_THRESH ? STEP_TRAIL_PP : TRAIL_PP;
        if ((bestPct - curPct) >= trail) closeNow = true;
      }
      if (!closeNow && !bullish && rsi[i] < 50) closeNow = true;
    }
    if (closeNow) { usdt = solQty * price; trades++; solQty = 0; mode = "USDT"; }
    const eq = mode === "SOL" ? solQty * price : usdt;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  const finalVal = mode === "SOL" ? solQty * c15[c15.length-1].c : usdt;
  const ret = (finalVal - ALLOCATION_USD) / ALLOCATION_USD * 100;
  return { ret, finalVal, trades, maxDD };
}

(async () => {
  const now = Date.now();
  const start = now - 365 * 24 * 60 * 60 * 1000; // 1yr, matches BCH test window

  process.stdout.write(`Fetching SOLBTC 15m/12h + BTCUSDT 1h... `);
  const solbtc15 = await fetchKlines("SOLBTC", "15m", start, now);
  const solbtc12h = await fetchKlines("SOLBTC", "12h", start, now);
  const btcUsd = await fetchKlines("BTCUSDT", "1h", start, now);
  console.log(`done`);

  process.stdout.write(`Fetching SOLUSDT 15m/12h... `);
  const solusdt15 = await fetchKlines("SOLUSDT", "15m", start, now);
  const solusdt12h = await fetchKlines("SOLUSDT", "12h", start, now);
  console.log(`done`);

  const rBtc = runSOLBTC(solbtc15, solbtc12h, btcUsd);
  const rUsdt = runSOLUSDT(solusdt15, solusdt12h);

  console.log(`\n1-year comparison · live deployed configs vs BCH z-score\n`);
  console.log(`SOLBTC (live, BTC-accum)  ${(rBtc.ret>=0?"+":"")+rBtc.ret.toFixed(1)}%   $${rBtc.finalVal.toFixed(2)}   trades=${rBtc.trades}   maxDD=${rBtc.maxDD.toFixed(1)}%`);
  console.log(`SOLUSDT (live, USD)       ${(rUsdt.ret>=0?"+":"")+rUsdt.ret.toFixed(1)}%   $${rUsdt.finalVal.toFixed(2)}   trades=${rUsdt.trades}   maxDD=${rUsdt.maxDD.toFixed(1)}%`);
  console.log(`BCH z-score (from earlier)   +83.8%   $91.90   trades=3066   maxDD=22.6%`);
})();
