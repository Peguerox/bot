// ECHO — On-Balance Volume Momentum Strategy
//
// Core idea: volume flows INTO a move before price confirms it.
// OBV = running sum: +volume on up candles, -volume on down candles.
// When OBV makes a new high → institutional money accumulating → buy.
// When OBV rolls over → distribution → exit.
//
// Timeframes:
//   4h  — trend gate:  EMA7 > EMA25 (only buy in uptrend)
//   15m  — signal:     OBV breakout + price above EMA20
//   exit: OBV drops below EMA10 OR 4h trend flips bearish
//
// No RSI. No Bollinger Bands. Pure volume intelligence.

const CAPITAL = 1000;
const FEE     = 0.001;
const WARMUP  = 50;
const SL      = 0.025;   // 2.5% hard stop — this holds for days, give it room

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Trade  = { entry: number; exit: number; pnlPct: number; reason: string; bars15m: number };

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchCandles(pages: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let endTime = Date.now();
  process.stdout.write(`Fetching ${pages * 1000} × 1m candles...\n`);
  for (let p = 0; p < pages; p++) {
    const url = `https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1m&limit=1000&endTime=${endTime}`;
    const res = await fetch(url);
    const raw: string[][] = await res.json();
    const batch = raw.map(c => ({ time: Number(c[0]), open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5]) }));
    all.unshift(...batch);
    endTime = batch[0].time - 1;
  }
  return all.sort((a, b) => a.time - b.time);
}

// ── Aggregate 1m → Nth candles ────────────────────────────────────────────────

function aggregate(candles: Candle[], minutes: number): Candle[] {
  const ms = minutes * 60 * 1000;
  const result: Candle[] = [];
  let bucket: Candle[] = [];
  let bucketStart = Math.floor(candles[0].time / ms) * ms;
  for (const c of candles) {
    const slot = Math.floor(c.time / ms) * ms;
    if (slot !== bucketStart && bucket.length > 0) {
      result.push({ time: bucketStart, open: bucket[0].open, high: Math.max(...bucket.map(x => x.high)), low: Math.min(...bucket.map(x => x.low)), close: bucket[bucket.length - 1].close, volume: bucket.reduce((a, x) => a + x.volume, 0) });
      bucket = [];
      bucketStart = slot;
    }
    bucket.push(c);
  }
  if (bucket.length > 0) result.push({ time: bucketStart, open: bucket[0].open, high: Math.max(...bucket.map(x => x.high)), low: Math.min(...bucket.map(x => x.low)), close: bucket[bucket.length - 1].close, volume: bucket.reduce((a, x) => a + x.volume, 0) });
  return result;
}

// ── Indicators ────────────────────────────────────────────────────────────────

function calcEMA(vals: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = new Array(vals.length).fill(NaN);
  if (vals.length < period) return out;
  out[period - 1] = vals.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < vals.length; i++) out[i] = vals[i] * k + out[i - 1] * (1 - k);
  return out;
}

function calcOBV(candles: Candle[]): number[] {
  const obv: number[] = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close)      obv[i] = obv[i - 1] + candles[i].volume;
    else if (candles[i].close < candles[i - 1].close) obv[i] = obv[i - 1] - candles[i].volume;
    else                                                obv[i] = obv[i - 1];
  }
  return obv;
}

// Rolling max over last N values
function rollingMax(vals: number[], i: number, n: number): number {
  return Math.max(...vals.slice(Math.max(0, i - n + 1), i + 1).filter(v => !isNaN(v)));
}

// ── Backtest ──────────────────────────────────────────────────────────────────

async function backtest(candles1m: Candle[]) {
  const candles15m = aggregate(candles1m, 15);
  const candles4h  = aggregate(candles1m, 240);

  // Precompute all indicators on 15m
  const obv15       = calcOBV(candles15m);
  const closes15    = candles15m.map(c => c.close);
  const obvEma10    = calcEMA(obv15, 10);
  const ema20_15    = calcEMA(closes15, 20);

  // Precompute all indicators on 4h
  const closes4h    = candles4h.map(c => c.close);
  const ema7_4h     = calcEMA(closes4h, 7);
  const ema25_4h    = calcEMA(closes4h, 25);

  // Map 15m candle → most recent 4h index
  function get4hIdx(ts: number): number {
    const MS4H = 240 * 60 * 1000;
    const slot = Math.floor(ts / MS4H) * MS4H;
    let idx = candles4h.findIndex(c => c.time === slot);
    return idx >= 0 ? idx : candles4h.length - 1;
  }

  let cash = CAPITAL, solQty = 0;
  let pos: "flat" | "long" = "flat";
  let entryPrice = 0, entryBar = 0;
  let trades = 0, wins = 0, peakEq = CAPITAL, maxDD = 0;
  const tradeLog: Trade[] = [];

  const enter = (price: number, bar: number) => { solQty = (cash * (1 - FEE)) / price; cash = 0; entryPrice = price; entryBar = bar; pos = "long"; };
  const exit  = (price: number, reason: string, bar: number) => {
    const out = solQty * price * (1 - FEE);
    const pnlPct = (out / (entryPrice * solQty / (1 - FEE)) - 1) * 100;
    if (out > entryPrice * solQty / (1 - FEE)) wins++;
    tradeLog.push({ entry: entryPrice, exit: price, pnlPct, reason, bars15m: bar - entryBar });
    cash = out; solQty = 0; pos = "flat"; trades++;
    if (cash > peakEq) peakEq = cash;
    const dd = (peakEq - cash) / peakEq * 100;
    if (dd > maxDD) maxDD = dd;
  };

  // Walk through 15m candles
  for (let i = WARMUP; i < candles15m.length - 1; i++) {
    const price  = candles15m[i].close;
    const i4h    = get4hIdx(candles15m[i].time);
    const bull4h = i4h >= 25 && !isNaN(ema7_4h[i4h]) && !isNaN(ema25_4h[i4h]) && ema7_4h[i4h] > ema25_4h[i4h];
    const bear4h = i4h >= 25 && !isNaN(ema7_4h[i4h]) && !isNaN(ema25_4h[i4h]) && ema7_4h[i4h] < ema25_4h[i4h];

    // ── EXIT ─────────────────────────────────────────────────────────────
    if (pos === "long") {
      const ret = price / entryPrice - 1;
      if (ret <= -SL)                                 { exit(price, `SL ${(ret*100).toFixed(2)}%`, i); continue; }
      if (bear4h)                                     { exit(price, "4h trend bearish", i); continue; }
      if (!isNaN(obvEma10[i]) && obv15[i] < obvEma10[i] && obv15[i - 1] >= obvEma10[i - 1])
                                                      { exit(price, "OBV crossed below EMA", i); continue; }
    }

    // ── ENTRY ─────────────────────────────────────────────────────────────
    if (pos === "flat" && bull4h) {
      const obvHigh20 = rollingMax(obv15, i - 1, 20); // previous 20-bar high
      const obvBreak  = obv15[i] > obvHigh20;          // OBV just broke to new high
      const aboveEma  = !isNaN(ema20_15[i]) && price > ema20_15[i];
      const obvRising = obv15[i] > obv15[i - 1] && obv15[i - 1] > obv15[i - 2]; // 2 bars rising

      if (obvBreak && aboveEma && obvRising) {
        enter(price, i);
      }
    }
  }

  if (pos === "long") exit(candles15m[candles15m.length - 1].close, "end of data", candles15m.length - 1);

  // ── Report ────────────────────────────────────────────────────────────────
  const totalPct = (cash / CAPITAL - 1) * 100;
  const winRate  = trades > 0 ? wins / trades * 100 : 0;
  const avgWin   = tradeLog.filter(t => t.pnlPct > 0).reduce((a, t) => a + t.pnlPct, 0) / Math.max(1, wins);
  const avgLoss  = tradeLog.filter(t => t.pnlPct <= 0).reduce((a, t) => a + t.pnlPct, 0) / Math.max(1, trades - wins);
  const expect   = (winRate / 100) * avgWin + (1 - winRate / 100) * avgLoss;
  const days     = (candles15m[candles15m.length - 1].time - candles15m[WARMUP].time) / 86_400_000;

  console.log("\n" + "═".repeat(62));
  console.log("  ECHO — OBV Momentum Backtest");
  console.log("═".repeat(62));
  console.log(`  Period:      ${days.toFixed(1)} days`);
  console.log(`  Trades:      ${trades}  (${(trades / days).toFixed(1)}/day)`);
  console.log(`  Win rate:    ${winRate.toFixed(1)}%  (${wins}W / ${trades - wins}L)`);
  console.log(`  Avg win:     +${avgWin.toFixed(3)}%`);
  console.log(`  Avg loss:    ${avgLoss.toFixed(3)}%`);
  console.log(`  Expectancy:  ${expect >= 0 ? "+" : ""}${expect.toFixed(3)}% per trade`);
  console.log(`  Max DD:      -${maxDD.toFixed(2)}%`);
  console.log(`  Total P&L:   ${totalPct >= 0 ? "+" : ""}${totalPct.toFixed(3)}%  ($${cash.toFixed(2)})`);
  console.log("═".repeat(62));
  console.log(`\n  ALL TRADES:`);
  console.log("  " + ["Entry".padEnd(9), "Exit".padEnd(9), "P&L%".padEnd(10), "Bars(15m)".padEnd(11), "Reason"].join(""));
  console.log("  " + "─".repeat(58));
  for (const t of tradeLog) {
    console.log("  " + [`$${t.entry.toFixed(2)}`.padEnd(9), `$${t.exit.toFixed(2)}`.padEnd(9), `${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(3)}%`.padEnd(10), String(t.bars15m).padEnd(11), t.reason].join(""));
  }
  console.log("");
}

async function main() {
  const candles = await fetchCandles(44); // ~30 days
  await backtest(candles);
}
main().catch(console.error);
