// Baseline: bet EVERY 1m candle unconditionally (no VWAP/BB/any armer), TP/SL from CLI args.
// True 1-min entries — same candle series used for signal AND HL execution. SOLFDUSD.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const ALLOCATION_USD = 50;
const TP_PCT = parseFloat(process.argv[2] ?? "1.0");
const SL_PCT = parseFloat(process.argv[3] ?? "0.1");
const YEARS = parseFloat(process.argv[4] ?? "2");
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

// tieBreak: "SL" = conservative (assume SL hit first on ambiguous candles, current default)
//           "TP" = optimistic  (assume TP hit first on ambiguous candles)
function runSim(c1: C1[], windowStartMs: number, tieBreak: "SL" | "TP") {
  let usd = ALLOCATION_USD, qty = 0;
  let tradesCount = 0, wins = 0, tpHits = 0, slHits = 0, stillOpen = 0, ambiguous = 0;
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
      if (hitTP && hitSL) {
        ambiguous++;
        if (tieBreak === "SL") { exitPrice = sl; reason = "SL"; }
        else { exitPrice = tp; reason = "TP"; }
        break;
      }
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
  return { ret, trades: tradesCount, wr, maxDD, finalVal, tpHits, slHits, stillOpen, ambiguous };
}

(async () => {
  const now = Date.now();
  const windowStart = now - YEARS * 365 * 24 * 60 * 60 * 1000;
  const fetchStart = windowStart - 10 * MIN_MS;

  const symbol = "SOLFDUSD";
  process.stdout.write(`[TP=${TP_PCT}%/SL=${SL_PCT}%] Fetching ${symbol} 1m (${YEARS}yr, will take a while)... `);
  const raw1 = await fetchKlines(symbol, "1m", fetchStart, now);
  const c1: C1[] = raw1.map(c => ({ t: +c[0], h: +c[2], l: +c[3], c: +c[4] }));
  console.log(`${c1.length}`);

  console.log(`\nSOLFDUSD every-bar (no filter) · 1-MIN entries · ${YEARS}yr · TP=${TP_PCT}%/SL=${SL_PCT}%\n`);

  const cons = runSim(c1, windowStart, "SL");
  console.log(`CONSERVATIVE (ties -> SL, current default): ${(cons.ret>=0?"+":"")+cons.ret.toFixed(1)}%   $${cons.finalVal.toFixed(2)}   trades=${cons.trades}   WR=${cons.wr.toFixed(1)}%   maxDD=${cons.maxDD.toFixed(1)}%   TP=${cons.tpHits} SL=${cons.slHits}   ambiguous(both-hit-same-candle)=${cons.ambiguous} (${(cons.ambiguous/cons.trades*100).toFixed(2)}% of trades)${cons.stillOpen?` (${cons.stillOpen} still open)`:""}`);

  const opt = runSim(c1, windowStart, "TP");
  console.log(`OPTIMISTIC   (ties -> TP):                   ${(opt.ret>=0?"+":"")+opt.ret.toFixed(1)}%   $${opt.finalVal.toFixed(2)}   trades=${opt.trades}   WR=${opt.wr.toFixed(1)}%   maxDD=${opt.maxDD.toFixed(1)}%   TP=${opt.tpHits} SL=${opt.slHits}   ambiguous(both-hit-same-candle)=${opt.ambiguous} (${(opt.ambiguous/opt.trades*100).toFixed(2)}% of trades)${opt.stillOpen?` (${opt.stillOpen} still open)`:""}`);
})();
