// Max Adverse Excursion (MAE) audit — for every trade under the slope-filter baseline,
// tracks the worst intra-trade drawdown from entry price before the position was closed.
// This tells us whether the big winning trades had scary dips mid-hold (which would mean
// a stop-loss risks knocking us out of them before they run) or whether they ran mostly
// clean (which would mean a stop-loss is safe to add on top).
// Read-only, does not touch live bots.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE       = "https://api.binance.us/api/v3";
const LOOKBACK   = 365 * 24 * 60 * 60 * 1000;
const RSI_LOW    = 30;
const RSI_HIGH   = 70;
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

type Trade = { entryTime: string; exitTime: string; pnlPct: number; maeePct: number; barsToRecover: number };

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
    if (idx < 0) return { bullish: false, sloping: false };
    const { fast, prevFast, slow, close } = trend12h[idx];
    if (isNaN(fast) || isNaN(slow)) return { bullish: false, sloping: false };
    const delta = livePrice - close;
    const liveFast = fast + delta / MA_FAST;
    const liveSlow = slow + delta / MA_SLOW;
    return { bullish: liveFast > liveSlow, sloping: !isNaN(prevFast) && liveFast > prevFast };
  }

  let mode: "BTC" | "SOL" = "BTC";
  let armedForSol = false, armedForBtc = false;
  let entryIdx = 0, worstPct = 0, worstBarIdx = 0;
  const trades: Trade[] = [];

  for (let i = 1; i < c15.length; i++) {
    if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
    const price = c15[i].c;
    const t     = c15[i].t;

    if (rsi[i-1] < RSI_LOW && rsi[i] >= RSI_LOW && mode === "BTC" && !armedForSol) armedForSol = true;
    if (rsi[i-1] > RSI_HIGH && rsi[i] <= RSI_HIGH && mode === "SOL" && !armedForBtc) armedForBtc = true;

    const { bullish, sloping } = getTrend(t, price);

    if (mode === "BTC" && armedForSol && bullish && sloping) {
      entryIdx = i; worstPct = 0; worstBarIdx = i;
      mode = "SOL"; armedForSol = false;
    }

    if (mode === "SOL") {
      const entryPrice = c15[entryIdx].c;
      const curPct = (price - entryPrice) / entryPrice * 100;
      if (curPct < worstPct) { worstPct = curPct; worstBarIdx = i; }
    }

    if (mode === "SOL" && armedForBtc && !bullish) {
      const entryPrice = c15[entryIdx].c;
      const pnlPct = (price - entryPrice) / entryPrice * 100;
      trades.push({
        entryTime: new Date(c15[entryIdx].t).toISOString().slice(0,10),
        exitTime:  new Date(t).toISOString().slice(0,10),
        pnlPct, maeePct: worstPct,
        barsToRecover: worstBarIdx - entryIdx,
      });
      mode = "BTC"; armedForBtc = false;
    }
  }
  return trades;
}

(async () => {
  const now   = Date.now();
  const start = now - 5 * LOOKBACK;
  const dLabel = `${new Date(start).toISOString().slice(0,10)} – ${new Date(now).toISOString().slice(0,10)}`;

  process.stdout.write(`Fetching SOLBTC 15m (${dLabel})... `);
  const c15 = await fetchKlines("SOLBTC", "15m", start, now);
  console.log(`${c15.length} candles`);

  process.stdout.write(`Fetching SOLBTC 12h (${dLabel})... `);
  const c12h = await fetchKlines("SOLBTC", "12h", start, now);
  console.log(`${c12h.length} candles`);

  const trades = runSim(c15, c12h);
  const sorted = [...trades].sort((a,b) => b.pnlPct - a.pnlPct);

  console.log(`\nTop 10 winners — did they dip hard before running?`);
  console.log(`${"entry".padEnd(12)}${"exit".padEnd(12)}${"pnl%".padStart(8)}${"worstDrawdown%".padStart(16)}`);
  for (const t of sorted.slice(0, 10)) {
    console.log(`${t.entryTime.padEnd(12)}${t.exitTime.padEnd(12)}${(t.pnlPct>=0?"+":"")+t.pnlPct.toFixed(1).padStart(6)}%${t.maeePct.toFixed(1).padStart(15)}%`);
  }

  console.log(`\nBottom 10 losers — how deep did they go before we exited?`);
  console.log(`${"entry".padEnd(12)}${"exit".padEnd(12)}${"pnl%".padStart(8)}${"worstDrawdown%".padStart(16)}`);
  for (const t of sorted.slice(-10)) {
    console.log(`${t.entryTime.padEnd(12)}${t.exitTime.padEnd(12)}${(t.pnlPct>=0?"+":"")+t.pnlPct.toFixed(1).padStart(6)}%${t.maeePct.toFixed(1).padStart(15)}%`);
  }

  // distribution: for winners, what was the worst drawdown ever seen mid-trade?
  const winners = trades.filter(t => t.pnlPct > 0);
  const worstDDAmongWinners = Math.min(...winners.map(t => t.maeePct));
  console.log(`\nWorst mid-trade drawdown ever seen among WINNING trades: ${worstDDAmongWinners.toFixed(1)}%`);
  console.log(`(any stop-loss tighter than this would have killed at least one winner)`);

  // how many losers bottomed out beyond various stop levels before eventually exiting (would a stop have saved money?)
  for (const stopPct of [-3, -5, -8, -10, -15]) {
    const wouldStopOutWinners = winners.filter(t => t.maeePct <= stopPct).length;
    const losers = trades.filter(t => t.pnlPct <= 0);
    const losersWorseThanStop = losers.filter(t => t.maeePct <= stopPct);
    const avgActualLossIfStopped = losersWorseThanStop.length
      ? losersWorseThanStop.reduce((a,t)=>a + t.pnlPct, 0) / losersWorseThanStop.length : NaN;
    console.log(`Stop at ${stopPct}%: would cut ${wouldStopOutWinners} winners early, would have capped ${losersWorseThanStop.length} losers (their avg final pnl was ${avgActualLossIfStopped.toFixed(1)}%)`);
  }
})();
