// Tests position SIZING (not skipping) based on depthFromHigh90d — the one entry feature
// that survived the correlation audit (Spearman -0.24, weak but consistent). Every signal
// still fires (no trade is ever blocked, so the tail trades are never at risk of being
// missed) but the fraction of the BTC stack committed scales with how deep the entry is:
//   sizeFraction = clamp(0.25 + (|depthFromHigh90d| / 30) * 0.75, 0.25, 1.0)
//   i.e. a shallow dip (near the 90d high) risks only 25% of the stack; a deep dip
//   (>=30% below the 90d high) risks the full 100%. Linear in between.
// The untraded remainder just sits in BTC for that trade (not reinvested elsewhere).
// Compared against the flat-100%-size slope-filter baseline, same continuous 5yr dataset.
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
const SIZE_FLOOR = 0.25;
const SIZE_DEPTH_FOR_FULL = 30; // % below 90d high at which sizing reaches 100%

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

function highNDaysBefore(c15: C[], idx: number, days: number): number {
  const targetT = c15[idx].t - days * 86_400_000;
  let lo = 0, hi = idx, found = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (c15[mid].t <= targetT) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  let hi90 = -Infinity;
  for (let j = found; j <= idx; j++) if (c15[j].c > hi90) hi90 = c15[j].c;
  return hi90;
}

function sizeFractionFor(depthPct: number): number {
  // depthPct is negative (below high) or 0; use magnitude
  const mag = Math.abs(depthPct);
  const frac = SIZE_FLOOR + (mag / SIZE_DEPTH_FOR_FULL) * (1 - SIZE_FLOOR);
  return Math.min(1, Math.max(SIZE_FLOOR, frac));
}

type Mode = "BTC" | "SOL" | "MIXED"; // MIXED: partial BTC + partial SOL held simultaneously

function runSim(c15: C[], c12h: C[], btcUsd: C[], label: string, useSizing: boolean) {
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
  let btcIdle = startBtc;   // BTC not currently at risk
  let btcInTrade = 0;       // BTC committed to the current position (basis)
  let solQty = 0;
  let mode: Mode = "BTC";
  let armedForSol = false, armedForBtc = false;
  let trades = 0, wins = 0;
  let peakUsd = ALLOCATION_USD, maxDD = 0;
  const sizeLog: number[] = [];

  for (let i = 1; i < c15.length; i++) {
    if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
    const price = c15[i].c;
    const t     = c15[i].t;
    const usdPx = btcUsdAt(btcUsd, t);

    if (rsi[i-1] < RSI_LOW && rsi[i] >= RSI_LOW && mode === "BTC" && !armedForSol) armedForSol = true;
    if (rsi[i-1] > RSI_HIGH && rsi[i] <= RSI_HIGH && mode !== "BTC" && !armedForBtc) armedForBtc = true;

    const { bullish, sloping } = getTrend(t, price);

    if (mode === "BTC" && armedForSol && bullish && sloping) {
      const high90 = highNDaysBefore(c15, i, 90);
      const depthPct = (price - high90) / high90 * 100;
      const sizeFrac = useSizing ? sizeFractionFor(depthPct) : 1.0;
      sizeLog.push(sizeFrac);

      btcInTrade = btcIdle * sizeFrac;
      btcIdle    = btcIdle * (1 - sizeFrac);
      solQty     = btcInTrade / price;
      mode       = sizeFrac >= 0.999 ? "SOL" : "MIXED";
      armedForSol = false;
      const eq = solQty * price * usdPx + btcIdle * usdPx;
      if (eq > peakUsd) peakUsd = eq;
    }

    if (mode !== "BTC" && armedForBtc && !bullish) {
      const btcOut = solQty * price;
      const pnlBtc = btcOut - btcInTrade;
      trades++;
      if (pnlBtc > 0) wins++;
      btcIdle += btcOut;   // reunify into the idle pool
      btcInTrade = 0;
      solQty = 0;
      const eqUsd2 = btcIdle * usdPx;
      if (eqUsd2 > peakUsd) peakUsd = eqUsd2;
      const dd = (peakUsd - eqUsd2) / peakUsd * 100;
      if (dd > maxDD) maxDD = dd;
      mode = "BTC";
      armedForBtc = false;
    }

    if (mode !== "BTC") {
      const eq = solQty * price * usdPx + btcIdle * usdPx;
      if (eq > peakUsd) peakUsd = eq;
      const dd = (peakUsd - eq) / peakUsd * 100;
      if (dd > maxDD) maxDD = dd;
    }
  }

  const lastUsdPx = btcUsdAt(btcUsd, c15[c15.length-1].t);
  const finalBtc  = mode !== "BTC" ? (solQty * c15[c15.length-1].c + btcIdle) : btcIdle;
  const finalUsd  = finalBtc * lastUsdPx;
  const btcAccumRet = (finalBtc - startBtc) / startBtc * 100;
  const wr = trades > 0 ? (wins / trades * 100).toFixed(1) : "—";
  const avgSize = sizeLog.length ? (sizeLog.reduce((a,b)=>a+b,0)/sizeLog.length*100).toFixed(0) : "n/a";

  console.log(`\n${label}`);
  console.log(`  BTC accumulated: ${startBtc.toFixed(8)} → ${finalBtc.toFixed(8)}  (${btcAccumRet >= 0 ? "+" : ""}${btcAccumRet.toFixed(1)}%)`);
  console.log(`  USD mark-to-market: $${finalUsd.toFixed(2)}  |  Trades: ${trades}  |  WR: ${wr}%  |  Max DD: ${maxDD.toFixed(2)}%${useSizing ? `  |  Avg size: ${avgSize}%` : ""}`);
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

  console.log(`\n${"═".repeat(80)}`);
  console.log(` SOLBTC · continuous 5yr · ${dLabel} · Binance.US`);
  console.log(`${"═".repeat(80)}`);

  runSim(c15, c12h, btcUsd, `[BASELINE] Slope filter, flat 100% size (current best)`, false);
  runSim(c15, c12h, btcUsd, `[SIZED] Slope filter + depth-based sizing (25%-100%, never skips a trade)`, true);
})();
