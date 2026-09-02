// Z-score correlation-break pairs strategy on 5m candles — revives the earlier paper bot
// (BNBUSDT vs ATOMUSDT, Z=-2.0 entry, TP=0.8%, SL=0.3%, max hold=6 candles, chase exit).
// Trades the spread's statistical deviation from its rolling mean, not price direction.
// Tests on the last ~2 years (5m data volume is large) on Binance.US. Read-only.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://api.binance.us/api/v3";
const ALLOCATION_USD = 50;
const ZSCORE_WINDOW = 50; // rolling window for mean/std of the ratio
const Z_ENTRY = -2.0;
const TP_PCT = 0.8;
const SL_PCT = 0.3;
const MAX_HOLD = 6; // candles

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
  for (const c of a) {
    const bv = bMap.get(c.t);
    if (bv !== undefined) out.push({ t: c.t, a: c.c, b: bv });
  }
  return out;
}

function runSim(pair: { t: number; a: number; b: number }[], label: string, tradeLeg: "a"|"b", feePctPerSide: number = 0) {
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

    if (!inTrade && zscores[i] <= Z_ENTRY) {
      entryPrice = price; entryIdx = i;
      qty = (usd * (1 - feePctPerSide / 100)) / price; // fee on entry
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
        usd = qty * price * (1 - feePctPerSide / 100); // fee on exit
        trades++; if (usd > (qty * entryPrice)) wins++;
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
  console.log(`${label.padEnd(30)}${(ret>=0?"+":"")+ret.toFixed(1).padStart(8)}%   $${finalVal.toFixed(2).padStart(8)}   trades=${trades}   WR=${wr}%   maxDD=${maxDD.toFixed(1)}%`);
}

(async () => {
  const now = Date.now();
  const start = now - 2 * 365 * 24 * 60 * 60 * 1000; // 2yr, 5m data is heavy

  process.stdout.write(`Fetching BNBUSDT 5m... `); const bnb = await fetchKlines("BNBUSDT", "5m", start, now); console.log(`${bnb.length}`);
  process.stdout.write(`Fetching ATOMUSDT 5m... `); const atom = await fetchKlines("ATOMUSDT", "5m", start, now); console.log(`${atom.length}`);
  process.stdout.write(`Fetching SOLUSDT 5m... `); const sol = await fetchKlines("SOLUSDT", "5m", start, now); console.log(`${sol.length}`);
  process.stdout.write(`Fetching BTCUSDT 5m... `); const btc = await fetchKlines("BTCUSDT", "5m", start, now); console.log(`${btc.length}`);

  console.log(`\nZ-score pairs strategy · 5m candles · ~2yr\n`);

  const bnbAtom = alignByTimestamp(bnb, atom);
  console.log(`BNB/ATOM pair, ${bnbAtom.length} aligned candles`);
  runSim(bnbAtom, `0% fee (maker, as originally run)`, "a", 0);
  runSim(bnbAtom, `0.05% fee/side (optimistic maker)`, "a", 0.05);
  runSim(bnbAtom, `0.1% fee/side (typical taker)`, "a", 0.1);
  runSim(bnbAtom, `0.2% fee/side (worst case)`, "a", 0.2);

  const solBtc = alignByTimestamp(sol, btc);
  console.log(`\nSOL/BTC pair, ${solBtc.length} aligned candles`);
  runSim(solBtc, `0% fee (maker, as originally run)`, "a", 0);
  runSim(solBtc, `0.05% fee/side (optimistic maker)`, "a", 0.05);
  runSim(solBtc, `0.1% fee/side (typical taker)`, "a", 0.1);
  runSim(solBtc, `0.2% fee/side (worst case)`, "a", 0.2);
})();
