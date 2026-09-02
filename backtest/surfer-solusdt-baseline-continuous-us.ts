// SOLUSDT baseline (exact live bot logic), run as ONE continuous simulation over the full
// available history — same rigor applied to SOLBTC. Live logic (trigger/live-bot-surfer-solusdt.ts):
//   Entry: RSI(14) 15m crosses up through 30 -> arm; EMA7>EMA25 (12h, liveMode) AND EMA7 sloping up -> buy
//   Exit:  EMA7<EMA25 (12h, liveMode) AND RSI(14) 15m < 50 -> sell (no arming required)
// Read-only, does not touch live bots.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE       = "https://api.binance.us/api/v3";
const RSI_LOW    = 30;
const MA_FAST    = 7;
const MA_SLOW    = 25;
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

function runSim(c15: C[], c12h: C[], label: string) {
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
  let entryUsdt = 0;
  let trades = 0, wins = 0;
  let peak = ALLOCATION_USD, maxDD = 0;

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
      entryUsdt = usdt;
      solQty    = usdt / price;
      usdt      = 0;
      mode      = "SOL";
      armedForSol = false;
      const eq2 = solQty * price;
      if (eq2 > peak) peak = eq2;
    }

    if (mode === "SOL" && !bullish && rsi[i] < 50) {
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
      const eq2 = solQty * price;
      if (eq2 > peak) peak = eq2;
      const dd = (peak - eq2) / peak * 100;
      if (dd > maxDD) maxDD = dd;
    }
  }
  if (curYear !== "") {
    const finalEq = mode === "SOL" ? solQty * c15[c15.length-1].c : usdt;
    yearSnaps.push({ label: curYear, startEq: yearStartEq, endEq: finalEq });
  }

  const finalVal = mode === "SOL" ? solQty * c15[c15.length-1].c : usdt;
  const totalRet = (finalVal - ALLOCATION_USD) / ALLOCATION_USD * 100;
  const wr = trades > 0 ? (wins / trades * 100).toFixed(1) : "—";

  console.log(`\n${"═".repeat(60)}`);
  console.log(` ${label}`);
  console.log(`${"═".repeat(60)}`);
  console.log(` Start: $${ALLOCATION_USD}`);
  console.log(` Final: $${finalVal.toFixed(2)}  (${totalRet >= 0 ? "+" : ""}${totalRet.toFixed(1)}%)`);
  console.log(` Trades: ${trades}  |  Win rate: ${wr}%  |  Max DD: ${maxDD.toFixed(2)}%`);
  console.log(` Calendar-year breakdown (informational, no state reset at boundaries):`);
  for (const { label: yl, startEq, endEq } of yearSnaps) {
    const ret = (endEq - startEq) / startEq * 100;
    console.log(`  ${yl}  ${ret >= 0 ? "+" : ""}${ret.toFixed(1)}%   $${startEq.toFixed(2)} → $${endEq.toFixed(2)}`);
  }
}

(async () => {
  const now   = Date.now();
  const start = new Date("2020-01-01T00:00:00Z").getTime();
  const dLabel = `${new Date(start).toISOString().slice(0,10)} – ${new Date(now).toISOString().slice(0,10)}`;

  process.stdout.write(`Fetching SOLUSDT 15m (${dLabel})... `);
  const c15 = await fetchKlines("SOLUSDT", "15m", start, now);
  console.log(`${c15.length} candles`);

  process.stdout.write(`Fetching SOLUSDT 12h (${dLabel})... `);
  const c12h = await fetchKlines("SOLUSDT", "12h", start, now);
  console.log(`${c12h.length} candles`);

  console.log(`\nActual coverage: ${new Date(c15[0].t).toISOString().slice(0,10)} – ${new Date(c15[c15.length-1].t).toISOString().slice(0,10)}`);

  runSim(c15, c12h, `SOLUSDT · BASELINE (live logic) · Binance.US, CONTINUOUS`);
})();
