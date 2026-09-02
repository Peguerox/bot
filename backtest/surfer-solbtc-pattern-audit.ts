// Pattern audit — runs the slope-filter SOLBTC strategy as ONE continuous 5-year sim
// (matches the corrected methodology from the last audit) and logs per-trade entry
// diagnostics, to look for what distinguishes big losers from winners:
//   - entry RSI value, EMA gap % (confirmation strength), EMA slope magnitude
//   - 60-day macro trend in SOLBTC leading into entry (buying a bounce within a bigger
//     downtrend vs. buying into a genuine reversal)
//   - days since the previous trade closed (whipsaw clustering)
// Read-only analysis. Does not touch live bots.
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

// nearest c15 close at/just-before time t, walked back N ms, for macro-trend context
function priceNDaysBefore(c15: C[], idx: number, days: number): number | null {
  const targetT = c15[idx].t - days * 86_400_000;
  let lo = 0, hi = idx, found = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (c15[mid].t <= targetT) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  return found >= 0 ? c15[found].c : null;
}

type Trade = {
  entryTime: string; exitTime: string; pnlPct: number;
  entryRsi: number; emaGapPct: number; slopeStrength: number;
  macroTrend60d: number | null; daysSincePrevClose: number;
};

function runSim(c15: C[], c12h: C[]): Trade[] {
  const rsi = calcRSI(c15);
  const f12 = calcEMA(c12h, MA_FAST);
  const s12 = calcEMA(c12h, MA_SLOW);

  const trend12h: { t: number; fast: number; prevFast: number; slow: number; close: number }[] = c12h.map((c, i) => ({
    t: c.t, fast: f12[i], prevFast: i > 0 ? f12[i-1] : NaN, slow: s12[i], close: c.c,
  }));

  function getTrend(t: number, livePrice: number): { bullish: boolean; sloping: boolean; gapPct: number; slopeStrength: number } {
    let idx = -1;
    for (let i = trend12h.length - 1; i >= 0; i--) {
      if (trend12h[i].t <= t) { idx = i; break; }
    }
    if (idx < 0) return { bullish: false, sloping: false, gapPct: NaN, slopeStrength: NaN };
    const { fast, prevFast, slow, close } = trend12h[idx];
    if (isNaN(fast) || isNaN(slow)) return { bullish: false, sloping: false, gapPct: NaN, slopeStrength: NaN };
    const delta = livePrice - close;
    const liveFast = fast + delta / MA_FAST;
    const liveSlow = slow + delta / MA_SLOW;
    const gapPct = (liveFast - liveSlow) / liveSlow * 100;
    const slopeStrength = !isNaN(prevFast) ? (liveFast - prevFast) / prevFast * 100 : NaN;
    return { bullish: liveFast > liveSlow, sloping: !isNaN(prevFast) && liveFast > prevFast, gapPct, slopeStrength };
  }

  let mode: "BTC" | "SOL" = "BTC";
  let armedForSol = false, armedForBtc = false;
  let entryBtc = 0, entryIdx = 0, entryRsi = 0, entryGapPct = 0, entrySlope = 0;
  let lastCloseTime = 0;
  const trades: Trade[] = [];

  for (let i = 1; i < c15.length; i++) {
    if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
    const price = c15[i].c;
    const t     = c15[i].t;

    if (rsi[i-1] < RSI_LOW && rsi[i] >= RSI_LOW && mode === "BTC" && !armedForSol) armedForSol = true;
    if (rsi[i-1] > RSI_HIGH && rsi[i] <= RSI_HIGH && mode === "SOL" && !armedForBtc) armedForBtc = true;

    const { bullish, sloping, gapPct, slopeStrength } = getTrend(t, price);

    if (mode === "BTC" && armedForSol && bullish && sloping) {
      entryBtc = 1; // track in relative units; btc qty doesn't matter for pattern analysis
      entryIdx = i;
      entryRsi = rsi[i];
      entryGapPct = gapPct;
      entrySlope = slopeStrength;
      mode = "SOL";
      armedForSol = false;
    }

    if (mode === "SOL" && armedForBtc && !bullish) {
      const entryPrice = c15[entryIdx].c;
      const pnlPct = (price - entryPrice) / entryPrice * 100;
      const macro = priceNDaysBefore(c15, entryIdx, 60);
      const macroTrend60d = macro !== null ? (entryPrice - macro) / macro * 100 : null;
      const daysSincePrevClose = lastCloseTime > 0 ? (c15[entryIdx].t - lastCloseTime) / 86_400_000 : NaN;
      trades.push({
        entryTime: new Date(c15[entryIdx].t).toISOString().slice(0,16).replace("T"," "),
        exitTime:  new Date(t).toISOString().slice(0,16).replace("T"," "),
        pnlPct, entryRsi, emaGapPct: entryGapPct, slopeStrength: entrySlope,
        macroTrend60d, daysSincePrevClose,
      });
      lastCloseTime = t;
      mode = "BTC";
      armedForBtc = false;
    }
  }
  return trades;
}

function fmt(n: number | null, d = 2): string { return n === null || isNaN(n) ? "n/a" : n.toFixed(d); }

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
  const sorted = [...trades].sort((a, b) => a.pnlPct - b.pnlPct);

  console.log(`\n${"═".repeat(100)}`);
  console.log(` All ${trades.length} trades, worst to best`);
  console.log(`${"═".repeat(100)}`);
  console.log(` entry             exit              pnl%     entryRSI  emaGap%  slope%   macro60d   daysSincePrev`);
  for (const tr of sorted) {
    console.log(` ${tr.entryTime}  ${tr.exitTime}  ${(tr.pnlPct>=0?"+":"")+tr.pnlPct.toFixed(1).padStart(6)}%  ${fmt(tr.entryRsi,1).padStart(6)}   ${fmt(tr.emaGapPct,2).padStart(6)}   ${fmt(tr.slopeStrength,3).padStart(6)}   ${fmt(tr.macroTrend60d,1).padStart(7)}%   ${fmt(tr.daysSincePrevClose,1)}`);
  }

  const losers = sorted.filter(t => t.pnlPct < 0);
  const bigLosers = sorted.filter(t => t.pnlPct < -3);
  const winners = sorted.filter(t => t.pnlPct >= 0);
  const avg = (arr: (number|null)[]) => { const v = arr.filter((x): x is number => x !== null && !isNaN(x)); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : NaN; };

  console.log(`\n${"═".repeat(60)}`);
  console.log(` Summary: winners vs losers vs big losers (pnl < -3%)`);
  console.log(`${"═".repeat(60)}`);
  console.log(` n:              winners=${winners.length}  losers=${losers.length}  bigLosers=${bigLosers.length}`);
  console.log(` avg entryRSI:   winners=${fmt(avg(winners.map(t=>t.entryRsi)),1)}  losers=${fmt(avg(losers.map(t=>t.entryRsi)),1)}  bigLosers=${fmt(avg(bigLosers.map(t=>t.entryRsi)),1)}`);
  console.log(` avg emaGap%:    winners=${fmt(avg(winners.map(t=>t.emaGapPct)),2)}  losers=${fmt(avg(losers.map(t=>t.emaGapPct)),2)}  bigLosers=${fmt(avg(bigLosers.map(t=>t.emaGapPct)),2)}`);
  console.log(` avg slope%:     winners=${fmt(avg(winners.map(t=>t.slopeStrength)),3)}  losers=${fmt(avg(losers.map(t=>t.slopeStrength)),3)}  bigLosers=${fmt(avg(bigLosers.map(t=>t.slopeStrength)),3)}`);
  console.log(` avg macro60d%:  winners=${fmt(avg(winners.map(t=>t.macroTrend60d)),1)}  losers=${fmt(avg(losers.map(t=>t.macroTrend60d)),1)}  bigLosers=${fmt(avg(bigLosers.map(t=>t.macroTrend60d)),1)}`);
  console.log(` avg daysSincePrevClose: winners=${fmt(avg(winners.map(t=>t.daysSincePrevClose)),1)}  losers=${fmt(avg(losers.map(t=>t.daysSincePrevClose)),1)}  bigLosers=${fmt(avg(bigLosers.map(t=>t.daysSincePrevClose)),1)}`);
})();
