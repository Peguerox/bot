// 5-Minute Strategy Lab — structural ideas that need room to breathe
// 90 days of 5m candles, $25/trade, market entry +0.02%, maker exits free
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US = "https://api.binance.us/api/v3";
const KEY = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;
const ALLOC = 25;
const ENTRY_SLIP = 1.0002;
const BARS_PER_DAY = 288;

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string): Promise<Candle[]> {
  const candles: Candle[] = [];
  let from = Date.now() - LOOKBACK_MS, end = Date.now();
  while (from < end) {
    const res = await fetch(`${BASE_US}/klines?symbol=${symbol}&interval=5m&startTime=${from}&endTime=${end}&limit=1000`, { headers: { "X-MBX-APIKEY": KEY } });
    if (res.status === 429) { await sleep(10000); continue; }
    const raw = await res.json() as any;
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) candles.push({
      time: Number(c[0]), open: parseFloat(c[1]), high: parseFloat(c[2]),
      low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5]),
    });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(120);
  }
  return candles;
}

// ── Precomputed context passed to signals ──
type Ctx = {
  ema200: number[];          // ~16h trend EMA on 5m
  volSma20: number[];
  bbUp: number[]; bbLo: number[]; bbMid: number[];
  dayOpen: number[];         // UTC daily open at bar i
  prevDayLow: number[];
  hourUTC: number[];
};

function buildCtx(c: Candle[]): Ctx {
  const n = c.length;
  const ema200 = new Array(n).fill(0);
  const volSma20 = new Array(n).fill(0);
  const bbUp = new Array(n).fill(0), bbLo = new Array(n).fill(0), bbMid = new Array(n).fill(0);
  const dayOpen = new Array(n).fill(0), prevDayLow = new Array(n).fill(0);
  const hourUTC = new Array(n).fill(0);

  const k = 2 / 201;
  let ema = c[0].close;
  let curDayKey = "", curOpen = c[0].open;
  let curLow = Infinity, prevLow = 0;

  for (let i = 0; i < n; i++) {
    ema = i === 0 ? c[0].close : c[i].close * k + ema * (1 - k);
    ema200[i] = ema;

    const d = new Date(c[i].time);
    hourUTC[i] = d.getUTCHours();
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    if (key !== curDayKey) {
      curDayKey = key;
      curOpen = c[i].open;
      prevLow = curLow === Infinity ? 0 : curLow;
      curLow = Infinity;
    }
    curLow = Math.min(curLow, c[i].low);
    dayOpen[i] = curOpen;
    prevDayLow[i] = prevLow;

    if (i >= 20) {
      let sV = 0, sC = 0;
      for (let j = i - 19; j <= i; j++) { sV += c[j].volume; sC += c[j].close; }
      volSma20[i] = sV / 20;
      const mid = sC / 20;
      let varSum = 0;
      for (let j = i - 19; j <= i; j++) varSum += (c[j].close - mid) ** 2;
      const sd = Math.sqrt(varSum / 20);
      bbMid[i] = mid; bbUp[i] = mid + 2 * sd; bbLo[i] = mid - 2 * sd;
    }
  }
  return { ema200, volSma20, bbUp, bbLo, bbMid, dayOpen, prevDayLow, hourUTC };
}

type SignalFn = (i: number, c: Candle[], x: Ctx) => boolean;

function sim(candles: Candle[], x: Ctx, signalFn: SignalFn, tp: number, sl: number, maxHold: number) {
  let bal = ALLOC, peak = ALLOC, maxDD = 0, trades = 0, wins = 0, gW = 0, gL = 0;
  let pos: { entry: number; tp: number; sl: number; hold: number } | null = null;

  for (let i = 300; i < candles.length - 1; i++) {
    const next = candles[i + 1];
    if (pos) {
      pos.hold++;
      const qty = ALLOC / pos.entry;
      let exit: number | null = null;
      if (next.low <= pos.sl) exit = pos.sl;            // conservative: SL first
      else if (next.high >= pos.tp) exit = pos.tp;
      else if (pos.hold >= maxHold) exit = next.close;
      if (exit !== null) {
        const pnl = (exit - pos.entry) * qty;
        bal += pnl; trades++;
        if (pnl >= 0) { wins++; gW += pnl; } else gL += Math.abs(pnl);
        if (bal > peak) peak = bal;
        if ((peak - bal) / peak * 100 > maxDD) maxDD = (peak - bal) / peak * 100;
        pos = null;
      }
      continue;
    }
    if (signalFn(i, candles, x)) {
      const entry = next.open * ENTRY_SLIP;
      pos = { entry, tp: entry * (1 + tp), sl: entry * (1 - sl), hold: 0 };
    }
  }

  const days = candles.length / BARS_PER_DAY;
  const pnl = bal - ALLOC, wr = trades > 0 ? wins / trades * 100 : 0, pf = gL > 0 ? gW / gL : Infinity;
  return { pnl, pct: pnl / ALLOC * 100, wr, pf, trades, maxDD, perDay: trades / days };
}

function row(label: string, r: ReturnType<typeof sim>) {
  const pfStr = r.pf === Infinity ? "  inf" : r.pf.toFixed(2);
  const sign = r.pnl >= 0 ? "+" : "";
  console.log(
    `  ${label}`.padEnd(40) +
    `${r.trades}`.padStart(5) +
    `  ${r.perDay.toFixed(1)}`.padStart(6) +
    `  ${r.wr.toFixed(1)}%`.padStart(7) +
    `  ${pfStr}`.padStart(6) +
    `  ${sign}$${r.pnl.toFixed(2)}`.padStart(9) +
    `  ${sign}${r.pct.toFixed(1)}%`.padStart(8) +
    `  ${r.maxDD.toFixed(1)}%`.padStart(7)
  );
}

// ── Strategies ──

// S1: trend-filtered dip — above EMA200 (uptrend) AND 5m candle drops >= X%
const trendDip = (minDrop: number): SignalFn => (i, c, x) =>
  c[i].close > x.ema200[i] &&
  (c[i].close - c[i].open) / c[i].open <= -minDrop;

// S2: daily open reversion — price >= X% below today's UTC open
const dayOpenRevert = (minGap: number): SignalFn => (i, c, x) =>
  x.dayOpen[i] > 0 &&
  (c[i].close - x.dayOpen[i]) / x.dayOpen[i] <= -minGap &&
  (c[i - 1].close - x.dayOpen[i - 1]) / x.dayOpen[i - 1] > -minGap; // first cross only

// S3: yesterday's low bounce — wick touches prev day low, closes back above
const yLowBounce: SignalFn = (i, c, x) =>
  x.prevDayLow[i] > 0 &&
  c[i].low <= x.prevDayLow[i] * 1.001 &&
  c[i].close > x.prevDayLow[i];

// S4: volume-spike flush — drop >= X% with vol >= 3x average
const volFlush = (minDrop: number, volMult: number): SignalFn => (i, c, x) =>
  x.volSma20[i] > 0 &&
  (c[i].close - c[i].open) / c[i].open <= -minDrop &&
  c[i].volume >= x.volSma20[i] * volMult;

// S5: BB reclaim — prev close below lower band, this close back above it
const bbReclaim: SignalFn = (i, c, x) =>
  x.bbLo[i - 1] > 0 &&
  c[i - 1].close < x.bbLo[i - 1] &&
  c[i].close > x.bbLo[i];

// S6: power hour — enter at first bar of 16:00 UTC, time-exit ~2h (TP/SL wide)
const powerHour: SignalFn = (i, _c, x) => x.hourUTC[i] === 16 && x.hourUTC[i - 1] === 15;

// S7: momentum breakout — close > 12-bar high with 2x volume
const momoBreak: SignalFn = (i, c, x) => {
  if (x.volSma20[i] <= 0 || c[i].volume < x.volSma20[i] * 2) return false;
  let hi = -Infinity;
  for (let k2 = 1; k2 <= 12; k2++) hi = Math.max(hi, c[i - k2].high);
  return c[i].close > hi;
};

(async () => {
  console.log("\n5-MINUTE LAB  |  5m candles  |  90d  |  $25/trade  |  market entry (+0.02%)\n");

  const agg = new Map<string, { pnl: number; trades: number }>();

  for (const symbol of ["BTCUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT"]) {
    process.stdout.write(`Fetching ${symbol}... `);
    const candles = await fetchKlines(symbol);
    console.log(`${candles.length} candles`);
    const x = buildCtx(candles);

    console.log(`\n  ── ${symbol} ──`);
    console.log("  Strategy                                Tr   /day    WR%    PF      PnL$     Ret%   MaxDD%");
    console.log("  " + "─".repeat(96));

    const tests: [string, ReturnType<typeof sim>][] = [
      ["TrendDip: >EMA200, -0.4%, TP0.5 SL0.4",  sim(candles, x, trendDip(0.004),     0.005, 0.004, 12)],
      ["TrendDip: >EMA200, -0.6%, TP0.6 SL0.45", sim(candles, x, trendDip(0.006),     0.006, 0.0045, 12)],
      ["DayOpen: -1.0% below, TP0.6 SL0.5",      sim(candles, x, dayOpenRevert(0.01), 0.006, 0.005, 24)],
      ["DayOpen: -1.5% below, TP0.8 SL0.6",      sim(candles, x, dayOpenRevert(0.015),0.008, 0.006, 36)],
      ["YdayLow bounce, TP0.6 SL0.4",            sim(candles, x, yLowBounce,          0.006, 0.004, 24)],
      ["VolFlush: -0.5% 3xVol, TP0.5 SL0.35",    sim(candles, x, volFlush(0.005, 3),  0.005, 0.0035, 6)],
      ["VolFlush: -0.8% 3xVol, TP0.6 SL0.45",    sim(candles, x, volFlush(0.008, 3),  0.006, 0.0045, 6)],
      ["BB(20,2) reclaim, TP0.5 SL0.4",          sim(candles, x, bbReclaim,           0.005, 0.004, 12)],
      ["PowerHour 16-18 UTC, TP1.0 SL1.0",       sim(candles, x, powerHour,           0.01,  0.01,  24)],
      ["MomoBreak 1h-high 2xVol, TP0.8 SL0.4",   sim(candles, x, momoBreak,           0.008, 0.004, 12)],
    ];

    for (const [label, r] of tests) {
      row(label, r);
      const a = agg.get(label) ?? { pnl: 0, trades: 0 };
      a.pnl += r.pnl; a.trades += r.trades;
      agg.set(label, a);
    }
  }

  console.log("\n  ── PORTFOLIO (all 5 coins combined, 90d) ──");
  console.log("  Strategy                                  Total PnL$    Ret%   Trades   /day");
  console.log("  " + "─".repeat(80));
  for (const [label, a] of agg) {
    const sign = a.pnl >= 0 ? "+" : "";
    console.log(
      `  ${label}`.padEnd(42) +
      `${sign}$${a.pnl.toFixed(2)}`.padStart(9) +
      `  ${sign}${(a.pnl / ALLOC * 100).toFixed(1)}%`.padStart(9) +
      `${a.trades}`.padStart(8) +
      `  ${(a.trades / 90).toFixed(1)}`.padStart(6)
    );
  }
  console.log();
})();
