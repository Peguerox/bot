// CHIMERA v2 backtest — proper candle-based signals
// Ranging:  Bollinger Band touch + RSI oversold → mean revert
// Trending: EMA breakout + volume surge → momentum
// Regime:   ATR vs its own average (low ATR = range, high ATR = trend)

const CAPITAL   = 1000;
const FEE       = 0.001;
const WARMUP    = 100;

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Trade  = { entry: number; exit: number; pnlPct: number; mode: string; reason: string; bars: number };

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchCandles(pages: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let endTime = Date.now();
  process.stdout.write(`Fetching ${pages * 1000} candles (~${(pages * 1000 / 60 / 24).toFixed(1)} days)...\n`);
  for (let p = 0; p < pages; p++) {
    const url = `https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1m&limit=1000&endTime=${endTime}`;
    const res  = await fetch(url);
    const raw: string[][] = await res.json();
    const candles = raw.map(c => ({
      time: Number(c[0]), open: parseFloat(c[1]), high: parseFloat(c[2]),
      low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5]),
    }));
    all.unshift(...candles);
    endTime = candles[0].time - 1;
  }
  return all.sort((a, b) => a.time - b.time);
}

// ── Indicators ────────────────────────────────────────────────────────────────

function ema(vals: number[], i: number, p: number): number {
  if (i < p - 1) return NaN;
  const k = 2 / (p + 1);
  let v = vals.slice(i - p + 1, i + 1).slice(0, p).reduce((a, b) => a + b, 0) / p;
  // fast but approximate: use full slice from i-p+1
  const slice = vals.slice(Math.max(0, i - p * 3), i + 1);
  v = slice.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let j = p; j < slice.length; j++) v = slice[j] * k + v * (1 - k);
  return v;
}

function rsi(vals: number[], i: number, p = 14): number {
  if (i < p + 1) return NaN;
  let ag = 0, al = 0;
  for (let j = i - p; j < i; j++) {
    const d = vals[j + 1] - vals[j];
    d > 0 ? (ag += d) : (al -= d);
  }
  ag /= p; al /= p;
  for (let j = i - p + 1; j <= i; j++) {
    const d = vals[j] - vals[j - 1];
    ag = (ag * (p - 1) + Math.max(d, 0)) / p;
    al = (al * (p - 1) + Math.max(-d, 0)) / p;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function bb(vals: number[], i: number, p = 20, mult = 2): { upper: number; mid: number; lower: number } {
  if (i < p - 1) return { upper: NaN, mid: NaN, lower: NaN };
  const sl   = vals.slice(i - p + 1, i + 1);
  const mid  = sl.reduce((a, b) => a + b, 0) / p;
  const std  = Math.sqrt(sl.reduce((a, b) => a + (b - mid) ** 2, 0) / p);
  return { upper: mid + mult * std, mid, lower: mid - mult * std };
}

function atr(candles: Candle[], i: number, p = 14): number {
  if (i < p) return NaN;
  let avgTr = 0;
  for (let j = i - p + 1; j <= i; j++) {
    const tr = Math.max(candles[j].high - candles[j].low, Math.abs(candles[j].high - candles[j - 1].close), Math.abs(candles[j].low - candles[j - 1].close));
    avgTr += tr;
  }
  return avgTr / p;
}

function avgVol(candles: Candle[], i: number, p = 20): number {
  if (i < p) return 0;
  return candles.slice(i - p + 1, i + 1).reduce((a, c) => a + c.volume, 0) / p;
}

// Regime: compare ATR to its own 50-period average
function regime(candles: Candle[], i: number): "ranging" | "trending" | "neutral" {
  const curAtr = atr(candles, i, 14);
  if (isNaN(curAtr) || i < 64) return "neutral";
  let atrAvg = 0;
  let valid = 0;
  for (let j = i - 49; j <= i; j++) {
    const a = atr(candles, j, 14);
    if (!isNaN(a)) { atrAvg += a; valid++; }
  }
  atrAvg /= valid;
  const ratio = curAtr / atrAvg;
  if (ratio < 0.80) return "ranging";
  if (ratio > 1.30) return "trending";
  return "neutral";
}

// ── Aggregate 1m → 4h candles ─────────────────────────────────────────────────

function build4h(candles: Candle[]): Candle[] {
  const MS_4H = 4 * 60 * 60 * 1000;
  const result: Candle[] = [];
  let bucket: Candle[] = [];
  let bucketStart = Math.floor(candles[0].time / MS_4H) * MS_4H;

  for (const c of candles) {
    const thisBucket = Math.floor(c.time / MS_4H) * MS_4H;
    if (thisBucket !== bucketStart && bucket.length > 0) {
      result.push({
        time:   bucketStart,
        open:   bucket[0].open,
        high:   Math.max(...bucket.map(x => x.high)),
        low:    Math.min(...bucket.map(x => x.low)),
        close:  bucket[bucket.length - 1].close,
        volume: bucket.reduce((a, x) => a + x.volume, 0),
      });
      bucket = [];
      bucketStart = thisBucket;
    }
    bucket.push(c);
  }
  if (bucket.length > 0) {
    result.push({ time: bucketStart, open: bucket[0].open, high: Math.max(...bucket.map(x => x.high)), low: Math.min(...bucket.map(x => x.low)), close: bucket[bucket.length - 1].close, volume: bucket.reduce((a, x) => a + x.volume, 0) });
  }
  return result;
}

// ── Backtest ──────────────────────────────────────────────────────────────────

async function backtest(candles: Candle[]) {
  const closes = candles.map(c => c.close);

  // Build 4h candles and precompute their EMA7/EMA25
  const candles4h  = build4h(candles);
  const closes4h   = candles4h.map(c => c.close);
  const ema7_4h:  number[] = closes4h.map((_, i) => ema(closes4h, i, 7));
  const ema25_4h: number[] = closes4h.map((_, i) => ema(closes4h, i, 25));

  // For each 1m candle index, find corresponding 4h index
  function get4hIndex(ts: number): number {
    const MS_4H = 4 * 60 * 60 * 1000;
    const bucket = Math.floor(ts / MS_4H) * MS_4H;
    const idx = candles4h.findIndex(c => c.time === bucket);
    return idx >= 0 ? idx : candles4h.length - 1;
  }

  function macro4hBullish(i: number): boolean {
    const idx = get4hIndex(candles[i].time);
    if (idx < 25) return false;
    return !isNaN(ema7_4h[idx]) && !isNaN(ema25_4h[idx]) && ema7_4h[idx] > ema25_4h[idx];
  }
  let cash   = CAPITAL;
  let solQty = 0;
  let pos: "flat" | "long" = "flat";
  let entryPrice = 0;
  let entryBar   = 0;
  let entryMode  = "";
  let armed      = false;
  let trades = 0, wins = 0;
  let peakEq = CAPITAL, maxDD = 0;
  const tradeLog: Trade[] = [];

  const enter = (price: number, mode: string, bar: number) => {
    solQty = (cash * (1 - FEE)) / price;
    cash = 0; entryPrice = price; entryBar = bar; entryMode = mode; pos = "long";
  };

  const exit = (price: number, reason: string, bar: number) => {
    const out    = solQty * price * (1 - FEE);
    const cost   = entryPrice * (solQty / (1 - FEE));
    const pnlPct = (out / cost - 1) * 100;
    if (out > cost) wins++;
    tradeLog.push({ entry: entryPrice, exit: price, pnlPct, mode: entryMode, reason, bars: bar - entryBar });
    cash = out; solQty = 0; pos = "flat"; trades++;
    const eq = cash;
    if (eq > peakEq) peakEq = eq;
    const dd = (peakEq - eq) / peakEq * 100;
    if (dd > maxDD) maxDD = dd;
  };

  for (let i = WARMUP; i < candles.length - 1; i++) {
    const price = closes[i];
    const r     = regime(candles, i);

    const curRsi  = rsi(closes, i);
    const prevRsi = rsi(closes, i - 1);
    const idx4h   = get4hIndex(candles[i].time);
    const macroUp = macro4hBullish(i);
    const ema7Sloping = idx4h >= 1 && !isNaN(ema7_4h[idx4h]) && !isNaN(ema7_4h[idx4h - 1]) && ema7_4h[idx4h] > ema7_4h[idx4h - 1];
    const macroDown = idx4h >= 25 && !isNaN(ema7_4h[idx4h]) && !isNaN(ema25_4h[idx4h]) && ema7_4h[idx4h] < ema25_4h[idx4h];

    // ── EXIT (Surfer logic) ────────────────────────────────────────────────
    if (pos === "long") {
      // Exit: 4h EMA bearish AND 1m RSI < 50
      if (macroDown && !isNaN(curRsi) && curRsi < 50) { exit(price, "EMA bear + RSI<50", i); continue; }
    }

    // ── ARM: RSI crossed up through 30 on 1m ──────────────────────────────
    if (!isNaN(curRsi) && !isNaN(prevRsi) && prevRsi < 30 && curRsi >= 30 && pos === "flat") {
      armed = true;
    }

    // ── FIRE: armed + 4h macro bullish + EMA7 sloping up ─────────────────
    if (pos === "flat" && armed && macroUp && ema7Sloping) {
      enter(price, "surfer", i);
      armed = false;
    }
  }

  if (pos === "long") exit(closes[closes.length - 1], "end of data", candles.length - 1);

  // ── Report ─────────────────────────────────────────────────────────────────
  const equity   = cash;
  const totalPct = (equity / CAPITAL - 1) * 100;
  const winRate  = trades > 0 ? wins / trades * 100 : 0;
  const avgWin   = tradeLog.filter(t => t.pnlPct > 0).reduce((a, t) => a + t.pnlPct, 0) / Math.max(1, wins);
  const avgLoss  = tradeLog.filter(t => t.pnlPct <= 0).reduce((a, t) => a + t.pnlPct, 0) / Math.max(1, trades - wins);
  const expect   = (winRate / 100) * avgWin + (1 - winRate / 100) * avgLoss;
  const days     = (candles[candles.length - 1].time - candles[WARMUP].time) / 86_400_000;

  const rv = tradeLog.filter(t => t.mode === "revert");
  const tr = tradeLog.filter(t => t.mode === "trend");
  const sf = tradeLog.filter(t => t.mode === "surfer");

  console.log("\n" + "═".repeat(62));
  console.log("  CHIMERA v2 (Surfer logic) — 30-DAY BACKTEST");
  console.log("═".repeat(62));
  console.log(`  Period:      ${days.toFixed(1)} days   (${candles.length - WARMUP} candles)`);
  console.log(`  Trades:      ${trades}  (${(trades/days).toFixed(1)}/day)`);
  console.log(`  Win rate:    ${winRate.toFixed(1)}%  (${wins}W / ${trades-wins}L)`);
  console.log(`  Avg win:     +${avgWin.toFixed(3)}%`);
  console.log(`  Avg loss:    ${avgLoss.toFixed(3)}%`);
  console.log(`  Expectancy:  ${expect >= 0 ? "+" : ""}${expect.toFixed(3)}% per trade`);
  console.log(`  Max DD:      -${maxDD.toFixed(2)}%`);
  console.log(`  Total P&L:   ${totalPct >= 0 ? "+" : ""}${totalPct.toFixed(3)}%  ($${equity.toFixed(2)})`);
  console.log("─".repeat(62));
  console.log(`  Mean-revert: ${rv.length} trades  WR ${rv.length > 0 ? (rv.filter(t=>t.pnlPct>0).length/rv.length*100).toFixed(0)+"%" : "—"}  PnL ${rv.reduce((a,t)=>a+t.pnlPct,0).toFixed(3)}%`);
  console.log(`  Momentum:    ${tr.length} trades  WR ${tr.length > 0 ? (tr.filter(t=>t.pnlPct>0).length/tr.length*100).toFixed(0)+"%" : "—"}  PnL ${tr.reduce((a,t)=>a+t.pnlPct,0).toFixed(3)}%`);
  console.log(`  Surfer:      ${sf.length} trades  WR ${sf.length > 0 ? (sf.filter(t=>t.pnlPct>0).length/sf.length*100).toFixed(0)+"%" : "—"}  PnL ${sf.reduce((a,t)=>a+t.pnlPct,0).toFixed(3)}%`);
  console.log("═".repeat(62));

  console.log("\n  ALL TRADES:");
  console.log("  " + ["Mode".padEnd(8), "Entry".padEnd(9), "Exit".padEnd(9), "P&L%".padEnd(10), "Bars".padEnd(6), "Reason"].join(""));
  console.log("  " + "─".repeat(62));
  for (const t of tradeLog) {
    console.log("  " + [
      t.mode.padEnd(8),
      `$${t.entry.toFixed(2)}`.padEnd(9),
      `$${t.exit.toFixed(2)}`.padEnd(9),
      `${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(3)}%`.padEnd(10),
      String(t.bars).padEnd(6),
      t.reason,
    ].join(""));
  }
  console.log("");
}

async function main() {
  const candles = await fetchCandles(44);
  await backtest(candles);
}
main().catch(console.error);
