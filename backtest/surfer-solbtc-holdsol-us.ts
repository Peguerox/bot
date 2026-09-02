// Computes buy-and-hold SOL (marked in BTC, i.e. just the raw SOLBTC price ratio) over the
// same continuous window and same calendar-year boundaries as the baseline/slope comparison,
// so it can sit as a third column next to those two. Read-only, no live bot involved.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE     = "https://api.binance.us/api/v3";
const LOOKBACK = 365 * 24 * 60 * 60 * 1000;

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

(async () => {
  const now   = Date.now();
  const start = now - 8 * LOOKBACK;
  const dLabel = `${new Date(start).toISOString().slice(0,10)} – ${new Date(now).toISOString().slice(0,10)}`;

  process.stdout.write(`Fetching SOLBTC 15m (${dLabel})... `);
  const c15 = await fetchKlines("SOLBTC", "15m", start, now);
  console.log(`${c15.length} candles\n`);

  const yearSnaps: { label: string; startPx: number; endPx: number }[] = [];
  let curYear = "", yearStartPx = c15[0].c;

  for (const c of c15) {
    const yr = new Date(c.t).toISOString().slice(0, 4);
    if (yr !== curYear) {
      if (curYear !== "") yearSnaps.push({ label: curYear, startPx: yearStartPx, endPx: c.c });
      curYear = yr; yearStartPx = c.c;
    }
  }
  yearSnaps.push({ label: curYear, startPx: yearStartPx, endPx: c15[c15.length-1].c });

  console.log(`Hold SOL instead (marked in BTC — buy SOL once at t0, never trade, value in BTC terms):`);
  for (const { label, startPx, endPx } of yearSnaps) {
    const ret = (endPx - startPx) / startPx * 100;
    console.log(`  ${label}  ${ret >= 0 ? "+" : ""}${ret.toFixed(1)}%`);
  }
  const totalRet = (c15[c15.length-1].c - c15[0].c) / c15[0].c * 100;
  console.log(`  TOTAL  ${totalRet >= 0 ? "+" : ""}${totalRet.toFixed(1)}%`);
})();
