// Runs the top 5 pairs from the screening (ATOM/AVAX, ETC/LTC, BNB/SOL, SOL/ETH, SOL/BTC)
// over the full ~5-year history, 0% fee as confirmed. Read-only, does not touch live bots.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const ALLOCATION_USD = 50;
const ZSCORE_WINDOW = 50;
const Z_ENTRY = -2.0;
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

function runSim(pair: { t: number; a: number; b: number }[], label: string) {
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

  // yearly snapshots
  const yearSnaps: { label: string; startEq: number; endEq: number }[] = [];
  let curYear = "", yearStartEq = ALLOCATION_USD;

  for (let i = ZSCORE_WINDOW; i < pair.length; i++) {
    const price = series(i);
    const t = pair[i].t;
    const eq = inTrade ? qty * price : usd;
    const yr = new Date(t).toISOString().slice(0, 4);
    if (yr !== curYear) { if (curYear !== "") yearSnaps.push({ label: curYear, startEq: yearStartEq, endEq: eq }); curYear = yr; yearStartEq = eq; }

    if (!inTrade && zscores[i] <= Z_ENTRY) { entryPrice = price; entryIdx = i; qty = usd / price; usd = 0; inTrade = true; }
    if (inTrade) {
      const curPct = (price - entryPrice) / entryPrice * 100;
      const held = i - entryIdx;
      let closeNow = false;
      if (curPct >= TP_PCT) closeNow = true;
      else if (curPct <= -SL_PCT) closeNow = true;
      else if (held >= MAX_HOLD) closeNow = true;
      if (closeNow) { usd = qty * price; trades++; if (usd > qty * entryPrice) wins++; qty = 0; inTrade = false; }
    }
    const eq2 = inTrade ? qty * price : usd;
    if (eq2 > peak) peak = eq2;
    const dd = (peak - eq2) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  if (curYear !== "") {
    const finalEq = inTrade ? qty * series(pair.length - 1) : usd;
    yearSnaps.push({ label: curYear, startEq: yearStartEq, endEq: finalEq });
  }

  const finalVal = inTrade ? qty * series(pair.length - 1) : usd;
  const ret = (finalVal - ALLOCATION_USD) / ALLOCATION_USD * 100;
  const wr = trades ? (wins / trades * 100).toFixed(1) : "-";
  console.log(`\n${label}`);
  console.log(`  Total: ${(ret>=0?"+":"")+ret.toFixed(1)}%   $${finalVal.toFixed(2)}   trades=${trades}   WR=${wr}%   maxDD=${maxDD.toFixed(1)}%`);
  for (const { label: yl, startEq, endEq } of yearSnaps) {
    const yret = (endEq - startEq) / startEq * 100;
    console.log(`    ${yl}  ${yret >= 0 ? "+" : ""}${yret.toFixed(1)}%`);
  }
}

(async () => {
  const now = Date.now();
  const start = now - 3 * 365 * 24 * 60 * 60 * 1000;

  const pairs: [string, string][] = [["LINK","AVAX"], ["SOL","BTC"]];
  const coins = Array.from(new Set(pairs.flat()));
  const series: Record<string, C[]> = {};
  for (const coin of coins) {
    process.stdout.write(`Fetching ${coin}USDT 5m (5yr)... `);
    series[coin] = await fetchKlines(`${coin}USDT`, "5m", start, now);
    console.log(`${series[coin].length}`);
  }

  console.log(`\nZ-score pairs · top 5 from screening · full 5yr · 0% fee\n`);
  for (const [x, y] of pairs) {
    const aligned = alignByTimestamp(series[x], series[y]);
    runSim(aligned, `${x}/${y} — buy ${x} when ratio low (${aligned.length} candles)`);
  }
})();
