// Realistic Z-score test on SOL/BTC — the most liquid of the 5 screened pairs. Sweeps wider
// z-score entry thresholds (fewer, larger-conviction trades) and applies a small spread-based
// friction cost per round trip, to see if a believable edge survives once trade frequency
// drops and realistic execution cost is included. 2-year window. Read-only.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://api.binance.us/api/v3";
const ALLOCATION_USD = 50;
const ZSCORE_WINDOW = 50;
const TP_PCT = 0.8;
const SL_PCT = 0.3;
const MAX_HOLD = 6;

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
function alignByTimestamp(a: C[], b: C[]): { t: number; a: number; b: number }[] {
  const bMap = new Map(b.map(c => [c.t, c.c]));
  const out: { t: number; a: number; b: number }[] = [];
  for (const c of a) { const bv = bMap.get(c.t); if (bv !== undefined) out.push({ t: c.t, a: c.c, b: bv }); }
  return out;
}

function runSim(pair: { t: number; a: number; b: number }[], zEntry: number, feePctPerSide: number, label: string) {
  const ratios = pair.map(p => p.a / p.b);
  const zscores: number[] = new Array(pair.length).fill(NaN);
  for (let i = ZSCORE_WINDOW; i < pair.length; i++) {
    const window = ratios.slice(i - ZSCORE_WINDOW, i);
    const mean = window.reduce((s, v) => s + v, 0) / window.length;
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
    const std = Math.sqrt(variance);
    zscores[i] = std > 0 ? (ratios[i] - mean) / std : 0;
  }

  let usd = ALLOCATION_USD, qty = 0, inTrade = false;
  let entryPrice = 0, entryIdx = 0, trades = 0, wins = 0;
  let peak = ALLOCATION_USD, maxDD = 0;
  const series = (i: number) => pair[i].a;

  for (let i = ZSCORE_WINDOW; i < pair.length; i++) {
    const price = series(i);
    if (!inTrade && zscores[i] <= zEntry) {
      entryPrice = price; entryIdx = i;
      qty = (usd * (1 - feePctPerSide / 100)) / price;
      usd = 0; inTrade = true;
    }
    if (inTrade) {
      const curPct = (price - entryPrice) / entryPrice * 100;
      const held = i - entryIdx;
      let closeNow = false;
      if (curPct >= TP_PCT) closeNow = true;
      else if (curPct <= -SL_PCT) closeNow = true;
      else if (held >= MAX_HOLD) closeNow = true;
      if (closeNow) {
        usd = qty * price * (1 - feePctPerSide / 100);
        trades++; if (usd > qty * entryPrice) wins++;
        qty = 0; inTrade = false;
      }
    }
    const eq = inTrade ? qty * price : usd;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  const finalVal = inTrade ? qty * series(pair.length - 1) : usd;
  const ret = (finalVal - ALLOCATION_USD) / ALLOCATION_USD * 100;
  const wr = trades ? (wins / trades * 100).toFixed(1) : "-";
  console.log(`${label.padEnd(38)}${(ret>=0?"+":"")+ret.toFixed(1).padStart(10)}%   $${finalVal.toFixed(2).padStart(10)}   trades=${String(trades).padStart(5)}   WR=${wr.padStart(5)}%   maxDD=${maxDD.toFixed(1)}%`);
}

(async () => {
  const now = Date.now();
  const start = now - 2 * 365 * 24 * 60 * 60 * 1000;

  process.stdout.write(`Fetching SOLUSDT 5m (2yr)... `); const sol = await fetchKlines("SOLUSDT", "5m", start, now); console.log(`${sol.length}`);
  process.stdout.write(`Fetching BTCUSDT 5m (2yr)... `); const btc = await fetchKlines("BTCUSDT", "5m", start, now); console.log(`${btc.length}`);
  const pair = alignByTimestamp(sol, btc);
  console.log(`${pair.length} aligned candles\n`);

  console.log(`SOL/BTC Z-score · 2yr · ALL thresholds at 0% fee vs 0.02% typical spread\n`);
  for (const z of [-2.0, -2.5, -3.0, -3.5, -4.0]) {
    runSim(pair, z, 0, `z<=${z} — 0% fee`);
    runSim(pair, z, 0.02, `z<=${z} — 0.02%/side spread`);
  }
})();
