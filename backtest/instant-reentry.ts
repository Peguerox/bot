// Instant re-entry: the moment a trade exits (TP or SL), immediately open the next trade at
// that exact exit price — checked against the SAME 1-min candle's high/low first (chaining
// multiple round-trips within one candle if its range allows), only advancing to the next
// candle once neither TP nor SL of the current position falls within the remaining range.
// TP=1.0%/SL=0.1%. SOLFDUSD, 3 months.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const ALLOCATION_USD = 50;
const TP_PCT = 1.0;
const SL_PCT = 0.1;
const MAX_CHAIN_PER_CANDLE = 50; // safety cap

type C1 = { t: number; o: number; h: number; l: number; c: number };

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
    await sleep(80);
  }
  return out;
}

function runSim(candles1: C1[], windowStartMs: number) {
  let usd = ALLOCATION_USD, qty = 0;
  let tradesCount = 0, wins = 0, tpHits = 0, slHits = 0;
  let peak = ALLOCATION_USD, maxDD = 0;

  let startIdx = candles1.findIndex(c => c.t >= windowStartMs);
  if (startIdx < 0) startIdx = 0;

  let entryPrice = candles1[startIdx].o;
  qty = usd / entryPrice; usd = 0;
  let tp = entryPrice * (1 + TP_PCT / 100);
  let sl = entryPrice * (1 - SL_PCT / 100);

  for (let i = startIdx; i < candles1.length; i++) {
    let chainCount = 0;
    while (chainCount < MAX_CHAIN_PER_CANDLE) {
      const hitTP = candles1[i].h >= tp;
      const hitSL = candles1[i].l <= sl;
      if (!hitTP && !hitSL) break;

      let exitPrice: number, reason: string;
      if (hitTP && hitSL) { exitPrice = sl; reason = "SL"; } // conservative
      else if (hitTP) { exitPrice = tp; reason = "TP"; }
      else { exitPrice = sl; reason = "SL"; }

      usd = qty * exitPrice;
      tradesCount++; if (usd > qty * entryPrice) wins++;
      if (reason === "TP") tpHits++; else slHits++;

      const eq = usd;
      if (eq > peak) peak = eq;
      const dd = (peak - eq) / peak * 100;
      if (dd > maxDD) maxDD = dd;

      // instant re-entry at the exact exit price
      entryPrice = exitPrice;
      qty = usd / entryPrice; usd = 0;
      tp = entryPrice * (1 + TP_PCT / 100);
      sl = entryPrice * (1 - SL_PCT / 100);
      chainCount++;
    }
  }

  const finalVal = qty * candles1[candles1.length - 1].c;
  const ret = (finalVal - ALLOCATION_USD) / ALLOCATION_USD * 100;
  const wr = tradesCount ? wins / tradesCount * 100 : 0;
  return { ret, trades: tradesCount, wr, maxDD, finalVal, tpHits, slHits };
}

(async () => {
  const now = Date.now();
  const windowStart = now - 90 * 24 * 60 * 60 * 1000; // 3mo

  const symbol = "SOLFDUSD";
  process.stdout.write(`Fetching ${symbol} 1m... `);
  const raw1 = await fetchKlines(symbol, "1m", windowStart, now);
  const c1: C1[] = raw1.map(c => ({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4] }));
  console.log(`${c1.length}`);

  const r = runSim(c1, windowStart);
  console.log(`\nSOLFDUSD instant re-entry · 3mo · TP=1.0%/SL=0.1%\n`);
  console.log(`${(r.ret>=0?"+":"")+r.ret.toFixed(1)}%   $${r.finalVal.toFixed(2)}   trades=${r.trades}   WR=${r.wr.toFixed(1)}%   maxDD=${r.maxDD.toFixed(1)}%   TP=${r.tpHits} SL=${r.slHits}`);
})();
