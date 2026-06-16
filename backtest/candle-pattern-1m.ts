// Which 1m candle time-of-day consistently has the highest open→high % over 1 week?
// Binance global, BTC + XRP + SOL
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_GL  = "https://data-api.binance.vision/api/v3";
const LOOKBACK = 7 * 24 * 60 * 60 * 1000;
const COINS    = ["BTCUSDT", "XRPUSDT", "SOLUSDT"];

type C = { t: number; o: number; h: number; l: number; c: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string): Promise<C[]> {
  const out: C[] = [];
  let from = Date.now() - LOOKBACK;
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

function analyze(candles: C[]) {
  const byTime = new Map<string, { highs: number[]; lows: number[] }>();
  for (const c of candles) {
    const d = new Date(c.t);
    const key = `${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}`;
    const upPct  = (c.h - c.o) / c.o * 100;
    const downPct = (c.o - c.l) / c.o * 100;
    const slot = byTime.get(key) ?? { highs: [], lows: [] };
    slot.highs.push(upPct);
    slot.lows.push(downPct);
    byTime.set(key, slot);
  }
  return [...byTime.entries()].map(([time, { highs, lows }]) => ({
    time,
    avgHigh: highs.reduce((a, b) => a + b, 0) / highs.length,
    avgLow:  lows.reduce((a, b) => a + b, 0) / lows.length,
    n: highs.length,
  })).sort((a, b) => b.avgHigh - a.avgHigh);
}

(async () => {
  console.log("\nTOP 1m CANDLES by open→high % | 1 week | Binance Global\n");

  for (const coin of COINS) {
    process.stdout.write(`Fetching ${coin}...`);
    const candles = await fetchKlines(coin);
    console.log(` ${candles.length} candles`);
    const ranked = analyze(candles);
    const top = ranked.slice(0, 20);
    console.log(`\n── ${coin} TOP 20 (UTC → ET) ──`);
    console.log("UTC    ET      avg →high%   avg →low%   samples");
    for (const r of top) {
      const [h, m] = r.time.split(":").map(Number);
      const et = `${String((h - 4 + 24) % 24).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
      console.log(
        `${r.time}  ${et}    +${r.avgHigh.toFixed(3)}%`.padEnd(28) +
        `  -${r.avgLow.toFixed(3)}%`.padEnd(14) +
        `  (${r.n}x)`
      );
    }
    console.log();
    await sleep(200);
  }
})();
