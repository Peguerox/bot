// Same live config (BCHFDUSD, window=5, TP=0.8%/SL=0.3%, no timeout, 1-min HL execution), 1yr,
// but logs the win/loss sequence to analyze streaks.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const ALLOCATION_USD = 50;
const ZSCORE_WINDOW = 5;
const Z_ENTRY = -2.0;
const TP_PCT = 0.8;
const SL_PCT = 0.3;
const CANDLE_MS = 5 * 60 * 1000;
const MIN_MS = 60 * 1000;

type C5 = { t: number; c: number };
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
    await sleep(70);
  }
  return out;
}

function runSim(candles5: C5[], candles1: C1[], windowStartMs: number) {
  const prices = candles5.map(c => c.c);
  const zscores: number[] = new Array(candles5.length).fill(NaN);
  for (let i = ZSCORE_WINDOW; i < candles5.length; i++) {
    const window = prices.slice(i - ZSCORE_WINDOW, i);
    const mean = window.reduce((s, v) => s + v, 0) / window.length;
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
    const std = Math.sqrt(variance);
    zscores[i] = std > 0 ? (prices[i] - mean) / std : 0;
  }

  let usd = ALLOCATION_USD, qty = 0;
  const sequence: string[] = []; // "W" or "L" per trade

  let startIdx = candles5.findIndex(c => c.t >= windowStartMs);
  startIdx = Math.max(startIdx, ZSCORE_WINDOW);

  let m1Idx = 0;
  let i = startIdx;
  while (i < candles5.length) {
    const candleCloseTime = candles5[i].t + CANDLE_MS;
    const closePrice = prices[i];

    if (zscores[i] <= Z_ENTRY) {
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
        usd = qty * lastPrice; qty = 0; break;
      }

      usd = qty * exitPrice;
      sequence.push(reason === "TP" ? "W" : "L");
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

  // streak analysis
  let curWinStreak = 0, maxWinStreak = 0, curLossStreak = 0, maxLossStreak = 0;
  const winStreakCounts: Record<number, number> = {};
  const lossStreakCounts: Record<number, number> = {};
  for (let k = 0; k < sequence.length; k++) {
    if (sequence[k] === "W") {
      curWinStreak++;
      if (curLossStreak > 0) { lossStreakCounts[curLossStreak] = (lossStreakCounts[curLossStreak]||0)+1; curLossStreak = 0; }
      if (curWinStreak > maxWinStreak) maxWinStreak = curWinStreak;
    } else {
      curLossStreak++;
      if (curWinStreak > 0) { winStreakCounts[curWinStreak] = (winStreakCounts[curWinStreak]||0)+1; curWinStreak = 0; }
      if (curLossStreak > maxLossStreak) maxLossStreak = curLossStreak;
    }
  }
  if (curWinStreak > 0) winStreakCounts[curWinStreak] = (winStreakCounts[curWinStreak]||0)+1;
  if (curLossStreak > 0) lossStreakCounts[curLossStreak] = (lossStreakCounts[curLossStreak]||0)+1;

  return { sequence, maxWinStreak, maxLossStreak, winStreakCounts, lossStreakCounts };
}

(async () => {
  const now = Date.now();
  const windowStart = now - 30 * 24 * 60 * 60 * 1000; // 1mo
  const candleFetchStart = windowStart - (ZSCORE_WINDOW + 5) * CANDLE_MS;

  const symbol = "BCHFDUSD";
  process.stdout.write(`Fetching ${symbol} 5m... `);
  const raw5 = await fetchKlines(symbol, "5m", candleFetchStart, now);
  const c5: C5[] = raw5.map(c => ({ t: +c[0], c: +c[4] }));
  console.log(`${c5.length}`);
  process.stdout.write(`Fetching ${symbol} 1m (1mo)... `);
  const raw1 = await fetchKlines(symbol, "1m", windowStart, now);
  const c1: C1[] = raw1.map(c => ({ t: +c[0], h: +c[2], l: +c[3], c: +c[4] }));
  console.log(`${c1.length}`);

  const r = runSim(c5, c1, windowStart);
  console.log(`\nBCHFDUSD window=5 TP=0.8/SL=0.3 · 1mo · streak analysis (${r.sequence.length} trades)\n`);
  console.log(`Longest win streak:  ${r.maxWinStreak}`);
  console.log(`Longest loss streak: ${r.maxLossStreak}`);
  console.log(`\nWin streak length -> count of times it happened:`);
  for (const len of Object.keys(r.winStreakCounts).map(Number).sort((a,b)=>a-b)) {
    console.log(`  ${len} in a row: ${r.winStreakCounts[len]} times`);
  }
  console.log(`\nLoss streak length -> count of times it happened:`);
  for (const len of Object.keys(r.lossStreakCounts).map(Number).sort((a,b)=>a-b)) {
    console.log(`  ${len} in a row: ${r.lossStreakCounts[len]} times`);
  }
})();
