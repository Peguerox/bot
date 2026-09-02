// VWAP-armed scalp (price < rolling VWAP(20) on 5m, TP=0.5%/SL=0.1%, 1-min HL execution,
// conservative tie-break) vs simple buy-and-hold, broken down by calendar month. Symbol
// passed as CLI arg. Binance Global, 1yr.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const ALLOCATION_USD = 50;
const TP_PCT = 0.5;
const SL_PCT = 0.1;
const PERIOD = 20;
const CANDLE_MS = 5 * 60 * 1000;
const MIN_MS = 60 * 1000;
const SYMBOL = process.argv[2] ?? "SOLFDUSD";

type C5 = { t: number; c: number; v: number };
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

function calcRollingVWAP(candles: C5[], period: number): number[] {
  const out: number[] = new Array(candles.length).fill(NaN);
  for (let i = period - 1; i < candles.length; i++) {
    let pv = 0, vol = 0;
    for (let k = i - period + 1; k <= i; k++) { pv += candles[k].c * candles[k].v; vol += candles[k].v; }
    out[i] = vol > 0 ? pv / vol : NaN;
  }
  return out;
}

function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function runSim(candles5: C5[], candles1: C1[], windowStartMs: number) {
  const vwap = calcRollingVWAP(candles5, PERIOD);
  let usd = ALLOCATION_USD, qty = 0;
  let tradesCount = 0, wins = 0;
  let m1Idx = 0;
  const monthStart: Record<string, number> = {};
  const monthEnd: Record<string, number> = {};
  const holdFirst: Record<string, number> = {};
  const holdLast: Record<string, number> = {};

  let startIdx = candles5.findIndex(c => c.t >= windowStartMs);
  startIdx = Math.max(startIdx, PERIOD);

  let i = startIdx;
  while (i < candles5.length) {
    const candleCloseTime = candles5[i].t + CANDLE_MS;
    const closePrice = candles5[i].c;
    const mKey = monthKey(candles5[i].t);
    const eq = usd + qty * closePrice; // qty always 0 here between entries
    if (!(mKey in monthStart)) monthStart[mKey] = eq;
    monthEnd[mKey] = eq;
    if (!(mKey in holdFirst)) holdFirst[mKey] = closePrice;
    holdLast[mKey] = closePrice;

    const favorable = !isNaN(vwap[i]) && closePrice < vwap[i];

    if (favorable) {
      const entryPrice = closePrice;
      const entryTime = candleCloseTime;
      const tp = entryPrice * (1 + TP_PCT / 100);
      const sl = entryPrice * (1 - SL_PCT / 100);
      qty = usd / entryPrice; usd = 0;

      while (m1Idx < candles1.length && candles1[m1Idx].t + MIN_MS <= entryTime) m1Idx++;

      let j = m1Idx;
      let exitPrice: number | null = null;
      let reason = "";
      while (j < candles1.length) {
        const hitTP = candles1[j].h >= tp;
        const hitSL = candles1[j].l <= sl;
        if (hitTP && hitSL) { exitPrice = sl; reason = "SL"; break; }
        if (hitTP) { exitPrice = tp; reason = "TP"; break; }
        if (hitSL) { exitPrice = sl; reason = "SL"; break; }
        j++;
      }
      if (exitPrice === null) {
        const lastPrice = candles1.length ? candles1[candles1.length - 1].c : entryPrice;
        usd = qty * lastPrice; qty = 0;
        const finalKey = monthKey(candles5[candles5.length - 1].t);
        monthEnd[finalKey] = usd;
        break;
      }

      usd = qty * exitPrice;
      tradesCount++; if (usd > qty * entryPrice) wins++;
      qty = 0;

      m1Idx = j;
      const exitTime = (candles1[j]?.t ?? entryTime) + MIN_MS;
      let nextI = i;
      while (nextI < candles5.length && candles5[nextI].t + CANDLE_MS <= exitTime) nextI++;
      i = Math.max(nextI, i + 1);
      continue;
    }
    i++;
  }

  const months = Object.keys(monthStart).sort();
  const rows = months.map(m => {
    const stratRet = monthStart[m] > 0 ? (monthEnd[m] - monthStart[m]) / monthStart[m] * 100 : 0;
    const holdRet = holdFirst[m] > 0 ? (holdLast[m] - holdFirst[m]) / holdFirst[m] * 100 : 0;
    return { month: m, stratRet, holdRet, beatHold: stratRet > holdRet };
  });

  return { rows, trades: tradesCount, wins };
}

(async () => {
  const now = Date.now();
  const windowStart = now - 365 * 24 * 60 * 60 * 1000; // 1yr
  const candleFetchStart = windowStart - (PERIOD + 5) * CANDLE_MS;

  process.stdout.write(`Fetching ${SYMBOL} 5m... `);
  const raw5 = await fetchKlines(SYMBOL, "5m", candleFetchStart, now);
  const c5: C5[] = raw5.map(c => ({ t: +c[0], c: +c[4], v: +c[5] }));
  console.log(`${c5.length}`);
  process.stdout.write(`Fetching ${SYMBOL} 1m (1yr, will take a while)... `);
  const raw1 = await fetchKlines(SYMBOL, "1m", windowStart, now);
  const c1: C1[] = raw1.map(c => ({ t: +c[0], h: +c[2], l: +c[3], c: +c[4] }));
  console.log(`${c1.length}`);

  const { rows, trades, wins } = runSim(c5, c1, windowStart);

  console.log(`\n${SYMBOL} VWAP-armed vs Buy-and-Hold · TP=${TP_PCT}%/SL=${SL_PCT}% · monthly\n`);
  console.log(`Month      Strategy      Hold         Strategy beat hold?`);
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
