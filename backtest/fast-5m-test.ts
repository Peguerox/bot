// Tests the current live strategies on 5m candles instead of 15m — same RSI(14) arm + 12h
// EMA(7/25) trend filter + current-best exits, just computed on a faster timeframe. Compares
// against 15m over the identical 6-month window. SOLUSDT uses -6% stop + stepped trail
// (10pp until +30%, then 6pp). SOLBTC uses slope filter + trailing (arm@6%, trail@7.5pp).
// Read-only, does not touch live bots.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://api.binance.us/api/v3";
const MA_FAST = 7, MA_SLOW = 25;
const RSI_LOW = 30, RSI_HIGH = 70;
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
function btcUsdAt(btcUsd: C[], t: number): number {
  let lo = 0, hi = btcUsd.length - 1, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (btcUsd[mid].t <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  return idx >= 0 ? btcUsd[idx].c : btcUsd[0].c;
}

function getTrendFn(c12h: C[]) {
  const f12 = calcEMA(c12h, MA_FAST), s12 = calcEMA(c12h, MA_SLOW);
  const trend12h = c12h.map((c, i) => ({ t: c.t, fast: f12[i], prevFast: i > 0 ? f12[i-1] : NaN, slow: s12[i], close: c.c }));
  return function getTrend(t: number, livePrice: number) {
    let idx = -1;
    for (let i = trend12h.length - 1; i >= 0; i--) { if (trend12h[i].t <= t) { idx = i; break; } }
    if (idx < 0) return { bullish: false, sloping: false };
    const { fast, prevFast, slow, close } = trend12h[idx];
    if (isNaN(fast) || isNaN(slow)) return { bullish: false, sloping: false };
    const delta = livePrice - close;
    const liveFast = fast + delta / MA_FAST, liveSlow = slow + delta / MA_SLOW;
    return { bullish: liveFast > liveSlow, sloping: !isNaN(prevFast) && liveFast > prevFast };
  };
}

function runUsdt(cN: C[], c12h: C[], label: string) {
  const rsi = calcRSI(cN);
  const getTrend = getTrendFn(c12h);
  const HARD_STOP = -6, TRAIL_ARM = 8, TRAIL_PP = 10, STEP_THRESH = 30, STEP_PP = 6;

  let usdt = ALLOCATION_USD, solQty = 0, mode: "USDT"|"SOL" = "USDT";
  let armedForSol = false, entryPrice = 0, bestPct = 0, trades = 0, wins = 0;

  for (let i = 1; i < cN.length; i++) {
    if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
    const price = cN[i].c, t = cN[i].t;
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
    if (closeNow) {
      usdt = solQty * price;
      trades++; if (usdt > solQty * entryPrice) wins++;
      solQty = 0; mode = "USDT";
    }
  }
  const finalVal = mode === "SOL" ? solQty * cN[cN.length-1].c : usdt;
  const ret = (finalVal - ALLOCATION_USD) / ALLOCATION_USD * 100;
  console.log(`${label.padEnd(34)}${(ret>=0?"+":"")+ret.toFixed(1).padStart(8)}%   $${finalVal.toFixed(2).padStart(8)}   trades=${trades}   WR=${trades?(wins/trades*100).toFixed(1):"-"}%`);
}

function runBtc(cN: C[], c12h: C[], btcUsd: C[], label: string) {
  const rsi = calcRSI(cN);
  const getTrend = getTrendFn(c12h);
  const TRAIL_ARM = 6, TRAIL_PP = 7.5;

  const startBtc = ALLOCATION_USD / btcUsdAt(btcUsd, cN[0].t);
  let btc = startBtc, solQty = 0, mode: "BTC"|"SOL" = "BTC";
  let armedForSol = false, armedForBtc = false, entryPrice = 0, bestPct = 0, trades = 0, wins = 0;

  for (let i = 1; i < cN.length; i++) {
    if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
    const price = cN[i].c, t = cN[i].t;
    if (rsi[i-1] < RSI_LOW && rsi[i] >= RSI_LOW && mode === "BTC" && !armedForSol) armedForSol = true;
    if (rsi[i-1] > RSI_HIGH && rsi[i] <= RSI_HIGH && mode === "SOL" && !armedForBtc) armedForBtc = true;
    const { bullish, sloping } = getTrend(t, price);
    if (mode === "BTC" && armedForSol && bullish && sloping) {
      entryPrice = price; bestPct = 0; solQty = btc / price; btc = 0; mode = "SOL"; armedForSol = false;
    }
    let closeNow = false;
    if (mode === "SOL") {
      const curPct = (price - entryPrice) / entryPrice * 100;
      if (curPct > bestPct) bestPct = curPct;
      if (bestPct >= TRAIL_ARM && bestPct - curPct >= TRAIL_PP) closeNow = true;
      else if (armedForBtc && !bullish) closeNow = true;
    }
    if (closeNow) {
      btc = solQty * price;
      trades++; if (btc > solQty * entryPrice) wins++;
      solQty = 0; mode = "BTC"; armedForBtc = false;
    }
  }
  const finalBtc = mode === "SOL" ? solQty * cN[cN.length-1].c : btc;
  const finalUsd = finalBtc * btcUsdAt(btcUsd, cN[cN.length-1].t);
  const ret = (finalBtc - startBtc) / startBtc * 100;
  console.log(`${label.padEnd(34)}${(ret>=0?"+":"")+ret.toFixed(1).padStart(8)}%   $${finalUsd.toFixed(2).padStart(8)}   trades=${trades}   WR=${trades?(wins/trades*100).toFixed(1):"-"}%`);
}

(async () => {
  const now = Date.now();
  const start = now - 6 * 30 * 24 * 60 * 60 * 1000; // ~6 months
  const dLabel = `${new Date(start).toISOString().slice(0,10)} – ${new Date(now).toISOString().slice(0,10)}`;

  console.log(`\n=== SOLUSDT · ${dLabel} · 5m vs 15m entry granularity ===\n`);
  process.stdout.write(`Fetching SOLUSDT 5m... `);  const u5  = await fetchKlines("SOLUSDT", "5m", start, now);  console.log(`${u5.length}`);
  process.stdout.write(`Fetching SOLUSDT 15m... `); const u15 = await fetchKlines("SOLUSDT", "15m", start, now); console.log(`${u15.length}`);
  process.stdout.write(`Fetching SOLUSDT 12h... `); const u12h = await fetchKlines("SOLUSDT", "12h", start, now); console.log(`${u12h.length}`);
  runUsdt(u15, u12h, `15m (current live)`);
  runUsdt(u5, u12h, `5m (fast variant)`);

  console.log(`\n=== SOLBTC · ${dLabel} · 5m vs 15m entry granularity ===\n`);
  process.stdout.write(`Fetching SOLBTC 5m... `);  const b5  = await fetchKlines("SOLBTC", "5m", start, now);  console.log(`${b5.length}`);
  process.stdout.write(`Fetching SOLBTC 15m... `); const b15 = await fetchKlines("SOLBTC", "15m", start, now); console.log(`${b15.length}`);
  process.stdout.write(`Fetching SOLBTC 12h... `); const b12h = await fetchKlines("SOLBTC", "12h", start, now); console.log(`${b12h.length}`);
  process.stdout.write(`Fetching BTCUSDT 1h... `); const btcUsd = await fetchKlines("BTCUSDT", "1h", start, now); console.log(`${btcUsd.length}`);
  runBtc(b15, b12h, btcUsd, `15m (current live)`);
  runBtc(b5, b12h, btcUsd, `5m (fast variant)`);
})();
