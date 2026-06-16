// EMA crossover signal: fast EMA crosses above slow EMA → buy
// TP 0.20% | SL 0.10% | test multiple EMA pairs and coins | 1 week global data
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_GL  = "https://data-api.binance.vision/api/v3";
const LOOKBACK = 7 * 24 * 60 * 60 * 1000;
const TP = 0.002, SL = 0.001, MAX_HOLD = 6;
const ALLOC = 25;

const COINS    = ["BTCUSDT","XRPUSDT","SOLUSDT","DOGEUSDT","BNBUSDT"];
const EMA_PAIRS: [number, number][] = [[5,20],[9,21],[12,26],[20,50]];

type C = { t: number; o: number; h: number; l: number; c: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string): Promise<C[]> {
  const out: C[] = [];
  let from = Date.now() - LOOKBACK - 200 * 60000; // extra warmup for EMAs
  while (from < Date.now()) {
    const res = await fetch(`${BASE_GL}/klines?symbol=${symbol}&interval=1m&startTime=${from}&limit=1000`);
    if (res.status === 429) { await sleep(5000); continue; }
    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) out.push({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4] });
    from = +raw[raw.length - 1][0] + 1;
    await sleep(80);
  }
  return out;
}

function ema(candles: C[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = new Array(candles.length).fill(0);
  out[0] = candles[0].c;
  for (let i = 1; i < candles.length; i++) out[i] = candles[i].c * k + out[i - 1] * (1 - k);
  return out;
}

function sim(candles: C[], fast: number, slow: number): { win: boolean; pnl: number }[] {
  const fastEma = ema(candles, fast);
  const slowEma = ema(candles, slow);
  const trades: { win: boolean; pnl: number }[] = [];
  let i = slow + 1;
  while (i < candles.length - MAX_HOLD - 1) {
    // crossover: fast was below slow, now above
    const crossed = fastEma[i] > slowEma[i] && fastEma[i - 1] <= slowEma[i - 1];
    if (!crossed) { i++; continue; }
    const entry = candles[i + 1].o;
    const tp = entry * (1 + TP), sl = entry * (1 - SL);
    let result = "EXPIRE", hold = MAX_HOLD, exitPx = candles[i + MAX_HOLD].c;
    for (let j = i + 1; j <= i + MAX_HOLD; j++) {
      const c = candles[j];
      if (c.l <= sl) { result = "SL"; hold = j - i; exitPx = sl; break; }
      if (c.h >= tp) { result = "TP"; hold = j - i; exitPx = tp; break; }
    }
    trades.push({ win: result === "TP", pnl: (exitPx - entry) / entry * ALLOC });
    i += hold + 1;
  }
  return trades;
}

(async () => {
  console.log(`\nEMA CROSSOVER → BUY | 1 week global 1m | TP ${TP*100}% SL ${SL*100}% MAX_HOLD ${MAX_HOLD}m | $${ALLOC}\n`);
  console.log(`${"Coin".padEnd(12)} ${"EMAs".padEnd(8)} ${"Trades".padStart(7)} ${"WR%".padStart(6)} ${"PnL$".padStart(8)} ${"Ret%".padStart(8)}`);
  console.log("─".repeat(55));

  for (const coin of COINS) {
    const candles = await fetchKlines(coin);
    for (const [fast, slow] of EMA_PAIRS) {
      const trades = sim(candles, fast, slow);
      const wins = trades.filter(t => t.win).length;
      const pnl = trades.reduce((a, t) => a + t.pnl, 0);
      console.log(
        coin.padEnd(12) +
        `${fast}/${slow}`.padEnd(8) +
        String(trades.length).padStart(7) +
        (trades.length ? (wins / trades.length * 100).toFixed(0).padStart(5) + "%" : "     -") +
        (pnl >= 0 ? "+" : "") + `$${pnl.toFixed(2)}`.padStart(7) +
        (pnl >= 0 ? "+" : "") + `${(pnl / ALLOC * 100).toFixed(1)}%`.padStart(8)
      );
    }
    await sleep(150);
  }
  console.log();
})();
