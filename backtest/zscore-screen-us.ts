// Screens multiple coin-pair combinations for the Z-score pairs strategy (0% fee, as
// confirmed) on 5m candles over the last 6 months, ranks them, prints results.
// Read-only, does not touch live bots.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://api.binance.us/api/v3";
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

function runSim(pair: { t: number; a: number; b: number }[], tradeLeg: "a"|"b"): { ret: number; trades: number; wr: number; maxDD: number } {
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
  const series = (i: number) => tradeLeg === "a" ? pair[i].a : pair[i].b;

  for (let i = ZSCORE_WINDOW; i < pair.length; i++) {
    const price = series(i);
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
    const eq = inTrade ? qty * price : usd;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  const finalVal = inTrade ? qty * series(pair.length - 1) : usd;
  const ret = (finalVal - ALLOCATION_USD) / ALLOCATION_USD * 100;
  return { ret, trades, wr: trades ? wins/trades*100 : 0, maxDD };
}

(async () => {
  const now = Date.now();
  const start = now - 6 * 30 * 24 * 60 * 60 * 1000; // 6mo for screening

  const pairs: [string, string][] = [
    ["SOL","BTC"], ["SOL","ETH"], ["BNB","ATOM"], ["ETH","BTC"], ["AVAX","DOT"],
    ["LINK","UNI"], ["ATOM","AVAX"], ["LTC","BCH"], ["ADA","DOT"], ["XRP","LTC"],
    ["ETC","LTC"], ["BNB","SOL"],
  ];
  const coins = Array.from(new Set(pairs.flat()));
  const series: Record<string, C[]> = {};
  for (const coin of coins) {
    process.stdout.write(`Fetching ${coin}USDT 5m... `);
    series[coin] = await fetchKlines(`${coin}USDT`, "5m", start, now);
    console.log(`${series[coin].length}`);
  }

  console.log(`\nZ-score pairs screening · 5m · 6mo · 0% fee\n`);
  const results: { pair: string; leg: string; ret: number; trades: number; wr: number; maxDD: number }[] = [];
  for (const [x, y] of pairs) {
    const aligned = alignByTimestamp(series[x], series[y]);
    const rx = runSim(aligned, "a"); // buy X when ratio X/Y is low
    const ry = runSim(aligned, "b"); // buy Y when ratio X/Y is low... not symmetric, see note below
    results.push({ pair: `${x}/${y}`, leg: x, ...rx });
  }
  results.sort((a, b) => b.ret - a.ret);
  for (const r of results) {
    console.log(`${r.pair.padEnd(12)}buy ${r.leg.padEnd(6)}${(r.ret>=0?"+":"")+r.ret.toFixed(1).padStart(9)}%   trades=${String(r.trades).padStart(4)}   WR=${r.wr.toFixed(1).padStart(5)}%   maxDD=${r.maxDD.toFixed(1)}%`);
  }
})();
