// Baseline: bet EVERY 1m candle unconditionally (no VWAP/BB/any armer), TP/SL from CLI args.
// SOLBTC pair — denominated in BTC, not USD. Objective: accumulate more BTC (or more SOL if
// run in reverse), not USD profit. True 1-min entries, 1-min HL execution, conservative
// tie-break (ambiguous candle -> SL). Also compares against a standard ~0.1% round-trip
// fee, since SOLBTC is NOT a 0%-fee promo pair like the FDUSD pairs used elsewhere.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const ALLOCATION_BTC = 0.001; // arbitrary starting BTC stake
const TP_PCT = parseFloat(process.argv[2] ?? "1.0");
const SL_PCT = parseFloat(process.argv[3] ?? "0.1");
const MONTHS = parseFloat(process.argv[4] ?? "3");
const MIN_MS = 60 * 1000;

type C1 = { t: number; h: number; l: number; c: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
async function fetchKlines(symbol: string, interval: string, startMs: number, endMs: number): Promise<any[]> {
  const out: any[] = []; let from = startMs;
  while (from < endMs) {
    const res = await fetch(`${BASE}/klines?symbol=${symbol}&interval=${interval}&startTime=${from}&endTime=${endMs}&limit=1000`);
    if (res.status === 429) { await sleep(6000); continue; }
    if (!res.ok) return out;
    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) out.push(c);
    from = +raw[raw.length - 1][0] + 1;
    await sleep(90);
  }
  return out;
}

function runSim(c1: C1[], windowStartMs: number, roundTripCostPct: number) {
  let btc = ALLOCATION_BTC, qty = 0;
  let tradesCount = 0, wins = 0, tpHits = 0, slHits = 0, stillOpen = 0;
  let peak = ALLOCATION_BTC, maxDD = 0;

  let startIdx = c1.findIndex(c => c.t >= windowStartMs);
  if (startIdx < 0) startIdx = 0;

  let i = startIdx;
  while (i < c1.length) {
    const entryPrice = c1[i].c;
    const tp = entryPrice * (1 + TP_PCT / 100);
    const sl = entryPrice * (1 - SL_PCT / 100);
    qty = btc / entryPrice; btc = 0;

    let j = i + 1;
    let exitPrice: number | null = null;
    let reason = "";
    while (j < c1.length) {
      const hitTP = c1[j].h >= tp;
      const hitSL = c1[j].l <= sl;
      if (hitTP && hitSL) { exitPrice = sl; reason = "SL"; break; } // conservative tie-break
      if (hitTP) { exitPrice = tp; reason = "TP"; break; }
      if (hitSL) { exitPrice = sl; reason = "SL"; break; }
      j++;
    }
    if (exitPrice === null) {
      const lastPrice = c1.length ? c1[c1.length - 1].c : entryPrice;
      btc = qty * lastPrice * (1 - roundTripCostPct / 100); qty = 0; stillOpen++; break;
    }

    const grossBtc = qty * exitPrice;
    btc = grossBtc * (1 - roundTripCostPct / 100);
    tradesCount++; if (btc > qty * entryPrice) wins++;
    if (reason === "TP") tpHits++; else slHits++;
    qty = 0;

    const eq = btc;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak * 100;
    if (dd > maxDD) maxDD = dd;

    i = j + 1;
  }

  const finalVal = btc;
  const ret = (finalVal - ALLOCATION_BTC) / ALLOCATION_BTC * 100;
  const wr = tradesCount ? wins / tradesCount * 100 : 0;
  return { ret, trades: tradesCount, wr, maxDD, finalVal, tpHits, slHits, stillOpen };
}

(async () => {
  const now = Date.now();
  const windowStart = now - MONTHS * 30 * 24 * 60 * 60 * 1000;
  const fetchStart = windowStart - 10 * MIN_MS;

  const symbol = "SOLBTC";
  process.stdout.write(`[TP=${TP_PCT}%/SL=${SL_PCT}%] Fetching ${symbol} 1m (${MONTHS}mo)... `);
  const raw1 = await fetchKlines(symbol, "1m", fetchStart, now);
  const c1: C1[] = raw1.map(c => ({ t: +c[0], h: +c[2], l: +c[3], c: +c[4] }));
  console.log(`${c1.length}`);

  console.log(`\nSOLBTC every-bar (no filter) · 1-MIN entries · ${MONTHS}mo · TP=${TP_PCT}%/SL=${SL_PCT}% · denominated in BTC\n`);

  const noFee = runSim(c1, windowStart, 0);
  console.log(`NO COST (0%):                     ${(noFee.ret>=0?"+":"")+noFee.ret.toFixed(1)}%   ${noFee.finalVal.toFixed(8)} BTC   trades=${noFee.trades}   WR=${noFee.wr.toFixed(1)}%   maxDD=${noFee.maxDD.toFixed(1)}%   TP=${noFee.tpHits} SL=${noFee.slHits}${noFee.stillOpen?` (${noFee.stillOpen} still open)`:""}`);

  const withFee = runSim(c1, windowStart, 0.1);
  console.log(`WITH 0.1% ROUND-TRIP (standard fee): ${(withFee.ret>=0?"+":"")+withFee.ret.toFixed(1)}%   ${withFee.finalVal.toFixed(8)} BTC   trades=${withFee.trades}   WR=${withFee.wr.toFixed(1)}%   maxDD=${withFee.maxDD.toFixed(1)}%   TP=${withFee.tpHits} SL=${withFee.slHits}${withFee.stillOpen?` (${withFee.stillOpen} still open)`:""}`);
})();
