// Combined correlation + MAE audit for SOLUSDT, mirroring the SOLBTC investigation.
// Runs the exact live-bot logic continuously over full history, logs entry features per
// trade (RSI, EMA gap, slope, 60d macro trend, depth from 90d high, days since prev trade)
// plus each trade's worst intra-trade drawdown (MAE), then reports Pearson/Spearman
// correlations and a MAE-informed stop-loss check. Read-only, does not touch live bots.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE       = "https://api.binance.us/api/v3";
const RSI_LOW    = 30;
const MA_FAST    = 7;
const MA_SLOW    = 25;

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

function calcRSI(candles: C[], period = 14): number[] {
  const rsi: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].c - candles[i-1].c;
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
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

function highNDaysBefore(c15: C[], idx: number, days: number): number {
  const targetT = c15[idx].t - days * 86_400_000;
  let lo = 0, hi = idx, found = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (c15[mid].t <= targetT) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  let hi90 = -Infinity;
  for (let j = found; j <= idx; j++) if (c15[j].c > hi90) hi90 = c15[j].c;
  return hi90;
}

type Trade = {
  entryTime: string; exitTime: string; pnlPct: number; maeePct: number;
  entryRsi: number; emaGapPct: number; slopeStrength: number;
  macroTrend60d: number; daysSincePrevClose: number; depthFromHigh90d: number;
};

function runSim(c15: C[], c12h: C[]): Trade[] {
  const rsi = calcRSI(c15);
  const f12 = calcEMA(c12h, MA_FAST);
  const s12 = calcEMA(c12h, MA_SLOW);

  const trend12h: { t: number; fast: number; prevFast: number; slow: number; close: number }[] = c12h.map((c, i) => ({
    t: c.t, fast: f12[i], prevFast: i > 0 ? f12[i-1] : NaN, slow: s12[i], close: c.c,
  }));

  function getTrend(t: number, livePrice: number) {
    let idx = -1;
    for (let i = trend12h.length - 1; i >= 0; i--) { if (trend12h[i].t <= t) { idx = i; break; } }
    if (idx < 0) return { bullish: false, sloping: false, gapPct: NaN, slopeStrength: NaN };
    const { fast, prevFast, slow, close } = trend12h[idx];
    if (isNaN(fast) || isNaN(slow)) return { bullish: false, sloping: false, gapPct: NaN, slopeStrength: NaN };
    const delta = livePrice - close;
    const liveFast = fast + delta / MA_FAST;
    const liveSlow = slow + delta / MA_SLOW;
    return {
      bullish: liveFast > liveSlow,
      sloping: !isNaN(prevFast) && liveFast > prevFast,
      gapPct: (liveFast - liveSlow) / liveSlow * 100,
      slopeStrength: !isNaN(prevFast) ? (liveFast - prevFast) / prevFast * 100 : NaN,
    };
  }

  let mode: "USDT" | "SOL" = "USDT";
  let armedForSol = false;
  let entryIdx = 0, entryRsi = 0, entryGapPct = 0, entrySlope = 0, worstPct = 0;
  let lastCloseTime = 0;
  const trades: Trade[] = [];

  for (let i = 1; i < c15.length; i++) {
    if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
    const price = c15[i].c;
    const t     = c15[i].t;

    if (rsi[i-1] < RSI_LOW && rsi[i] >= RSI_LOW && mode === "USDT" && !armedForSol) armedForSol = true;

    const { bullish, sloping, gapPct, slopeStrength } = getTrend(t, price);

    if (mode === "USDT" && armedForSol && bullish && sloping) {
      entryIdx = i; entryRsi = rsi[i]; entryGapPct = gapPct; entrySlope = slopeStrength; worstPct = 0;
      mode = "SOL"; armedForSol = false;
    }

    if (mode === "SOL") {
      const entryPrice = c15[entryIdx].c;
      const curPct = (price - entryPrice) / entryPrice * 100;
      if (curPct < worstPct) worstPct = curPct;
    }

    if (mode === "SOL" && !bullish && rsi[i] < 50) {
      const entryPrice = c15[entryIdx].c;
      const pnlPct = (price - entryPrice) / entryPrice * 100;
      const macro = priceNDaysBefore(c15, entryIdx, 60);
      const macroTrend60d = macro !== null ? (entryPrice - macro) / macro * 100 : NaN;
      const high90 = highNDaysBefore(c15, entryIdx, 90);
      const depthFromHigh90d = (entryPrice - high90) / high90 * 100;
      const daysSincePrevClose = lastCloseTime > 0 ? (c15[entryIdx].t - lastCloseTime) / 86_400_000 : NaN;
      trades.push({
        entryTime: new Date(c15[entryIdx].t).toISOString().slice(0,10),
        exitTime:  new Date(t).toISOString().slice(0,10),
        pnlPct, maeePct: worstPct, entryRsi, emaGapPct: entryGapPct, slopeStrength: entrySlope,
        macroTrend60d, daysSincePrevClose, depthFromHigh90d,
      });
      lastCloseTime = t;
      mode = "USDT";
    }
  }
  return trades;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a,b)=>a+b,0)/n, my = ys.reduce((a,b)=>a+b,0)/n;
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
function spearman(xs: number[], ys: number[]): number { return pearson(rank(xs), rank(ys)); }
function median(xs: number[]): number {
  const s = [...xs].sort((a,b)=>a-b);
  const mid = Math.floor(s.length/2);
  return s.length % 2 ? s[mid] : (s[mid-1]+s[mid])/2;
}

(async () => {
  const now   = Date.now();
  const start = now - 5 * 365 * 24 * 60 * 60 * 1000;
  const dLabel = `${new Date(start).toISOString().slice(0,10)} – ${new Date(now).toISOString().slice(0,10)}`;

  process.stdout.write(`Fetching SOLUSDT 15m (${dLabel})... `);
  const c15 = await fetchKlines("SOLUSDT", "15m", start, now);
  console.log(`${c15.length} candles`);

  process.stdout.write(`Fetching SOLUSDT 12h (${dLabel})... `);
  const c12h = await fetchKlines("SOLUSDT", "12h", start, now);
  console.log(`${c12h.length} candles`);

  const allTrades = runSim(c15, c12h);
  const trades = allTrades.filter(t => !isNaN(t.macroTrend60d));
  console.log(`\n${trades.length} trades with complete feature data\n`);

  const pnl = trades.map(t => t.pnlPct);
  const features: [string, number[]][] = [
    ["entryRSI",        trades.map(t => t.entryRsi)],
    ["emaGapPct",       trades.map(t => t.emaGapPct)],
    ["slopeStrength",   trades.map(t => t.slopeStrength)],
    ["macroTrend60d",   trades.map(t => t.macroTrend60d)],
    ["daysSincePrev",   trades.map(t => isNaN(t.daysSincePrevClose) ? 0 : t.daysSincePrevClose)],
    ["depthFromHigh90d",trades.map(t => t.depthFromHigh90d)],
  ];

  console.log(`${"feature".padEnd(18)}${"pearson r".padStart(12)}${"spearman ρ".padStart(12)}   medianWin   medianLoss`);
  console.log("─".repeat(80));
  const winners = trades.filter(t => t.pnlPct >= 0);
  const losers  = trades.filter(t => t.pnlPct < 0);
  for (const [name, vals] of features) {
    const pr = pearson(vals, pnl);
    const sr = spearman(vals, pnl);
    const wVals = winners.map((_,i)=>vals[trades.indexOf(winners[i])]);
    const lVals = losers.map((_,i)=>vals[trades.indexOf(losers[i])]);
    console.log(`${name.padEnd(18)}${pr.toFixed(3).padStart(12)}${sr.toFixed(3).padStart(12)}   ${median(wVals).toFixed(2).padStart(9)}   ${median(lVals).toFixed(2).padStart(9)}`);
  }
  console.log(`\nn winners=${winners.length}  n losers=${losers.length}`);

  // MAE / stop-loss check
  const worstDDAmongWinners = Math.min(...winners.map(t => t.maeePct));
  console.log(`\nWorst mid-trade drawdown ever seen among WINNING trades: ${worstDDAmongWinners.toFixed(1)}%`);
  for (const stopPct of [-3, -5, -8, -10, -15]) {
    const wouldStopOutWinners = winners.filter(t => t.maeePct <= stopPct).length;
    const affected = losers.filter(t => t.maeePct <= stopPct);
    const avgActual = affected.length ? affected.reduce((a,t)=>a + t.pnlPct, 0) / affected.length : NaN;
    console.log(`Stop at ${stopPct}%: would cut ${wouldStopOutWinners} winners early, would affect ${affected.length} losers (their avg actual final pnl was ${avgActual.toFixed(1)}%)`);
  }

  const sorted = [...trades].sort((a,b) => b.pnlPct - a.pnlPct);
  console.log(`\nTop 10 winners:`);
  console.log(`${"entry".padEnd(12)}${"pnl%".padStart(8)}${"MAE%".padStart(8)}${"depthFromHigh90d".padStart(20)}`);
  for (const t of sorted.slice(0, 10)) {
    console.log(`${t.entryTime.padEnd(12)}${(t.pnlPct>=0?"+":"")+t.pnlPct.toFixed(1).padStart(6)}%${t.maeePct.toFixed(1).padStart(7)}%${t.depthFromHigh90d.toFixed(1).padStart(19)}%`);
  }
})();
