/**
 * VWAP + 200 EMA + Bollinger Bands + RSI — Long only — 5m candles
 *
 * Entry: Price > VWAP AND Price > EMA200 AND RSI < 35
 *        AND prev candle closed below lower BB
 *        AND current candle closes back inside BB (above lower BB)
 *        AND volume > 20-period avg volume
 *
 * Exit:  TP = middle BB  |  SL = lowest low of last 10 candles
 * Fees:  0.1% taker on entry + SL exits, 0% on TP
 *
 * Run: npx ts-node --transpile-only backtest/vwap-bb-rsi-5m.ts
 */

const BASE       = "https://api.binance.us/api/v3";
const API_KEY    = process.env.BINANCE_API_KEY ?? "";
const ALLOCATION = 200;
const LOOKBACK   = 365 * 24 * 60 * 60 * 1000; // 1 year
const TAKER_FEE  = 0.001; // 0.1%

const SYMBOL     = "ATOMUSDT";
const EMA_PERIOD = 200;
const BB_PERIOD  = 20;
const BB_STDDEV  = 2;
const RSI_PERIOD = 14;
const RSI_ENTRY  = 35;
const SWING_LOOK = 10;  // candles back for swing low SL
const VOL_PERIOD = 20;  // volume avg period

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

type Candle = {
  time:   number;
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
};

async function fetchKlines(symbol: string, startMs: number, endMs: number): Promise<Candle[]> {
  const candles: Candle[] = [];
  let from = startMs;
  while (from < endMs) {
    const url = `${BASE}/klines?symbol=${symbol}&interval=5m&startTime=${from}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url, { headers: { "X-MBX-APIKEY": API_KEY } });
    if (res.status === 429) { await sleep(10_000); continue; }
    if (!res.ok) throw new Error(`${res.status}`);
    const raw = await res.json() as string[][];
    if (!raw.length) break;
    for (const c of raw) candles.push({
      time:   Number(c[0]),
      open:   parseFloat(c[1]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5]),
    });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(100);
  }
  return candles;
}

// ── Indicators ────────────────────────────────────────────────────────────────

function calcEMA(prices: number[], period: number): number[] {
  const ema: number[] = new Array(prices.length).fill(NaN);
  const k = 2 / (period + 1);
  let started = false;
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) continue;
    if (!started) {
      ema[i] = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
      started = true;
    } else {
      ema[i] = prices[i] * k + ema[i - 1] * (1 - k);
    }
  }
  return ema;
}

function calcBB(prices: number[], period: number, mult: number) {
  const upper: number[] = [], middle: number[] = [], lower: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) { upper.push(NaN); middle.push(NaN); lower.push(NaN); continue; }
    const slice = prices.slice(i - period + 1, i + 1);
    const sma   = slice.reduce((a, b) => a + b, 0) / period;
    const std   = Math.sqrt(slice.reduce((a, b) => a + (b - sma) ** 2, 0) / period);
    upper.push(sma + mult * std);
    middle.push(sma);
    lower.push(sma - mult * std);
  }
  return { upper, middle, lower };
}

function calcRSI(prices: number[], period: number): number[] {
  const rsi: number[] = new Array(prices.length).fill(NaN);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss === 0) { rsi[period] = 100; }
  else { const rs = avgGain / avgLoss; rsi[period] = 100 - 100 / (1 + rs); }

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    if (avgLoss === 0) { rsi[i] = 100; }
    else { const rs = avgGain / avgLoss; rsi[i] = 100 - 100 / (1 + rs); }
  }
  return rsi;
}

// VWAP resets at midnight UTC each day
function calcVWAP(candles: Candle[]): number[] {
  const vwap: number[] = [];
  let cumPV = 0, cumVol = 0;
  let lastDay = -1;

  for (const c of candles) {
    const day = Math.floor(c.time / 86_400_000);
    if (day !== lastDay) { cumPV = 0; cumVol = 0; lastDay = day; }
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumPV  += typicalPrice * c.volume;
    cumVol += c.volume;
    vwap.push(cumVol > 0 ? cumPV / cumVol : c.close);
  }
  return vwap;
}

function calcVolAvg(volumes: number[], period: number): number[] {
  const avg: number[] = [];
  for (let i = 0; i < volumes.length; i++) {
    if (i < period - 1) { avg.push(NaN); continue; }
    avg.push(volumes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
  }
  return avg;
}

function swingLow(candles: Candle[], upToIdx: number, lookback: number): number {
  const start = Math.max(0, upToIdx - lookback);
  return Math.min(...candles.slice(start, upToIdx).map(c => c.low));
}

// ── Backtest ──────────────────────────────────────────────────────────────────

function runBacktest(candles: Candle[]) {
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const ema200  = calcEMA(closes, EMA_PERIOD);
  const bb      = calcBB(closes, BB_PERIOD, BB_STDDEV);
  const rsi     = calcRSI(closes, RSI_PERIOD);
  const vwap    = calcVWAP(candles);
  const volAvg  = calcVolAvg(volumes, VOL_PERIOD);

  let pnl = 0, wins = 0, losses = 0;
  let pos: { entry: number; sl: number; qty: number } | null = null;

  const START = Math.max(EMA_PERIOD, BB_PERIOD, RSI_PERIOD, VOL_PERIOD, SWING_LOOK) + 1;

  for (let i = START; i < candles.length; i++) {
    const c    = candles[i];
    const prev = candles[i - 1];

    // ── Manage open position ────────────────────────────────────────────────
    if (pos) {
      const midBB = bb.middle[i];
      const hitTP = !isNaN(midBB) && c.high >= midBB;   // intra-candle TP fill
      const hitSL = c.low <= pos.sl;

      if (hitTP && hitSL) {
        // Both triggered — whichever came first is unknown, assume SL (conservative)
        const tradePnl = (pos.sl - pos.entry) * pos.qty * (1 - TAKER_FEE);
        pnl += tradePnl;
        losses++;
        pos = null;
      } else if (hitTP) {
        const exitPrice = midBB;
        const tradePnl  = (exitPrice - pos.entry) * pos.qty; // limit order, no fee
        pnl += tradePnl;
        wins++;
        pos = null;
      } else if (hitSL) {
        const tradePnl = (pos.sl - pos.entry) * pos.qty * (1 - TAKER_FEE);
        pnl += tradePnl;
        losses++;
        pos = null;
      }
      continue;
    }

    // ── Check entry signal ──────────────────────────────────────────────────
    const lowerBB     = bb.lower[i];
    const prevLowerBB = bb.lower[i - 1];
    const midBB       = bb.middle[i];

    if (isNaN(ema200[i]) || isNaN(lowerBB) || isNaN(rsi[i]) || isNaN(vwap[i]) || isNaN(volAvg[i])) continue;

    const aboveEMA   = c.close   > ema200[i];
    const aboveVWAP  = c.close   > vwap[i];
    const rsiOK      = rsi[i]    < RSI_ENTRY;
    const volOK      = c.volume  > volAvg[i];
    const prevBelowBB = prev.close < prevLowerBB;   // prev candle closed below lower BB
    const backInside  = c.close   > lowerBB;         // current closed back inside

    if (aboveEMA && aboveVWAP && rsiOK && volOK && prevBelowBB && backInside) {
      const entry = c.close * (1 + TAKER_FEE);        // taker fill on entry
      const sl    = swingLow(candles, i, SWING_LOOK);
      if (sl >= entry) continue;                        // no room for SL
      const qty   = ALLOCATION / entry;
      pos = { entry, sl, qty };
    }
  }

  const total = wins + losses;
  const wr    = total > 0 ? (wins / total * 100).toFixed(1) : "0.0";
  const avgPnl = total > 0 ? (pnl / total).toFixed(3) : "0.000";
  return { pnl, total, wins, losses, wr, avgPnl };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const now     = Date.now();
  const startMs = now - LOOKBACK;

  console.log(`\nFetching ${SYMBOL} 5m candles (last 1 year)...`);
  const candles = await fetchKlines(SYMBOL, startMs, now);
  console.log(`  ${candles.length} candles loaded\n`);

  const r = runBacktest(candles);

  console.log(`${"═".repeat(60)}`);
  console.log(`  VWAP + EMA200 + BB + RSI — Long only — 5m — 1 year`);
  console.log(`  ${SYMBOL}  $${ALLOCATION} allocation  0.1% taker fee`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Trades    : ${r.total}  (Winning: ${r.wins}  Losing: ${r.losses})`);
  console.log(`  Win rate  : ${r.wr}%`);
  console.log(`  Avg PnL   : $${r.avgPnl} / trade`);
  console.log(`  Total PnL : $${r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(2)}`);
  console.log(`  Balance   : $${(ALLOCATION + r.pnl).toFixed(2)}`);
  console.log(`${"═".repeat(60)}\n`);
}

main().catch(console.error);
