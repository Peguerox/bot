// Strategy Lab — test multiple 1m strategy ideas head-to-head on the same data
// Does NOT touch the live bot. Pure research.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US = "https://api.binance.us/api/v3";
const KEY = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const ALLOC = 25;
const ENTRY_SLIP = 1.0002; // market entry, taker

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string): Promise<Candle[]> {
  const candles: Candle[] = [];
  let from = Date.now() - LOOKBACK_MS, end = Date.now();
  while (from < end) {
    const res = await fetch(`${BASE_US}/klines?symbol=${symbol}&interval=1m&startTime=${from}&endTime=${end}&limit=1000`, { headers: { "X-MBX-APIKEY": KEY } });
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

function rsi(closes: number[], period: number): number[] {
  const out: number[] = new Array(closes.length).fill(50);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period && i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// signal fn receives index i (decision made at close of candle i, entry at candle i+1's open ≈ close of i)
type SignalFn = (i: number, c: Candle[], closes: number[], rsi14: number[]) => boolean;

function sim(candles: Candle[], signalFn: SignalFn, tp: number, sl: number, maxHold: number) {
  const closes = candles.map(c => c.close);
  const rsi14  = rsi(closes, 14);

  let bal = ALLOC, peak = ALLOC, maxDD = 0, trades = 0, wins = 0, tpHits = 0, gW = 0, gL = 0;
  let pos: { entry: number; tp: number; sl: number; hold: number } | null = null;

  for (let i = 30; i < candles.length - 1; i++) {
    const next = candles[i + 1]; // we act on candle i+1 after deciding at close of i

    if (pos) {
      pos.hold++;
      const qty = ALLOC / pos.entry;
      let exit: number | null = null, win = false, isTp = false;
      if (next.low <= pos.sl) { exit = pos.sl; }                 // conservative: SL first
      else if (next.high >= pos.tp) { exit = pos.tp; win = true; isTp = true; }
      else if (pos.hold >= maxHold) { exit = next.close; win = next.close >= pos.entry; }
      if (exit !== null) {
        const pnl = (exit - pos.entry) * qty;
        bal += pnl; trades++;
        if (pnl >= 0) { wins++; gW += pnl; } else gL += Math.abs(pnl);
        if (isTp) tpHits++;
        if (bal > peak) peak = bal;
        if ((peak - bal) / peak * 100 > maxDD) maxDD = (peak - bal) / peak * 100;
        pos = null;
      }
      continue;
    }

    if (signalFn(i, candles, closes, rsi14)) {
      const entry = next.open * ENTRY_SLIP;
      pos = { entry, tp: entry * (1 + tp), sl: entry * (1 - sl), hold: 0 };
    }
  }

  const days = candles.length / 1440;
  const pnl = bal - ALLOC, wr = trades > 0 ? wins / trades * 100 : 0, pf = gL > 0 ? gW / gL : Infinity;
  return { pnl, pct: pnl / ALLOC * 100, wr, pf, trades, tpHits, maxDD, perDay: trades / days };
}

function row(label: string, r: ReturnType<typeof sim>) {
  const pfStr = r.pf === Infinity ? "  inf" : r.pf.toFixed(2);
  const sign = r.pnl >= 0 ? "+" : "";
  console.log(
    `  ${label}`.padEnd(34) +
    `${r.trades}`.padStart(6) +
    `  ${r.perDay.toFixed(1)}`.padStart(6) +
    `  ${r.wr.toFixed(1)}%`.padStart(7) +
    `  ${pfStr}`.padStart(6) +
    `  ${sign}$${r.pnl.toFixed(2)}`.padStart(9) +
    `  ${sign}${r.pct.toFixed(1)}%`.padStart(8) +
    `  ${r.maxDD.toFixed(1)}%`.padStart(7)
  );
}

// ── Strategies ────────────────────────────────────────────────────────────────

// S1: N consecutive red candles → mean-reversion buy
const consecRed = (n: number): SignalFn => (i, c) => {
  for (let k = 0; k < n; k++) if (c[i - k].close >= c[i - k].open) return false;
  return true;
};

// S2: single-candle flush — candle drops >= X% in one minute
const flushDrop = (minDrop: number): SignalFn => (i, c) =>
  (c[i].close - c[i].open) / c[i].open <= -minDrop;

// S3: RSI oversold
const rsiOversold = (level: number): SignalFn => (i, _c, _cl, r) => r[i] < level && r[i - 1] >= level;

// S4: momentum continuation — strong green candle + above-average volume
const momoBurst = (minUp: number): SignalFn => (i, c) => {
  const avgVol = (c[i-1].volume + c[i-2].volume + c[i-3].volume + c[i-4].volume + c[i-5].volume) / 5;
  return (c[i].close - c[i].open) / c[i].open >= minUp && c[i].volume > avgVol * 2;
};

// S5: volatility squeeze breakout — 15m range < 0.15%, close breaks above range high
const squeezeBreak = (maxRange: number): SignalFn => (i, c) => {
  let hi = -Infinity, lo = Infinity;
  for (let k = 1; k <= 15; k++) { hi = Math.max(hi, c[i-k].high); lo = Math.min(lo, c[i-k].low); }
  return (hi - lo) / lo <= maxRange && c[i].close > hi;
};

// S6: wick rejection — long lower wick (hammer), wick >= 2x body, red-to-green close
const hammerWick: SignalFn = (i, c) => {
  const body = Math.abs(c[i].close - c[i].open);
  const lowerWick = Math.min(c[i].close, c[i].open) - c[i].low;
  return lowerWick >= body * 2 && lowerWick / c[i].low >= 0.0008 && c[i].close > c[i].open;
};

(async () => {
  console.log("\nSTRATEGY LAB  |  1m candles  |  30d  |  $25/trade  |  market entry (+0.02%)");
  console.log("Decision at candle close, entry at next candle  |  conservative SL-first fills\n");

  for (const symbol of ["BTCUSDT", "SOLUSDT", "XRPUSDT"]) {
    process.stdout.write(`Fetching ${symbol}... `);
    const candles = await fetchKlines(symbol);
    console.log(`${candles.length} candles`);

    console.log(`\n  ── ${symbol} ──`);
    console.log("  Strategy                         Trades  /day    WR%    PF      PnL$     Ret%   MaxDD%");
    console.log("  " + "─".repeat(92));

    row("3 red candles, TP/SL 0.15/0.15",  sim(candles, consecRed(3),       0.0015, 0.0015, 10));
    row("5 red candles, TP/SL 0.15/0.15",  sim(candles, consecRed(5),       0.0015, 0.0015, 10));
    row("Flush -0.3%, TP/SL 0.2/0.2",      sim(candles, flushDrop(0.003),   0.002,  0.002,  10));
    row("Flush -0.5%, TP/SL 0.3/0.3",      sim(candles, flushDrop(0.005),   0.003,  0.003,  15));
    row("RSI<25 cross, TP/SL 0.2/0.2",     sim(candles, rsiOversold(25),    0.002,  0.002,  15));
    row("RSI<20 cross, TP/SL 0.2/0.2",     sim(candles, rsiOversold(20),    0.002,  0.002,  15));
    row("Momo +0.2% 2xVol, TP/SL 0.2/0.15",sim(candles, momoBurst(0.002),   0.002,  0.0015, 10));
    row("Squeeze<0.15% brk, TP/SL 0.2/0.15",sim(candles, squeezeBreak(0.0015),0.002, 0.0015, 15));
    row("Hammer wick, TP/SL 0.15/0.15",    sim(candles, hammerWick,         0.0015, 0.0015, 10));
  }
  console.log();
})();
