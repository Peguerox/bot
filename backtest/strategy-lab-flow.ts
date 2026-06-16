// Order-Flow Lab — strategies built from ACTUAL flow data, not candle shapes
// Uses kline fields ignored until now:
//   [8] trade count  -> avg trade size (volume/trades) = whale/liquidation detector
//   [9] taker buy base volume -> aggressive buy vs sell flow per candle
// 5m candles, 90 days, $25/trade, market entry +0.02%, conservative SL-first fills
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US = "https://api.binance.us/api/v3";
const KEY = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;
const ALLOC = 25;
const ENTRY_SLIP = 1.0002;
const BARS_PER_DAY = 288;

type Candle = {
  time: number; open: number; high: number; low: number; close: number;
  volume: number; trades: number; takerBuy: number;
};

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
      trades: Number(c[8]), takerBuy: parseFloat(c[9]),
    });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(120);
  }
  return candles;
}

// ── Flow context ──
type Ctx = {
  buyRatio: number[];      // taker buy / total volume (0..1); 0.5 = balanced
  avgSize: number[];       // volume / trades
  avgSizeSma: number[];    // 20-bar SMA of avgSize (baseline)
  volSma: number[];        // 20-bar SMA of volume
  delta: number[];         // taker buy - taker sell (base units)
  cumDelta: number[];      // running sum of delta
};

function buildCtx(c: Candle[]): Ctx {
  const n = c.length;
  const buyRatio = new Array(n).fill(0.5);
  const avgSize = new Array(n).fill(0);
  const avgSizeSma = new Array(n).fill(0);
  const volSma = new Array(n).fill(0);
  const delta = new Array(n).fill(0);
  const cumDelta = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    buyRatio[i] = c[i].volume > 0 ? c[i].takerBuy / c[i].volume : 0.5;
    avgSize[i] = c[i].trades > 0 ? c[i].volume / c[i].trades : 0;
    delta[i] = 2 * c[i].takerBuy - c[i].volume;
    cumDelta[i] = (i > 0 ? cumDelta[i - 1] : 0) + delta[i];
    if (i >= 20) {
      let sS = 0, sV = 0;
      for (let j = i - 19; j <= i; j++) { sS += avgSize[j]; sV += c[j].volume; }
      avgSizeSma[i] = sS / 20;
      volSma[i] = sV / 20;
    }
  }
  return { buyRatio, avgSize, avgSizeSma, volSma, delta, cumDelta };
}

type SignalFn = (i: number, c: Candle[], x: Ctx) => boolean;

function sim(candles: Candle[], x: Ctx, signalFn: SignalFn, tp: number, sl: number, maxHold: number) {
  let bal = ALLOC, peak = ALLOC, maxDD = 0, trades = 0, wins = 0, gW = 0, gL = 0;
  let pos: { entry: number; tp: number; sl: number; hold: number } | null = null;

  for (let i = 30; i < candles.length - 1; i++) {
    const next = candles[i + 1];
    if (pos) {
      pos.hold++;
      const qty = ALLOC / pos.entry;
      let exit: number | null = null;
      if (next.low <= pos.sl) exit = pos.sl;
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
    `  ${label}`.padEnd(44) +
    `${r.trades}`.padStart(5) +
    `  ${r.perDay.toFixed(1)}`.padStart(6) +
    `  ${r.wr.toFixed(1)}%`.padStart(7) +
    `  ${pfStr}`.padStart(6) +
    `  ${sign}$${r.pnl.toFixed(2)}`.padStart(9) +
    `  ${sign}${r.pct.toFixed(1)}%`.padStart(8) +
    `  ${r.maxDD.toFixed(1)}%`.padStart(7)
  );
}

// ── Flow strategies ──

// F1: Capitulation — price drop + one-sided sell flow + whale-size prints = forced sellers climaxing
const capitulation = (minDrop: number, maxBuyRatio: number, sizeMult: number): SignalFn => (i, c, x) =>
  x.avgSizeSma[i] > 0 &&
  (c[i].close - c[i].open) / c[i].open <= -minDrop &&
  x.buyRatio[i] <= maxBuyRatio &&
  x.avgSize[i] >= x.avgSizeSma[i] * sizeMult;

// F2: Absorption — heavy aggressive selling but price refuses to fall = big limit buyer absorbing
const absorption = (minSellRatio: number, volMult: number, maxDrop: number): SignalFn => (i, c, x) =>
  x.volSma[i] > 0 &&
  x.buyRatio[i] <= 1 - minSellRatio &&
  c[i].volume >= x.volSma[i] * volMult &&
  (c[i].close - c[i].open) / c[i].open >= -maxDrop;

// F3: Flow-filtered flush — the validated flush bounce, but only when flow shows forced selling
const flowFlush = (minDrop: number, maxBuyRatio: number): SignalFn => (i, c, x) =>
  (c[i].close - c[i].open) / c[i].open <= -minDrop &&
  x.buyRatio[i] <= maxBuyRatio;

// F4: Buy-flow surge — one-sided aggressive buying with volume = informed buyer, ride it
const buySurge = (minBuyRatio: number, volMult: number): SignalFn => (i, c, x) =>
  x.volSma[i] > 0 &&
  x.buyRatio[i] >= minBuyRatio &&
  c[i].volume >= x.volSma[i] * volMult;

// F5: Sell exhaustion flip — N bars of sell-dominated flow, then flow flips to buyers
const exhaustionFlip = (nBars: number, sellThresh: number, buyThresh: number): SignalFn => (i, _c, x) => {
  if (x.buyRatio[i] < buyThresh) return false;
  for (let k = 1; k <= nBars; k++) if (x.buyRatio[i - k] > sellThresh) return false;
  return true;
};

// F6: Whale buy prints — avg trade size explodes AND flow is buy-side = institutions stepping in
const whaleBuy = (sizeMult: number, minBuyRatio: number): SignalFn => (i, _c, x) =>
  x.avgSizeSma[i] > 0 &&
  x.avgSize[i] >= x.avgSizeSma[i] * sizeMult &&
  x.buyRatio[i] >= minBuyRatio;

// F7: Delta divergence — price lower low over 12 bars, cumulative delta higher low = sellers exhausting
const deltaDivergence: SignalFn = (i, c, x) => {
  if (i < 24) return false;
  let pLowNow = Infinity, pLowPrev = Infinity, dLowNow = Infinity, dLowPrev = Infinity;
  for (let k = 0; k < 12; k++) {
    pLowNow = Math.min(pLowNow, c[i - k].low);
    dLowNow = Math.min(dLowNow, x.cumDelta[i - k]);
    pLowPrev = Math.min(pLowPrev, c[i - 12 - k].low);
    dLowPrev = Math.min(dLowPrev, x.cumDelta[i - 12 - k]);
  }
  return c[i].low <= pLowNow && pLowNow < pLowPrev && dLowNow > dLowPrev &&
         (pLowPrev - pLowNow) / pLowPrev >= 0.003;
};

(async () => {
  console.log("\nORDER-FLOW LAB  |  5m  |  90d  |  $25/trade  |  taker flow + trade size from klines\n");

  const agg = new Map<string, { pnl: number; trades: number }>();

  for (const symbol of ["BTCUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT"]) {
    process.stdout.write(`Fetching ${symbol}... `);
    const candles = await fetchKlines(symbol);
    console.log(`${candles.length} candles`);
    const x = buildCtx(candles);

    console.log(`\n  ── ${symbol} ──`);
    console.log("  Strategy                                    Tr   /day    WR%    PF      PnL$     Ret%   MaxDD%");
    console.log("  " + "─".repeat(100));

    const tests: [string, ReturnType<typeof sim>][] = [
      ["F1 Capit: -0.4% sell70% size2x, TP.5 SL.35", sim(candles, x, capitulation(0.004, 0.30, 2),   0.005, 0.0035, 12)],
      ["F1 Capit: -0.6% sell65% size1.5x, TP.6 SL.4", sim(candles, x, capitulation(0.006, 0.35, 1.5), 0.006, 0.004, 12)],
      ["F2 Absorb: sell70% vol2x flat, TP.5 SL.35",  sim(candles, x, absorption(0.70, 2, 0.001),     0.005, 0.0035, 12)],
      ["F2 Absorb: sell65% vol3x flat, TP.6 SL.4",   sim(candles, x, absorption(0.65, 3, 0.001),     0.006, 0.004, 12)],
      ["F3 FlowFlush: -0.5% sell70%, TP.5 SL.35",    sim(candles, x, flowFlush(0.005, 0.30),         0.005, 0.0035, 6)],
      ["F3 FlowFlush: -0.8% sell65%, TP.6 SL.45",    sim(candles, x, flowFlush(0.008, 0.35),         0.006, 0.0045, 6)],
      ["F4 BuySurge: buy75% vol3x, TP.5 SL.3",       sim(candles, x, buySurge(0.75, 3),              0.005, 0.003, 12)],
      ["F4 BuySurge: buy80% vol2x, TP.6 SL.3",       sim(candles, x, buySurge(0.80, 2),              0.006, 0.003, 12)],
      ["F5 ExhFlip: 3bars sell60->buy60, TP.4 SL.3", sim(candles, x, exhaustionFlip(3, 0.40, 0.60),  0.004, 0.003, 12)],
      ["F5 ExhFlip: 5bars sell55->buy65, TP.5 SL.35",sim(candles, x, exhaustionFlip(5, 0.45, 0.65),  0.005, 0.0035, 12)],
      ["F6 WhaleBuy: size3x buy65%, TP.5 SL.35",     sim(candles, x, whaleBuy(3, 0.65),              0.005, 0.0035, 12)],
      ["F6 WhaleBuy: size4x buy70%, TP.6 SL.4",      sim(candles, x, whaleBuy(4, 0.70),              0.006, 0.004, 12)],
      ["F7 DeltaDiv: 12bar LL + delta HL, TP.5 SL.4",sim(candles, x, deltaDivergence,                0.005, 0.004, 12)],
    ];

    for (const [label, r] of tests) {
      row(label, r);
      const a = agg.get(label) ?? { pnl: 0, trades: 0 };
      a.pnl += r.pnl; a.trades += r.trades;
      agg.set(label, a);
    }
  }

  console.log("\n  ── PORTFOLIO (all 5 coins combined, 90d) ──");
  console.log("  Strategy                                      Total PnL$    Ret%   Trades   /day");
  console.log("  " + "─".repeat(86));
  for (const [label, a] of agg) {
    const sign = a.pnl >= 0 ? "+" : "";
    console.log(
      `  ${label}`.padEnd(46) +
      `${sign}$${a.pnl.toFixed(2)}`.padStart(9) +
      `  ${sign}${(a.pnl / ALLOC * 100).toFixed(1)}%`.padStart(9) +
      `${a.trades}`.padStart(8) +
      `  ${(a.trades / 90).toFixed(1)}`.padStart(6)
    );
  }
  console.log();
})();
