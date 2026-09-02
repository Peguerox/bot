// Pattern audit on the SOLBTC arm@6%/trail@7.5pp config (most wins in the sweep) — logs
// every trade with entry features + exit reason, to look for what distinguishes losers.
// Read-only, does not touch live bots.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE       = "https://api.binance.us/api/v3";
const LOOKBACK   = 365 * 24 * 60 * 60 * 1000;
const RSI_LOW    = 30;
const RSI_HIGH   = 70;
const MA_FAST    = 7;
const MA_SLOW    = 25;
const TRAIL_ARM_PCT = 6;
const TRAIL_PP      = 7.5;

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
function calcRSI(candles: C[], period = 14): number[] {
  const rsi: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) { const d = candles[i].c - candles[i-1].c; if (d > 0) avgGain += d; else avgLoss += Math.abs(d); }
  avgGain /= period; avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].c - candles[i-1].c;
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}
function calcEMA(candles: C[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = new Array(candles.length).fill(NaN);
  out[period - 1] = candles.slice(0, period).reduce((a, c) => a + c.c, 0) / period;
  for (let i = period; i < candles.length; i++) out[i] = candles[i].c * k + out[i-1] * (1 - k);
  return out;
}
function priceNDaysBefore(c15: C[], idx: number, days: number): number | null {
  const targetT = c15[idx].t - days * 86_400_000;
  let lo = 0, hi = idx, found = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (c15[mid].t <= targetT) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  return found >= 0 ? c15[found].c : null;
}

type Trade = {
  entryTime: string; exitTime: string; pnlPct: number; exitReason: string;
  entryRsi: number; emaGapPct: number; macroTrend60d: number; month: number;
};

function runSim(c15: C[], c12h: C[]): Trade[] {
  const rsi = calcRSI(c15);
  const f12 = calcEMA(c12h, MA_FAST);
  const s12 = calcEMA(c12h, MA_SLOW);
  const trend12h = c12h.map((c, i) => ({ t: c.t, fast: f12[i], prevFast: i > 0 ? f12[i-1] : NaN, slow: s12[i], close: c.c }));

  function getTrend(t: number, livePrice: number) {
    let idx = -1;
    for (let i = trend12h.length - 1; i >= 0; i--) { if (trend12h[i].t <= t) { idx = i; break; } }
    if (idx < 0) return { bullish: false, sloping: false, gapPct: NaN };
    const { fast, prevFast, slow, close } = trend12h[idx];
    if (isNaN(fast) || isNaN(slow)) return { bullish: false, sloping: false, gapPct: NaN };
    const delta = livePrice - close;
    const liveFast = fast + delta / MA_FAST;
    const liveSlow = slow + delta / MA_SLOW;
    return { bullish: liveFast > liveSlow, sloping: !isNaN(prevFast) && liveFast > prevFast, gapPct: (liveFast-liveSlow)/liveSlow*100 };
  }

  let mode: "BTC" | "SOL" = "BTC";
  let armedForSol = false, armedForBtc = false;
  let entryIdx = 0, entryRsi = 0, entryGapPct = 0, bestPct = 0;
  const trades: Trade[] = [];

  for (let i = 1; i < c15.length; i++) {
    if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
    const price = c15[i].c, t = c15[i].t;

    if (rsi[i-1] < RSI_LOW && rsi[i] >= RSI_LOW && mode === "BTC" && !armedForSol) armedForSol = true;
    if (rsi[i-1] > RSI_HIGH && rsi[i] <= RSI_HIGH && mode === "SOL" && !armedForBtc) armedForBtc = true;

    const { bullish, sloping, gapPct } = getTrend(t, price);

    if (mode === "BTC" && armedForSol && bullish && sloping) {
      entryIdx = i; entryRsi = rsi[i]; entryGapPct = gapPct; bestPct = 0;
      mode = "SOL"; armedForSol = false;
    }

    let closeNow = false, reason = "";
    if (mode === "SOL") {
      const entryPrice = c15[entryIdx].c;
      const curPct = (price - entryPrice) / entryPrice * 100;
      if (curPct > bestPct) bestPct = curPct;
      if (bestPct >= TRAIL_ARM_PCT && (bestPct - curPct) >= TRAIL_PP) { closeNow = true; reason = "trail"; }
      else if (armedForBtc && !bullish) { closeNow = true; reason = "trend"; }
    }

    if (closeNow) {
      const entryPrice = c15[entryIdx].c;
      const pnlPct = (price - entryPrice) / entryPrice * 100;
      const macro = priceNDaysBefore(c15, entryIdx, 60);
      const macroTrend60d = macro !== null ? (entryPrice - macro) / macro * 100 : NaN;
      trades.push({
        entryTime: new Date(c15[entryIdx].t).toISOString().slice(0,10),
        exitTime:  new Date(t).toISOString().slice(0,10),
        pnlPct, exitReason: reason, entryRsi, emaGapPct: entryGapPct, macroTrend60d,
        month: new Date(c15[entryIdx].t).getUTCMonth() + 1,
      });
      mode = "BTC"; armedForBtc = false;
    }
  }
  return trades;
}

(async () => {
  const now = Date.now(), start = now - 5 * LOOKBACK;
  process.stdout.write(`Fetching SOLBTC 15m... `); const c15 = await fetchKlines("SOLBTC", "15m", start, now); console.log(`${c15.length}`);
  process.stdout.write(`Fetching SOLBTC 12h... `); const c12h = await fetchKlines("SOLBTC", "12h", start, now); console.log(`${c12h.length}`);

  const trades = runSim(c15, c12h);
  const losers = trades.filter(t => t.pnlPct < 0);
  const winners = trades.filter(t => t.pnlPct >= 0);

  console.log(`\nTotal trades: ${trades.length}  |  Winners: ${winners.length}  |  Losers: ${losers.length}`);

  const exitCounts: Record<string, {n:number, losers:number}> = {};
  for (const t of trades) {
    exitCounts[t.exitReason] ??= {n:0, losers:0};
    exitCounts[t.exitReason].n++;
    if (t.pnlPct < 0) exitCounts[t.exitReason].losers++;
  }
  console.log(`\nBy exit reason:`);
  for (const [reason, {n, losers: l}] of Object.entries(exitCounts)) {
    console.log(`  ${reason}: ${n} trades, ${l} losers (${(l/n*100).toFixed(0)}% loss rate)`);
  }

  console.log(`\nWorst 15 losing trades:`);
  const sortedLosers = [...losers].sort((a,b) => a.pnlPct - b.pnlPct);
  console.log(`${"entry".padEnd(12)}${"exit".padEnd(12)}${"pnl%".padStart(8)}${"exitR".padStart(8)}${"RSI".padStart(7)}${"gap%".padStart(7)}${"macro60d".padStart(10)}${"month".padStart(7)}`);
  for (const t of sortedLosers.slice(0, 15)) {
    console.log(`${t.entryTime.padEnd(12)}${t.exitTime.padEnd(12)}${t.pnlPct.toFixed(1).padStart(7)}%${t.exitReason.padStart(8)}${t.entryRsi.toFixed(1).padStart(7)}${t.emaGapPct.toFixed(2).padStart(7)}${t.macroTrend60d.toFixed(1).padStart(9)}%${String(t.month).padStart(7)}`);
  }

  // month distribution of losers vs winners
  const monthLoss: Record<number, number> = {}, monthWin: Record<number, number> = {};
  for (const t of losers) monthLoss[t.month] = (monthLoss[t.month]||0)+1;
  for (const t of winners) monthWin[t.month] = (monthWin[t.month]||0)+1;
  console.log(`\nLosses by entry month (1-12):`);
  for (let m = 1; m <= 12; m++) console.log(`  month ${m}: ${monthLoss[m]||0} losers, ${monthWin[m]||0} winners`);

  const avgMacroLoser = losers.filter(t=>!isNaN(t.macroTrend60d)).reduce((a,t)=>a+t.macroTrend60d,0) / losers.filter(t=>!isNaN(t.macroTrend60d)).length;
  const avgMacroWinner = winners.filter(t=>!isNaN(t.macroTrend60d)).reduce((a,t)=>a+t.macroTrend60d,0) / winners.filter(t=>!isNaN(t.macroTrend60d)).length;
  console.log(`\nAvg 60d macro trend at entry: losers=${avgMacroLoser.toFixed(1)}%  winners=${avgMacroWinner.toFixed(1)}%`);

  // ── EMA gap magnitude check — worst losers showed unusually HIGH gap at entry ──
  function pearson(xs: number[], ys: number[]): number {
    const n = xs.length; const mx = xs.reduce((a,b)=>a+b,0)/n, my = ys.reduce((a,b)=>a+b,0)/n;
    let num=0, dx2=0, dy2=0;
    for (let i=0;i<n;i++){ const dx=xs[i]-mx, dy=ys[i]-my; num+=dx*dy; dx2+=dx*dx; dy2+=dy*dy; }
    return num / Math.sqrt(dx2*dy2);
  }
  function rank(xs: number[]): number[] {
    const idx = xs.map((v,i)=>[v,i] as [number,number]).sort((a,b)=>a[0]-b[0]);
    const r = new Array(xs.length).fill(0);
    idx.forEach(([_,i], pos) => r[i] = pos+1);
    return r;
  }
  const validTrades = trades.filter(t => !isNaN(t.emaGapPct));
  const gapVals = validTrades.map(t => t.emaGapPct);
  const pnlVals = validTrades.map(t => t.pnlPct);
  const pr = pearson(gapVals, pnlVals);
  const sr = pearson(rank(gapVals), rank(pnlVals));
  console.log(`\nEMA gap% vs pnl%: pearson r=${pr.toFixed(3)}  spearman ρ=${sr.toFixed(3)}  (n=${validTrades.length})`);

  const sortedByGap = [...validTrades].sort((a,b) => b.emaGapPct - a.emaGapPct);
  console.log(`\nTop 15 trades by EMA gap magnitude (strongest apparent trend confirmation) — outcome?`);
  console.log(`${"entry".padEnd(12)}${"gap%".padStart(8)}${"pnl%".padStart(8)}${"exitReason".padStart(12)}`);
  for (const t of sortedByGap.slice(0, 15)) {
    console.log(`${t.entryTime.padEnd(12)}${t.emaGapPct.toFixed(2).padStart(7)}%${t.pnlPct.toFixed(1).padStart(7)}%${t.exitReason.padStart(12)}`);
  }

  const gapMedianLoser = (() => { const s=[...losers.filter(t=>!isNaN(t.emaGapPct)).map(t=>t.emaGapPct)].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; })();
  const gapMedianWinner = (() => { const s=[...winners.filter(t=>!isNaN(t.emaGapPct)).map(t=>t.emaGapPct)].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; })();
  console.log(`\nMedian EMA gap%: losers=${gapMedianLoser.toFixed(2)}%  winners=${gapMedianWinner.toFixed(2)}%`);

  const bigLosers = losers.filter(t => t.pnlPct < -5);
  const gapMedianBigLoser = (() => { const s=[...bigLosers.filter(t=>!isNaN(t.emaGapPct)).map(t=>t.emaGapPct)].sort((a,b)=>a-b); return s.length ? s[Math.floor(s.length/2)] : NaN; })();
  console.log(`Median EMA gap% for BIG losers (pnl < -5%, n=${bigLosers.length}): ${gapMedianBigLoser.toFixed(2)}%`);
})();
