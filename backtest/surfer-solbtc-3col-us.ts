// 3-column comparison for SOLBTC: Hold SOL (BTC-denominated) vs Current (slope filter, live
// logic) vs + Trailing (arm@6%, trail@10pp — the conservative pick from the cliff-avoidance
// check). Same continuous ~5yr methodology as the rest of this investigation.
// Read-only, does not touch live bots.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE       = "https://api.binance.us/api/v3";
const LOOKBACK   = 365 * 24 * 60 * 60 * 1000;
const RSI_LOW    = 30;
const RSI_HIGH   = 70;
const MA_FAST    = 7;
const MA_SLOW    = 25;
const ALLOCATION_USD = 50;
const TRAIL_ARM_PCT  = 6;
const TRAIL_PP       = 10;

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

function btcUsdAt(btcUsd: C[], t: number): number {
  let lo = 0, hi = btcUsd.length - 1, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (btcUsd[mid].t <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  return idx >= 0 ? btcUsd[idx].c : btcUsd[0].c;
}

function runSim(c15: C[], c12h: C[], btcUsd: C[], useTrailing: boolean) {
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

  const startBtc = ALLOCATION_USD / btcUsdAt(btcUsd, c15[0].t);
  let btc = startBtc;
  let solQty = 0;
  let mode: "BTC" | "SOL" = "BTC";
  let armedForSol = false, armedForBtc = false;
  let entryPrice = 0, bestPct = 0;

  const yearSnaps: { label: string; startUsd: number; endUsd: number }[] = [];
  let curYear = "", yearStartUsd = ALLOCATION_USD;

  for (let i = 1; i < c15.length; i++) {
    if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
    const price = c15[i].c;
    const t     = c15[i].t;
    const usdPx = btcUsdAt(btcUsd, t);
    const eqUsd = mode === "SOL" ? solQty * price * usdPx : btc * usdPx;

    const yr = new Date(t).toISOString().slice(0, 4);
    if (yr !== curYear) {
      if (curYear !== "") yearSnaps.push({ label: curYear, startUsd: yearStartUsd, endUsd: eqUsd });
      curYear = yr; yearStartUsd = eqUsd;
    }

    if (rsi[i-1] < RSI_LOW && rsi[i] >= RSI_LOW && mode === "BTC" && !armedForSol) armedForSol = true;
    if (rsi[i-1] > RSI_HIGH && rsi[i] <= RSI_HIGH && mode === "SOL" && !armedForBtc) armedForBtc = true;

    const { bullish, sloping } = getTrend(t, price);

    if (mode === "BTC" && armedForSol && bullish && sloping) {
      entryPrice = price; bestPct = 0;
      solQty   = btc / price;
      btc      = 0;
      mode     = "SOL";
      armedForSol = false;
    }

    let closeNow = false;
    if (mode === "SOL") {
      const curPct = (price - entryPrice) / entryPrice * 100;
      if (curPct > bestPct) bestPct = curPct;
      if (useTrailing && bestPct >= TRAIL_ARM_PCT && (bestPct - curPct) >= TRAIL_PP) closeNow = true;
      else if (armedForBtc && !bullish) closeNow = true;
    }

    if (closeNow) {
      btc = solQty * price;
      solQty = 0;
      mode   = "BTC";
      armedForBtc = false;
    }
  }
  if (curYear !== "") {
    const lastPx = btcUsdAt(btcUsd, c15[c15.length-1].t);
    const finalEq = mode === "SOL" ? solQty * c15[c15.length-1].c * lastPx : btc * lastPx;
    yearSnaps.push({ label: curYear, startUsd: yearStartUsd, endUsd: finalEq });
  }
  return yearSnaps;
}

function holdSnapsFn(c15: C[], btcUsd: C[]) {
  const startBtc = ALLOCATION_USD / btcUsdAt(btcUsd, c15[0].t);
  const solQtyHold = startBtc / c15[0].c;
  const yearSnaps: { label: string; startUsd: number; endUsd: number }[] = [];
  let curYear = "", yearStartUsd = ALLOCATION_USD;
  for (const c of c15) {
    const usdPx = btcUsdAt(btcUsd, c.t);
    const eqUsd = solQtyHold * c.c * usdPx;
    const yr = new Date(c.t).toISOString().slice(0, 4);
    if (yr !== curYear) {
      if (curYear !== "") yearSnaps.push({ label: curYear, startUsd: yearStartUsd, endUsd: eqUsd });
      curYear = yr; yearStartUsd = eqUsd;
    }
  }
  const lastPx = btcUsdAt(btcUsd, c15[c15.length-1].t);
  yearSnaps.push({ label: curYear, startUsd: yearStartUsd, endUsd: solQtyHold * c15[c15.length-1].c * lastPx });
  return yearSnaps;
}

(async () => {
  const now   = Date.now();
  const start = now - 5 * LOOKBACK;
  const dLabel = `${new Date(start).toISOString().slice(0,10)} – ${new Date(now).toISOString().slice(0,10)}`;

  process.stdout.write(`Fetching SOLBTC 15m (${dLabel})... `);
  const c15 = await fetchKlines("SOLBTC", "15m", start, now);
  console.log(`${c15.length} candles`);

  process.stdout.write(`Fetching SOLBTC 12h (${dLabel})... `);
  const c12h = await fetchKlines("SOLBTC", "12h", start, now);
  console.log(`${c12h.length} candles`);

  process.stdout.write(`Fetching BTCUSDT 1h (${dLabel})... `);
  const btcUsd = await fetchKlines("BTCUSDT", "1h", start, now);
  console.log(`${btcUsd.length} candles`);

  const holdSnaps = holdSnapsFn(c15, btcUsd);
  const currentSnaps = runSim(c15, c12h, btcUsd, false);
  const trailSnaps = runSim(c15, c12h, btcUsd, true);

  console.log(`\n${"year".padEnd(8)}${"Hold SOL".padStart(12)}${"Current (slope filter)".padStart(26)}${`+ Trailing (arm6/trail10)`.padStart(28)}`);
  console.log("─".repeat(74));
  let holdMult = 1, curMult = 1, trailMult = 1;
  for (let i = 0; i < currentSnaps.length; i++) {
    const h = holdSnaps[i], c = currentSnaps[i], tr = trailSnaps[i];
    const hRet = (h.endUsd - h.startUsd) / h.startUsd * 100;
    const cRet = (c.endUsd - c.startUsd) / c.startUsd * 100;
    const trRet = (tr.endUsd - tr.startUsd) / tr.startUsd * 100;
    holdMult *= (1 + hRet/100); curMult *= (1 + cRet/100); trailMult *= (1 + trRet/100);
    console.log(`${c.label.padEnd(8)}${(hRet>=0?"+":"")+hRet.toFixed(1).padStart(10)}%${(cRet>=0?"+":"")+cRet.toFixed(1).padStart(24)}%${(trRet>=0?"+":"")+trRet.toFixed(1).padStart(26)}%`);
  }
  console.log("─".repeat(74));
  const hTot = (holdMult-1)*100, cTot = (curMult-1)*100, trTot = (trailMult-1)*100;
  console.log(`${"TOTAL".padEnd(8)}${(hTot>=0?"+":"")+hTot.toFixed(1).padStart(10)}%${(cTot>=0?"+":"")+cTot.toFixed(1).padStart(24)}%${(trTot>=0?"+":"")+trTot.toFixed(1).padStart(26)}%`);
  console.log(`\n(dollar terms on $50: Hold=$${(50*holdMult).toFixed(2)}  Current=$${(50*curMult).toFixed(2)}  +Trailing=$${(50*trailMult).toFixed(2)})`);
})();
