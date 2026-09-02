// Audit script for the SOLBTC slope-filter strategy — NOT a strategy variant.
// Instruments the exact slope-filter logic (buy: RSI arm 30 + EMA bullish + sloping;
// sell: RSI arm 70 + EMA bearish) to surface structural risks that plain PnL numbers hide:
//   1. Hold-duration distribution — how long positions are actually held.
//   2. "Stuck risk" — since SELL requires RSI to first cross ABOVE 70 before it can arm the
//      exit, a position where price falls straight through without ever popping RSI above 70
//      would never exit on this logic (no independent stop-loss / trend-only exit).
//   3. Time-in-market — % of each year spent holding SOL vs sitting in BTC.
// Data source: Binance.US (same venue as live bot). Read-only, does not touch live bots.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE       = "https://api.binance.us/api/v3";
const LOOKBACK   = 365 * 24 * 60 * 60 * 1000;
const RSI_LOW    = 30;
const RSI_HIGH   = 70;
const MA_FAST    = 7;
const MA_SLOW    = 25;

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

function audit(c15: C[], c12h: C[], label: string) {
  const rsi = calcRSI(c15);
  const f12 = calcEMA(c12h, MA_FAST);
  const s12 = calcEMA(c12h, MA_SLOW);

  const trend12h: { t: number; fast: number; prevFast: number; slow: number; close: number }[] = c12h.map((c, i) => ({
    t: c.t, fast: f12[i], prevFast: i > 0 ? f12[i-1] : NaN, slow: s12[i], close: c.c,
  }));

  function getTrend(t: number, livePrice: number): { bullish: boolean; sloping: boolean } {
    let idx = -1;
    for (let i = trend12h.length - 1; i >= 0; i--) {
      if (trend12h[i].t <= t) { idx = i; break; }
    }
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
  let entryT = 0;
  let sawRsiAbove70SinceEntry = false;
  let solTimeMs = 0, btcTimeMs = 0;
  const holdDurationsHrs: number[] = [];
  let maxHoldNoArmHrs = 0; // longest stretch holding SOL while RSI has NOT yet crossed above 70

  for (let i = 1; i < c15.length; i++) {
    if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
    const price = c15[i].c;
    const t     = c15[i].t;
    const dtMs  = i > 0 ? c15[i].t - c15[i-1].t : 0;

    if (mode === "SOL") {
      solTimeMs += dtMs;
      if (rsi[i] > RSI_HIGH) sawRsiAbove70SinceEntry = true;
      if (!sawRsiAbove70SinceEntry) {
        const stuckHrs = (t - entryT) / 3_600_000;
        if (stuckHrs > maxHoldNoArmHrs) maxHoldNoArmHrs = stuckHrs;
      }
    } else {
      btcTimeMs += dtMs;
    }

    if (rsi[i-1] < RSI_LOW && rsi[i] >= RSI_LOW && mode === "BTC" && !armedForSol) armedForSol = true;
    if (rsi[i-1] > RSI_HIGH && rsi[i] <= RSI_HIGH && mode === "SOL" && !armedForBtc) armedForBtc = true;

    const { bullish, sloping } = getTrend(t, price);

    if (mode === "BTC" && armedForSol && bullish && sloping) {
      mode = "SOL";
      armedForSol = false;
      entryT = t;
      sawRsiAbove70SinceEntry = false;
    }

    if (mode === "SOL" && armedForBtc && !bullish) {
      const holdHrs = (t - entryT) / 3_600_000;
      holdDurationsHrs.push(holdHrs);
      mode = "BTC";
      armedForBtc = false;
    }
  }

  const totalMs = solTimeMs + btcTimeMs;
  const pctInSol = totalMs > 0 ? (solTimeMs / totalMs * 100) : 0;
  const avgHold = holdDurationsHrs.length ? holdDurationsHrs.reduce((a,b)=>a+b,0) / holdDurationsHrs.length : 0;
  const maxHold = holdDurationsHrs.length ? Math.max(...holdDurationsHrs) : 0;
  const minHold = holdDurationsHrs.length ? Math.min(...holdDurationsHrs) : 0;
  const longHolds = holdDurationsHrs.filter(h => h > 24 * 14); // held > 2 weeks

  console.log(`\n${"═".repeat(60)}`);
  console.log(` AUDIT · ${label}`);
  console.log(`${"═".repeat(60)}`);
  console.log(` Time in SOL: ${pctInSol.toFixed(1)}%  |  Time in BTC: ${(100-pctInSol).toFixed(1)}%`);
  console.log(` Hold duration (closed trades): avg ${(avgHold/24).toFixed(1)}d, min ${(minHold/24).toFixed(2)}d, max ${(maxHold/24).toFixed(1)}d`);
  console.log(` Trades held > 14 days: ${longHolds.length} / ${holdDurationsHrs.length}`);
  console.log(` Longest stretch holding SOL WITHOUT RSI ever popping above 70 (i.e. exit could not have armed yet): ${(maxHoldNoArmHrs/24).toFixed(1)} days`);
  if (mode === "SOL") {
    console.log(` ⚠ Still open in SOL at end of window (marked to market, not counted as a closed hold above)`);
  }
}

(async () => {
  const now    = Date.now();
  const starts = [
    { s: now - LOOKBACK,     e: now },
    { s: now - 2 * LOOKBACK, e: now - LOOKBACK },
    { s: now - 3 * LOOKBACK, e: now - 2 * LOOKBACK },
    { s: now - 4 * LOOKBACK, e: now - 3 * LOOKBACK },
    { s: now - 5 * LOOKBACK, e: now - 4 * LOOKBACK },
  ];

  for (const period of starts) {
    const dLabel = `${new Date(period.s).toISOString().slice(0,10)} – ${new Date(period.e).toISOString().slice(0,10)}`;

    process.stdout.write(`Fetching SOLBTC 15m (${dLabel})... `);
    const c15  = await fetchKlines("SOLBTC", "15m", period.s, period.e);
    console.log(`${c15.length} candles`);

    process.stdout.write(`Fetching SOLBTC 12h (${dLabel})... `);
    const c12h = await fetchKlines("SOLBTC", "12h", period.s, period.e);
    console.log(`${c12h.length} candles`);

    if (c15.length < 2 || c12h.length < 2) { console.log(`  (skipping ${dLabel})`); continue; }

    audit(c15, c12h, dLabel);
  }
})();
