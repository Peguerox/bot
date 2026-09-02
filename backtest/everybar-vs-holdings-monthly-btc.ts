// Every-Bar (no filter, 1-min entries, TP=1.0%/SL=0.1%, 1-min HL execution, conservative
// tie-break) vs simple buy-and-hold SOL, broken down by calendar month. SOLFDUSD, Binance
// Global, 1yr — shows whether the strategy's losing months still beat what holding would
// have done over that same month.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const ALLOCATION_USD = 50;
const TP_PCT = 1.0;
const SL_PCT = 0.1;
const MIN_MS = 60 * 1000;
const SYMBOL = "BTCFDUSD";

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

function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function runSim(c1: C1[], windowStartMs: number) {
  let usd = ALLOCATION_USD, qty = 0;
  let tradesCount = 0, wins = 0;
  const monthStart: Record<string, number> = {};
  const monthEnd: Record<string, number> = {};
  const holdMonthFirstPrice: Record<string, number> = {};
  const holdMonthLastPrice: Record<string, number> = {};

  let startIdx = c1.findIndex(c => c.t >= windowStartMs);
  if (startIdx < 0) startIdx = 0;

  let i = startIdx;
  while (i < c1.length) {
    const price = c1[i].c;
    const mKey = monthKey(c1[i].t);
    const eq = usd + qty * price; // qty always 0 here (flat between entries), but keep general
    if (!(mKey in monthStart)) monthStart[mKey] = eq;
    monthEnd[mKey] = eq;
    if (!(mKey in holdMonthFirstPrice)) holdMonthFirstPrice[mKey] = price;
    holdMonthLastPrice[mKey] = price;

    const entryPrice = price;
    const entryTime = c1[i].t + MIN_MS;
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
      usd = qty * lastPrice; qty = 0;
      const finalKey = monthKey(c1[c1.length - 1].t);
      monthEnd[finalKey] = usd;
      break;
    }

    usd = qty * exitPrice;
    tradesCount++; if (usd > qty * entryPrice) wins++;
    qty = 0;

    i = j + 1;
  }

  const months = Object.keys(monthStart).sort();
  const rows = months.map(m => {
    const stratRet = monthStart[m] > 0 ? (monthEnd[m] - monthStart[m]) / monthStart[m] * 100 : 0;
    const holdRet = holdMonthFirstPrice[m] > 0 ? (holdMonthLastPrice[m] - holdMonthFirstPrice[m]) / holdMonthFirstPrice[m] * 100 : 0;
    return { month: m, stratRet, holdRet, beatHold: stratRet > holdRet };
  });

  return { rows, trades: tradesCount, wins };
}

(async () => {
  const now = Date.now();
  const windowStart = now - 365 * 24 * 60 * 60 * 1000; // 1yr
  const fetchStart = windowStart - 10 * MIN_MS;

  process.stdout.write(`Fetching ${SYMBOL} 1m (1yr, will take a while)... `);
  const raw1 = await fetchKlines(SYMBOL, "1m", fetchStart, now);
  const c1: C1[] = raw1.map(c => ({ t: +c[0], h: +c[2], l: +c[3], c: +c[4] }));
  console.log(`${c1.length}`);

  const { rows, trades, wins } = runSim(c1, windowStart);

  console.log(`\n${SYMBOL} Every-Bar (no filter) vs Buy-and-Hold · 1-min entries · TP=${TP_PCT}%/SL=${SL_PCT}% · monthly\n`);
  console.log(`Month      Strategy      Hold SOL     Strategy beat hold?`);
  let losingMonthsCount = 0, losingMonthsBeatHold = 0;
  for (const r of rows) {
    const flag = r.beatHold ? "YES" : "no";
    console.log(`${r.month}   ${(r.stratRet>=0?"+":"")+r.stratRet.toFixed(1)}%`.padEnd(24) + `${(r.holdRet>=0?"+":"")+r.holdRet.toFixed(1)}%`.padEnd(13) + flag);
    if (r.stratRet < 0) {
      losingMonthsCount++;
      if (r.beatHold) losingMonthsBeatHold++;
    }
  }
  console.log(`\nTotal trades: ${trades}, win rate: ${(wins/trades*100).toFixed(1)}%`);
  console.log(`Losing months for strategy: ${losingMonthsCount}, of those beat buy-and-hold: ${losingMonthsBeatHold}`);
})();
