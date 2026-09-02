// Compares the 5 most recent actual live SOLUSDT trades (old logic, no stop/trail) against
// what the new logic (-6% hard stop + trail 10pp until +30%, then 6pp) would have produced
// over the same window. Read-only, does not touch live bots.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE       = "https://api.binance.us/api/v3";
const RSI_LOW    = 30;
const MA_FAST    = 7;
const MA_SLOW    = 25;
const HARD_STOP_PCT  = -6;
const TRAIL_ARM_PCT  = 8;
const TRAIL_PP        = 10;
const STEP_THRESH     = 30;
const STEP_TRAIL_PP   = 6;

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

type Trade = { entryTime: string; exitTime: string; entryPrice: number; exitPrice: number; pnlPct: number; exitReason: string };

function runSim(c15: C[], c12h: C[]): Trade[] {
  const rsi = calcRSI(c15);
  const f12 = calcEMA(c12h, MA_FAST);
  const s12 = calcEMA(c12h, MA_SLOW);
  const trend12h = c12h.map((c, i) => ({ t: c.t, fast: f12[i], prevFast: i > 0 ? f12[i-1] : NaN, slow: s12[i], close: c.c }));

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

  let mode: "USDT" | "SOL" = "USDT";
  let armedForSol = false;
  let entryIdx = 0, bestPct = 0;
  const trades: Trade[] = [];

  for (let i = 1; i < c15.length; i++) {
    if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
    const price = c15[i].c, t = c15[i].t;

    if (rsi[i-1] < RSI_LOW && rsi[i] >= RSI_LOW && mode === "USDT" && !armedForSol) armedForSol = true;

    const { bullish, sloping } = getTrend(t, price);

    if (mode === "USDT" && armedForSol && bullish && sloping) {
      entryIdx = i; bestPct = 0;
      mode = "SOL"; armedForSol = false;
    }

    let closeNow = false, reason = "";
    if (mode === "SOL") {
      const entryPrice = c15[entryIdx].c;
      const curPct = (price - entryPrice) / entryPrice * 100;
      if (curPct > bestPct) bestPct = curPct;

      if (curPct <= HARD_STOP_PCT) { closeNow = true; reason = "hardstop"; }
      else if (bestPct >= TRAIL_ARM_PCT) {
        const trail = bestPct >= STEP_THRESH ? STEP_TRAIL_PP : TRAIL_PP;
        if (bestPct - curPct >= trail) { closeNow = true; reason = "trail"; }
      }
      if (!closeNow && !bullish && rsi[i] < 50) { closeNow = true; reason = "trend"; }
    }

    if (closeNow) {
      const entryPrice = c15[entryIdx].c;
      const pnlPct = (price - entryPrice) / entryPrice * 100;
      trades.push({
        entryTime: new Date(c15[entryIdx].t).toISOString().slice(0,16).replace("T"," "),
        exitTime:  new Date(t).toISOString().slice(0,16).replace("T"," "),
        entryPrice, exitPrice: price, pnlPct, exitReason: reason,
      });
      mode = "USDT";
    }
  }
  return trades;
}

(async () => {
  // cover the window of the 5 recent live trades: Jun 18 2026 -> Jul 24 2026, with buffer
  // for warmup (12h EMA needs history) and for the strategy to potentially run longer than
  // the live bot did.
  const start = new Date("2026-05-01T00:00:00Z").getTime();
  const end   = new Date("2026-08-10T00:00:00Z").getTime();

  process.stdout.write(`Fetching SOLUSDT 15m... `); const c15 = await fetchKlines("SOLUSDT", "15m", start, end); console.log(`${c15.length}`);
  process.stdout.write(`Fetching SOLUSDT 12h... `); const c12h = await fetchKlines("SOLUSDT", "12h", start, end); console.log(`${c12h.length}`);

  const trades = runSim(c15, c12h);
  const relevant = trades.filter(t => t.entryTime >= "2026-06-15" && t.entryTime <= "2026-08-01");

  console.log(`\nNEW logic (-6% stop + trail 10pp/6pp@30%) trades in this window:`);
  console.log(`${"entry".padEnd(18)}${"exit".padEnd(18)}${"entryPx".padStart(9)}${"exitPx".padStart(9)}${"pnl%".padStart(8)}${"reason".padStart(10)}`);
  for (const t of relevant) {
    console.log(`${t.entryTime.padEnd(18)}${t.exitTime.padEnd(18)}${t.entryPrice.toFixed(2).padStart(9)}${t.exitPrice.toFixed(2).padStart(9)}${t.pnlPct.toFixed(2).padStart(7)}%${t.exitReason.padStart(10)}`);
  }

  const totalNewPct = relevant.reduce((mult, t) => mult * (1 + t.pnlPct/100), 1);
  console.log(`\nCompounded pnl over these trades: ${((totalNewPct-1)*100).toFixed(2)}%`);

  console.log(`\n--- ACTUAL live trades (old logic, no stop/trail) for comparison ---`);
  const actual = [
    { entry: "2026-06-18 09:19", exit: "2026-06-24 04:30", entryPx: 72.15, exitPx: 69.03, pnl: -4.32 },
    { entry: "2026-06-28 08:40", exit: "2026-06-28 21:55", entryPx: 72.01, exitPx: 70.33, pnl: -2.33 },
    { entry: "2026-06-30 13:45", exit: "2026-07-12 22:25", entryPx: 72.42, exitPx: 76.51, pnl: 5.65 },
    { entry: "2026-07-21 03:10", exit: "2026-07-21 09:20", entryPx: 78.42, exitPx: 78.27, pnl: -0.19 },
    { entry: "2026-07-22 06:45", exit: "2026-07-24 12:10", entryPx: 77.21, exitPx: 75.17, pnl: -2.64 },
  ];
  for (const t of actual) console.log(`${t.entry.padEnd(18)}${t.exit.padEnd(18)}${t.entryPx.toFixed(2).padStart(9)}${t.exitPx.toFixed(2).padStart(9)}${t.pnl.toFixed(2).padStart(7)}%`);
  const totalActualPct = actual.reduce((mult, t) => mult * (1 + t.pnl/100), 1);
  console.log(`Compounded pnl (actual): ${((totalActualPct-1)*100).toFixed(2)}%`);
})();
