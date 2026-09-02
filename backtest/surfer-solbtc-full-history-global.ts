// Full-history version — SOLBTC only exists on Binance.US from ~Nov 2021, but Binance's
// global exchange (data-api.binance.vision) listed it in April 2020, right after SOL's
// mainnet launch — that's the earliest this pair can exist anywhere. Runs baseline, slope
// filter, and hold-SOL (all BTC-denominated) from the earliest available candle to now, in
// one pass. Caveat: uses global data for the whole window (not Binance.US) for full coverage;
// earlier in this conversation, global vs Binance.US gave near-identical backtest results for
// this strategy family, so this is treated as a reasonable proxy, not the live execution venue.
// Read-only, does not touch live bots.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE     = "https://data-api.binance.vision/api/v3";
const RSI_LOW  = 30;
const RSI_HIGH = 70;
const MA_FAST  = 7;
const MA_SLOW  = 25;
const ALLOCATION_USD = 50;

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

function runSim(c15: C[], c12h: C[], useSlope: boolean) {
  const rsi = calcRSI(c15);
  const f12 = calcEMA(c12h, MA_FAST);
  const s12 = calcEMA(c12h, MA_SLOW);

  const trend12h: { t: number; fast: number; prevFast: number; slow: number; close: number }[] = c12h.map((c, i) => ({
    t: c.t, fast: f12[i], prevFast: i > 0 ? f12[i-1] : NaN, slow: s12[i], close: c.c,
  }));

  function getTrend(t: number, livePrice: number): { bullish: boolean; sloping: boolean } {
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

  let btc = 1; // track in units of "starting BTC" (1.0 = 100%)
  let solQty = 0;
  let mode: "BTC" | "SOL" = "BTC";
  let armedForSol = false, armedForBtc = false;
  let entryBtc = 0;
  let trades = 0, wins = 0;

  const yearSnaps: { label: string; startEq: number; endEq: number }[] = [];
  let curYear = "", yearStartEq = 1;

  for (let i = 1; i < c15.length; i++) {
    if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
    const price = c15[i].c;
    const t     = c15[i].t;
    const eq    = mode === "SOL" ? solQty * price : btc;

    const yr = new Date(t).toISOString().slice(0, 4);
    if (yr !== curYear) {
      if (curYear !== "") yearSnaps.push({ label: curYear, startEq: yearStartEq, endEq: eq });
      curYear = yr; yearStartEq = eq;
    }

    if (rsi[i-1] < RSI_LOW && rsi[i] >= RSI_LOW && mode === "BTC" && !armedForSol) armedForSol = true;
    if (rsi[i-1] > RSI_HIGH && rsi[i] <= RSI_HIGH && mode === "SOL" && !armedForBtc) armedForBtc = true;

    const { bullish, sloping } = getTrend(t, price);
    const entryOk = useSlope ? (bullish && sloping) : bullish;

    if (mode === "BTC" && armedForSol && entryOk) {
      entryBtc = btc;
      solQty   = btc / price;
      btc      = 0;
      mode     = "SOL";
      armedForSol = false;
    }

    if (mode === "SOL" && armedForBtc && !bullish) {
      btc = solQty * price;
      trades++;
      if (btc > entryBtc) wins++;
      solQty = 0;
      mode   = "BTC";
      armedForBtc = false;
    }
  }
  if (curYear !== "") {
    const finalEq = mode === "SOL" ? solQty * c15[c15.length-1].c : btc;
    yearSnaps.push({ label: curYear, startEq: yearStartEq, endEq: finalEq });
  }

  const finalBtc = mode === "SOL" ? solQty * c15[c15.length-1].c : btc;
  return { finalBtc, trades, wins, yearSnaps };
}

(async () => {
  const now = Date.now();
  const start = new Date("2020-01-01T00:00:00Z").getTime();
  const dLabel = `${new Date(start).toISOString().slice(0,10)} – ${new Date(now).toISOString().slice(0,10)}`;

  process.stdout.write(`Fetching SOLBTC 15m (${dLabel}) [global]... `);
  const c15 = await fetchKlines("SOLBTC", "15m", start, now);
  console.log(`${c15.length} candles`);

  process.stdout.write(`Fetching SOLBTC 12h (${dLabel}) [global]... `);
  const c12h = await fetchKlines("SOLBTC", "12h", start, now);
  console.log(`${c12h.length} candles`);

  console.log(`\nActual coverage: ${new Date(c15[0].t).toISOString().slice(0,10)} – ${new Date(c15[c15.length-1].t).toISOString().slice(0,10)}`);

  const baseline = runSim(c15, c12h, false);
  const slope    = runSim(c15, c12h, true);

  // hold-SOL year snapshots (BTC-denominated, no trading)
  const holdSnaps: { label: string; startPx: number; endPx: number }[] = [];
  let curYear = "", yearStartPx = c15[0].c;
  for (const c of c15) {
    const yr = new Date(c.t).toISOString().slice(0, 4);
    if (yr !== curYear) {
      if (curYear !== "") holdSnaps.push({ label: curYear, startPx: yearStartPx, endPx: c.c });
      curYear = yr; yearStartPx = c.c;
    }
  }
  holdSnaps.push({ label: curYear, startPx: yearStartPx, endPx: c15[c15.length-1].c });

  console.log(`\n${"year".padEnd(8)}${"baseline".padStart(12)}${"slope filter".padStart(16)}${"hold SOL".padStart(12)}`);
  console.log("─".repeat(48));
  for (let i = 0; i < baseline.yearSnaps.length; i++) {
    const b = baseline.yearSnaps[i], s = slope.yearSnaps[i], h = holdSnaps[i];
    const bRet = (b.endEq - b.startEq) / b.startEq * 100;
    const sRet = (s.endEq - s.startEq) / s.startEq * 100;
    const hRet = (h.endPx - h.startPx) / h.startPx * 100;
    console.log(`${b.label.padEnd(8)}${(bRet>=0?"+":"")+bRet.toFixed(1).padStart(10)}%${(sRet>=0?"+":"")+sRet.toFixed(1).padStart(14)}%${(hRet>=0?"+":"")+hRet.toFixed(1).padStart(10)}%`);
  }

  const baseTotal = (baseline.finalBtc - 1) * 100;
  const slopeTotal = (slope.finalBtc - 1) * 100;
  const holdTotal = (c15[c15.length-1].c - c15[0].c) / c15[0].c * 100;
  console.log("─".repeat(48));
  console.log(`${"TOTAL".padEnd(8)}${(baseTotal>=0?"+":"")+baseTotal.toFixed(1).padStart(10)}%${(slopeTotal>=0?"+":"")+slopeTotal.toFixed(1).padStart(14)}%${(holdTotal>=0?"+":"")+holdTotal.toFixed(1).padStart(10)}%`);
  console.log(`\nTrades: baseline=${baseline.trades} (WR ${(baseline.wins/baseline.trades*100).toFixed(1)}%)  |  slope=${slope.trades} (WR ${(slope.wins/slope.trades*100).toFixed(1)}%)`);
})();
