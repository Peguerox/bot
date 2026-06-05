/**
 * Strategy comparison — 5m candles — ATOMUSDT — 1 year
 *
 * Strategy A: VWAP cross + Volume surge
 * Strategy B: RSI < 40 + Bollinger Band bounce
 * Strategy C: BTC pump + ATOM lag (our current bot)
 *
 * All long only, 0.1% taker fee on entry + SL exits
 *
 * Run: npx ts-node --transpile-only backtest/signal-compare-5m.ts
 */

const BASE       = "https://api.binance.us/api/v3";
const API_KEY    = process.env.BINANCE_API_KEY ?? "";
const ALLOCATION = 200;
const LOOKBACK   = 365 * 24 * 60 * 60 * 1000;
const TAKER_FEE  = 0.001;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

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
      time: Number(c[0]), open: parseFloat(c[1]), high: parseFloat(c[2]),
      low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5]),
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
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) continue;
    if (i === period - 1) { ema[i] = prices.slice(0, period).reduce((a, b) => a + b, 0) / period; continue; }
    ema[i] = prices[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function calcBB(prices: number[], period = 20, mult = 2) {
  const upper: number[] = [], middle: number[] = [], lower: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) { upper.push(NaN); middle.push(NaN); lower.push(NaN); continue; }
    const slice = prices.slice(i - period + 1, i + 1);
    const sma   = slice.reduce((a, b) => a + b, 0) / period;
    const std   = Math.sqrt(slice.reduce((a, b) => a + (b - sma) ** 2, 0) / period);
    upper.push(sma + mult * std); middle.push(sma); lower.push(sma - mult * std);
  }
  return { upper, middle, lower };
}

function calcRSI(prices: number[], period = 14): number[] {
  const rsi: number[] = new Array(prices.length).fill(NaN);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < prices.length; i++) {
    const d    = prices[i] - prices[i - 1];
    avgGain    = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss    = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    rsi[i]     = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function calcVWAP(candles: Candle[]): number[] {
  const vwap: number[] = [];
  let cumPV = 0, cumVol = 0, lastDay = -1;
  for (const c of candles) {
    const day = Math.floor(c.time / 86_400_000);
    if (day !== lastDay) { cumPV = 0; cumVol = 0; lastDay = day; }
    const tp = (c.high + c.low + c.close) / 3;
    cumPV += tp * c.volume; cumVol += c.volume;
    vwap.push(cumVol > 0 ? cumPV / cumVol : c.close);
  }
  return vwap;
}

function volAvg(volumes: number[], i: number, period = 20): number {
  if (i < period - 1) return NaN;
  return volumes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
}

function swingLow(candles: Candle[], i: number, look = 10): number {
  return Math.min(...candles.slice(Math.max(0, i - look), i).map(c => c.low));
}

// ── Result type ───────────────────────────────────────────────────────────────

type Result = { pnl: number; total: number; wins: number; losses: number };

function result(pnl: number, wins: number, losses: number): Result {
  return { pnl, total: wins + losses, wins, losses };
}

// ── Strategy A: VWAP cross + Volume surge ────────────────────────────────────

function stratA(candles: Candle[]): Result {
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const vwap    = calcVWAP(candles);
  const bb      = calcBB(closes);

  let pnl = 0, wins = 0, losses = 0;
  let pos: { entry: number; sl: number; tp: number; qty: number } | null = null;

  for (let i = 21; i < candles.length; i++) {
    const c = candles[i];

    if (pos) {
      const hitTP = c.high >= pos.tp;
      const hitSL = c.low  <= pos.sl;
      if (hitTP && hitSL) {
        pnl += (pos.sl - pos.entry) * pos.qty; losses++;
      } else if (hitTP) {
        pnl += (pos.tp - pos.entry) * pos.qty; wins++;
      } else if (hitSL) {
        pnl += (pos.sl - pos.entry) * pos.qty * (1 - TAKER_FEE); losses++;
      } else continue;
      pos = null; continue;
    }

    const prevClose = candles[i - 1].close;
    const curVWAP   = vwap[i];
    const va        = volAvg(volumes, i);
    if (isNaN(va) || isNaN(bb.upper[i])) continue;

    // Price crosses above VWAP from below + volume 2x average
    const vwapCross  = prevClose < vwap[i - 1] && c.close > curVWAP;
    const volSurge   = c.volume > va * 2;

    if (vwapCross && volSurge) {
      const entry = c.close * (1 + TAKER_FEE);
      const sl    = Math.min(swingLow(candles, i), curVWAP * 0.999); // below VWAP
      const tp    = bb.upper[i];
      if (sl >= entry || tp <= entry) continue;
      pos = { entry, sl, tp, qty: ALLOCATION / entry };
    }
  }

  return result(pnl, wins, losses);
}

// ── Strategy B: RSI < 40 + Bollinger Band bounce ─────────────────────────────

function stratB(candles: Candle[]): Result {
  const closes = candles.map(c => c.close);
  const bb     = calcBB(closes);
  const rsi    = calcRSI(closes);

  let pnl = 0, wins = 0, losses = 0;
  let pos: { entry: number; sl: number; tp: number; qty: number } | null = null;

  const START = 21;
  for (let i = START; i < candles.length; i++) {
    const c = candles[i];

    if (pos) {
      const hitTP = c.high >= pos.tp;
      const hitSL = c.low  <= pos.sl;
      if (hitTP && hitSL) {
        pnl += (pos.sl - pos.entry) * pos.qty; losses++;
      } else if (hitTP) {
        pnl += (pos.tp - pos.entry) * pos.qty; wins++;
      } else if (hitSL) {
        pnl += (pos.sl - pos.entry) * pos.qty * (1 - TAKER_FEE); losses++;
      } else continue;
      pos = null; continue;
    }

    if (isNaN(bb.lower[i]) || isNaN(rsi[i])) continue;

    const prevBelowBB = candles[i - 1].close < bb.lower[i - 1];
    const backInside  = c.close > bb.lower[i];
    const rsiOK       = rsi[i] < 40;

    if (prevBelowBB && backInside && rsiOK) {
      const entry = c.close * (1 + TAKER_FEE);
      const sl    = swingLow(candles, i);
      const tp    = bb.middle[i];
      if (sl >= entry || tp <= entry) continue;
      pos = { entry, sl, tp, qty: ALLOCATION / entry };
    }
  }

  return result(pnl, wins, losses);
}

// ── Strategy C: BTC pump + ATOM lag (existing bot) ───────────────────────────

async function stratC(atomCandles: Candle[], startMs: number, endMs: number): Promise<Result> {
  const btcCandles = await fetchKlines("BTCUSDT", startMs, endMs);
  const btcMap     = new Map(btcCandles.map(c => [c.time, c]));

  const BTC_THRESH  = 0.002;   // BTC > 0.2%
  const ATOM_THRESH = 0.001;   // ATOM < 0.1%
  const TP_PCT      = 0.010;   // 1% TP
  const SL_PCT      = 0.003;   // 0.3% SL
  const CHASE       = 0.0005;
  const MAX_HOLD    = 6;       // 30 min

  let pnl = 0, wins = 0, losses = 0;
  let pos: { entry: number; tp: number; sl: number; hold: number; chasing: boolean } | null = null;

  for (let i = 1; i < atomCandles.length; i++) {
    const atom = atomCandles[i];
    const btc  = btcMap.get(atom.time);
    if (!btc) continue;

    if (pos) {
      if (pos.chasing) {
        if (atom.close <= pos.sl) {
          pnl += (pos.sl - pos.entry) / pos.entry * ALLOCATION; losses++;
          pos = null;
        } else {
          pnl += (atom.close * (1 - CHASE) - pos.entry) / pos.entry * ALLOCATION;
          wins += atom.close * (1 - CHASE) > pos.entry ? 1 : 0;
          losses += atom.close * (1 - CHASE) <= pos.entry ? 1 : 0;
          pos = null;
        }
        continue;
      }
      pos.hold++;
      if (atom.close >= pos.tp) {
        pnl += (pos.tp - pos.entry) / pos.entry * ALLOCATION; wins++; pos = null;
      } else if (atom.close <= pos.sl) {
        pnl += (pos.sl - pos.entry) / pos.entry * ALLOCATION; losses++; pos = null;
      } else if (pos.hold >= MAX_HOLD) {
        pos.chasing = true;
      }
      continue;
    }

    const btcRet  = (btc.close  - btcCandles[btcCandles.indexOf(btcMap.get(atomCandles[i-1].time)!)]).close / btcCandles[btcCandles.indexOf(btcMap.get(atomCandles[i-1].time)!)].close;
    const atomRet = (atom.close - atomCandles[i - 1].close) / atomCandles[i - 1].close;

    if (btcRet > BTC_THRESH && atomRet < ATOM_THRESH) {
      const entry = atom.close * (1 + TAKER_FEE);
      pos = { entry, tp: entry * (1 + TP_PCT), sl: entry * (1 - SL_PCT), hold: 0, chasing: false };
    }
  }

  return result(pnl, wins, losses);
}

// ── Main ──────────────────────────────────────────────────────────────────────

function print(name: string, r: Result) {
  const total = r.wins + r.losses;
  const wr    = total > 0 ? (r.wins / total * 100).toFixed(1) : "0.0";
  const sign  = r.pnl >= 0 ? "+" : "";
  console.log(`  ${name.padEnd(30)} Trades: ${String(total).padEnd(5)} WR: ${wr.padEnd(6)}% PnL: ${sign}$${r.pnl.toFixed(2).padEnd(8)}  Balance: $${(ALLOCATION + r.pnl).toFixed(2)}`);
}

async function main() {
  const now     = Date.now();
  const startMs = now - LOOKBACK;

  console.log("\nFetching ATOM 5m candles...");
  const atomCandles = await fetchKlines("ATOMUSDT", startMs, now);
  console.log(`  ${atomCandles.length} candles\n`);

  console.log("Running strategies...");
  const [rA, rB] = [stratA(atomCandles), stratB(atomCandles)];

  console.log("Fetching BTC for strategy C...");
  const rC = await stratC(atomCandles, startMs, now);

  console.log(`\n${"═".repeat(72)}`);
  console.log(`  Strategy comparison — ATOM 5m — $${ALLOCATION} — 1 year — 0.1% fee`);
  console.log(`${"═".repeat(72)}`);
  print("A: VWAP cross + Volume 2x", rA);
  print("B: RSI < 40 + BB bounce",   rB);
  print("C: BTC pump + ATOM lag",    rC);
  console.log(`${"═".repeat(72)}\n`);
}

main().catch(console.error);
