// SOL Every-Bar config (no filter, 1-min entries, TP=1.0%/SL=0.1%, 1-min HL execution,
// conservative tie-break) tested on BTCUSDT and SOLUSDT, on both Binance.US and Binance
// Global, 3mo — isolates the exchange effect by holding the pair constant.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const TP_PCT = parseFloat(process.argv[2] ?? "1.0");
const SL_PCT = parseFloat(process.argv[3] ?? "0.1");
const ALLOCATION_USD = 50;
const MIN_MS = 60 * 1000;

type C1 = { t: number; h: number; l: number; c: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
async function fetchKlines(base: string, symbol: string, interval: string, startMs: number, endMs: number): Promise<any[]> {
  const out: any[] = []; let from = startMs;
  while (from < endMs) {
    const res = await fetch(`${base}/klines?symbol=${symbol}&interval=${interval}&startTime=${from}&endTime=${endMs}&limit=1000`);
    if (res.status === 429) { await sleep(6000); continue; }
    if (!res.ok) { console.log(`  fetch error ${res.status} for ${symbol} @ ${base}`); return out; }
    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) out.push(c);
    from = +raw[raw.length - 1][0] + 1;
    await sleep(90);
  }
  return out;
}

function runSim(c1: C1[], windowStartMs: number) {
  let usd = ALLOCATION_USD, qty = 0;
  let tradesCount = 0, wins = 0, tpHits = 0, slHits = 0, stillOpen = 0;
  let peak = ALLOCATION_USD, maxDD = 0;

  let startIdx = c1.findIndex(c => c.t >= windowStartMs);
  if (startIdx < 0) startIdx = 0;

  let i = startIdx;
  while (i < c1.length) {
    const entryPrice = c1[i].c;
    const tp = entryPrice * (1 + TP_PCT / 100);
    const sl = entryPrice * (1 - SL_PCT / 100);
    qty = usd / entryPrice; usd = 0;

    let j = i + 1;
    let exitPrice: number | null = null;
    let reason = "";
    while (j < c1.length) {
      const hitTP = c1[j].h >= tp;
      const hitSL = c1[j].l <= sl;
      if (hitTP && hitSL) { exitPrice = sl; reason = "SL"; break; }
      if (hitTP) { exitPrice = tp; reason = "TP"; break; }
      if (hitSL) { exitPrice = sl; reason = "SL"; break; }
      j++;
    }
    if (exitPrice === null) {
      const lastPrice = c1.length ? c1[c1.length - 1].c : entryPrice;
      usd = qty * lastPrice; qty = 0; stillOpen++; break;
    }

    usd = qty * exitPrice;
    tradesCount++; if (usd > qty * entryPrice) wins++;
    if (reason === "TP") tpHits++; else slHits++;
    qty = 0;

    const eq = usd;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak * 100;
    if (dd > maxDD) maxDD = dd;

    i = j + 1;
  }

  const finalVal = usd;
  const ret = (finalVal - ALLOCATION_USD) / ALLOCATION_USD * 100;
  const wr = tradesCount ? wins / tradesCount * 100 : 0;
  return { ret, trades: tradesCount, wr, maxDD, finalVal, tpHits, slHits, stillOpen };
}

(async () => {
  const now = Date.now();
  const windowStart = now - 90 * 24 * 60 * 60 * 1000; // 3mo
  const fetchStart = windowStart - 10 * MIN_MS;

  const targets = [
    { name: "BTCUSDT @ Binance.US",     base: "https://api.binance.us/api/v3",         symbol: "BTCUSDT" },
    { name: "SOLUSDT @ Binance.US",     base: "https://api.binance.us/api/v3",         symbol: "SOLUSDT" },
    { name: "BTCUSDT @ Binance Global", base: "https://data-api.binance.vision/api/v3", symbol: "BTCUSDT" },
    { name: "SOLUSDT @ Binance Global", base: "https://data-api.binance.vision/api/v3", symbol: "SOLUSDT" },
  ];

  console.log(`\nEvery-Bar (no filter) · 1-MIN entries · 3mo · TP=${TP_PCT}%/SL=${SL_PCT}% · $${ALLOCATION_USD}\n`);

  for (const t of targets) {
    process.stdout.write(`[${t.name}] Fetching 1m... `);
    const raw1 = await fetchKlines(t.base, t.symbol, "1m", fetchStart, now);
    const c1: C1[] = raw1.map(c => ({ t: +c[0], h: +c[2], l: +c[3], c: +c[4] }));
    console.log(`${c1.length}`);
    if (c1.length === 0) { console.log(`${t.name.padEnd(24)} NO DATA\n`); continue; }

    const r = runSim(c1, windowStart);
    console.log(`${t.name.padEnd(24)} ${(r.ret>=0?"+":"")+r.ret.toFixed(1)}%   $${r.finalVal.toFixed(2)}   trades=${r.trades}   WR=${r.wr.toFixed(1)}%   maxDD=${r.maxDD.toFixed(1)}%   TP=${r.tpHits} SL=${r.slHits}${r.stillOpen?` (${r.stillOpen} still open)`:""}\n`);
  }
})();
