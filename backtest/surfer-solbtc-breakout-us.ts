// Tests a breakout entry for SOLBTC: buy when price closes above its N-period Donchian high
// (on 12h candles) instead of RSI dip + EMA trend. Keeps the proven trailing stop exit
// (arm@6%, trail@7.5pp) and the RSI-arm-70+EMA-bearish trend exit as fallback. Different
// signal family than anything tried — momentum breakout vs mean-reversion dip-buy.
// BTC-denominated, continuous ~5yr. Read-only, does not touch live bots.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE       = "https://api.binance.us/api/v3";
const LOOKBACK   = 365 * 24 * 60 * 60 * 1000;
const RSI_HIGH   = 70;
const ALLOCATION_USD = 50;
const TRAIL_ARM_PCT  = 6;
const TRAIL_PP       = 7.5;

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
function btcUsdAt(btcUsd: C[], t: number): number {
  let lo = 0, hi = btcUsd.length - 1, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (btcUsd[mid].t <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  return idx >= 0 ? btcUsd[idx].c : btcUsd[0].c;
}
function donchianHigh(c12h: C[], idx: number, period: number): number {
  let hi = -Infinity;
  for (let j = Math.max(0, idx - period); j < idx; j++) hi = Math.max(hi, c12h[j].c);
  return hi;
}

function runSim(c15: C[], c12h: C[], btcUsd: C[], breakoutPeriod: number, label: string) {
  const rsi15 = calcRSI(c15);
  // map each 12h close to its Donchian high (excluding itself) for breakout check
  const dHigh = c12h.map((_, i) => donchianHigh(c12h, i, breakoutPeriod));

  function get12hIdx(t: number): number {
    let idx = -1;
    for (let i = c12h.length - 1; i >= 0; i--) { if (c12h[i].t <= t) { idx = i; break; } }
    return idx;
  }

  const startBtc = ALLOCATION_USD / btcUsdAt(btcUsd, c15[0].t);
  let btc = startBtc, solQty = 0;
  let mode: "BTC" | "SOL" = "BTC";
  let armedForBtc = false;
  let entryPrice = 0, bestPct = 0;
  let trades = 0, wins = 0;
  let peakUsd = ALLOCATION_USD, maxDD = 0;

  for (let i = 1; i < c15.length; i++) {
    const price = c15[i].c, t = c15[i].t;
    const usdPx = btcUsdAt(btcUsd, t);
    const idx12h = get12hIdx(t);

    if (rsi15[i-1] > RSI_HIGH && rsi15[i] <= RSI_HIGH && mode === "SOL" && !armedForBtc) armedForBtc = true;

    // breakout entry: price closes above the Donchian high of the last N 12h candles
    const breakout = idx12h >= breakoutPeriod && !isNaN(dHigh[idx12h]) && price > dHigh[idx12h];

    if (mode === "BTC" && breakout) {
      entryPrice = price; bestPct = 0;
      solQty = btc / price; btc = 0; mode = "SOL";
      const eq = solQty * price * usdPx;
      if (eq > peakUsd) peakUsd = eq;
    }

    let closeNow = false;
    if (mode === "SOL") {
      const curPct = (price - entryPrice) / entryPrice * 100;
      if (curPct > bestPct) bestPct = curPct;
      if (bestPct >= TRAIL_ARM_PCT && (bestPct - curPct) >= TRAIL_PP) closeNow = true;
      else if (armedForBtc && price < dHigh[idx12h]) closeNow = true; // fallback: lose the breakout level + RSI armed
    }
    if (closeNow) {
      btc = solQty * price;
      trades++; if (btc > solQty * entryPrice) wins++;
      const eqUsd2 = btc * usdPx;
      if (eqUsd2 > peakUsd) peakUsd = eqUsd2;
      const dd = (peakUsd - eqUsd2) / peakUsd * 100;
      if (dd > maxDD) maxDD = dd;
      solQty = 0; mode = "BTC"; armedForBtc = false;
    }
    if (mode === "SOL") {
      const eq = solQty * price * usdPx;
      if (eq > peakUsd) peakUsd = eq;
      const dd = (peakUsd - eq) / peakUsd * 100;
      if (dd > maxDD) maxDD = dd;
    }
  }

  const lastUsdPx = btcUsdAt(btcUsd, c15[c15.length-1].t);
  const finalBtc = mode === "SOL" ? solQty * c15[c15.length-1].c : btc;
  const finalUsd = finalBtc * lastUsdPx;
  const ret = (finalBtc - startBtc) / startBtc * 100;
  const wr = trades ? (wins/trades*100).toFixed(1) : "-";
  console.log(`${label.padEnd(28)}${(ret>=0?"+":"")+ret.toFixed(1).padStart(8)}%   $${finalUsd.toFixed(2).padStart(8)}   trades=${trades}   WR=${wr}%   maxDD=${maxDD.toFixed(1)}%`);
}

(async () => {
  const now = Date.now(), start = now - 5 * LOOKBACK;
  process.stdout.write(`Fetching SOLBTC 15m... `); const c15 = await fetchKlines("SOLBTC", "15m", start, now); console.log(`${c15.length}`);
  process.stdout.write(`Fetching SOLBTC 12h... `); const c12h = await fetchKlines("SOLBTC", "12h", start, now); console.log(`${c12h.length}`);
  process.stdout.write(`Fetching BTCUSDT 1h... `); const btcUsd = await fetchKlines("BTCUSDT", "1h", start, now); console.log(`${btcUsd.length}`);

  console.log(`\nSOLBTC · continuous ~5yr · Donchian breakout entry (trail@6/7.5 exit)\n`);
  console.log(`[REFERENCE] current surfer (slope+trail)  +666.7%  $372.23  trades=132`);
  runSim(c15, c12h, btcUsd, 10, `breakout period=10 (5d)`);
  runSim(c15, c12h, btcUsd, 20, `breakout period=20 (10d)`);
  runSim(c15, c12h, btcUsd, 40, `breakout period=40 (20d)`);
  runSim(c15, c12h, btcUsd, 60, `breakout period=60 (30d)`);
})();
