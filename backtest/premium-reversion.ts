// US-vs-Global premium reversion — BTCUSDT, 30 days of 1m closes
// Global source: data-api.binance.vision (public market-data mirror, not geo-blocked)
// When the US price deviates from global beyond its normal band, does it revert profitably?
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US = "https://api.binance.us/api/v3";
const BASE_GL = "https://data-api.binance.vision/api/v3";
const KEY = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const ALLOC = 25;
const ENTRY_SLIP = 1.0002;

type Candle = { time: number; close: number; high: number; low: number; open: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(base: string, symbol: string, withKey: boolean): Promise<Candle[]> {
  const candles: Candle[] = [];
  let from = Date.now() - LOOKBACK_MS, end = Date.now();
  while (from < end) {
    const res = await fetch(`${base}/klines?symbol=${symbol}&interval=1m&startTime=${from}&endTime=${end}&limit=1000`,
      withKey ? { headers: { "X-MBX-APIKEY": KEY } } : undefined);
    if (res.status === 429) { await sleep(10000); continue; }
    const raw = await res.json() as any;
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) candles.push({
      time: Number(c[0]), open: parseFloat(c[1]), high: parseFloat(c[2]),
      low: parseFloat(c[3]), close: parseFloat(c[4]),
    });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(100);
  }
  return candles;
}

(async () => {
  console.log("\nPREMIUM REVERSION — BTCUSDT US vs Global | 30d | 1m closes\n");
  process.stdout.write("Fetching US... ");
  const us = await fetchKlines(BASE_US, "BTCUSDT", true);
  console.log(`${us.length}`);
  process.stdout.write("Fetching Global (data-api.binance.vision)... ");
  let gl: Candle[] = [];
  try {
    gl = await fetchKlines(BASE_GL, "BTCUSDT", false);
  } catch (e: any) {
    console.log(`FAILED: ${e.message}`);
    return;
  }
  console.log(`${gl.length}`);
  if (!gl.length) { console.log("Global mirror returned nothing — cannot test."); return; }

  const glMap = new Map(gl.map(c => [c.time, c]));
  type P = { time: number; us: Candle; spread: number };
  const pts: P[] = [];
  for (const c of us) {
    const g = glMap.get(c.time);
    if (g) pts.push({ time: c.time, us: c, spread: (g.close - c.close) / c.close });
  }
  console.log(`Aligned: ${pts.length} minutes\n`);

  // Spread distribution
  const sp = pts.map(p => p.spread).sort((a, b) => a - b);
  const pct = (q: number) => sp[Math.floor(q * sp.length)] * 100;
  const mean = sp.reduce((a, b) => a + b, 0) / sp.length * 100;
  console.log("  ── SPREAD DISTRIBUTION (global - US, % of US price) ──");
  console.log(`  mean ${mean.toFixed(4)}%  |  p1 ${pct(0.01).toFixed(4)}%  p5 ${pct(0.05).toFixed(4)}%  p50 ${pct(0.50).toFixed(4)}%  p95 ${pct(0.95).toFixed(4)}%  p99 ${pct(0.99).toFixed(4)}%`);

  // Strategy: spread blows out positive (global >> US, US is cheap) -> buy US, exit when spread normalizes or maxHold
  console.log("\n  ── SIM: buy US when spread >= T, exit when spread <= T/4 or maxHold 10m (market both ways) ──");
  console.log("  T%       Trades   /day    WR%      PnL$      Ret%   AvgHold");
  console.log("  " + "─".repeat(66));

  for (const T of [0.0005, 0.001, 0.0015, 0.002]) {
    let pnl = 0, trades = 0, wins = 0, holdSum = 0;
    let pos: { entry: number; sinceIdx: number } | null = null;
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i], next = pts[i + 1];
      if (next.time - p.time > 60000) { // gap in alignment — flatten
        if (pos) { pnl += (p.us.close / pos.entry - 1) * ALLOC; trades++; if (p.us.close >= pos.entry) wins++; holdSum += i - pos.sinceIdx; pos = null; }
        continue;
      }
      if (!pos) {
        if (p.spread >= T) pos = { entry: next.us.open * ENTRY_SLIP, sinceIdx: i };
      } else {
        const held = i - pos.sinceIdx;
        if (p.spread <= T / 4 || held >= 10) {
          const exit = next.us.open * (1 - 0.0002);
          pnl += (exit / pos.entry - 1) * ALLOC;
          trades++; if (exit >= pos.entry) wins++; holdSum += held;
          pos = null;
        }
      }
    }
    const sign = pnl >= 0 ? "+" : "";
    console.log(
      `  ${(T * 100).toFixed(2)}%` +
      `${trades}`.padStart(9) +
      `  ${(trades / 30).toFixed(1)}`.padStart(7) +
      `  ${trades ? (wins / trades * 100).toFixed(1) : "0"}%`.padStart(8) +
      `  ${sign}$${pnl.toFixed(2)}`.padStart(10) +
      `  ${sign}${(pnl / ALLOC * 100).toFixed(1)}%`.padStart(8) +
      `  ${trades ? (holdSum / trades).toFixed(1) : "-"}m`.padStart(8)
    );
  }

  // Also: forward return of US price after spread blowout (no exit rule, just look ahead)
  console.log("\n  ── FORWARD US RETURN after spread >= T (no overlap) ──");
  console.log("  T%       Events   +1m%      +3m%      +5m%      +10m%");
  console.log("  " + "─".repeat(60));
  for (const T of [0.0005, 0.001, 0.0015, 0.002]) {
    let n = 0, r1 = 0, r3 = 0, r5 = 0, r10 = 0;
    let lastEnd = -1;
    for (let i = 0; i < pts.length - 11; i++) {
      if (i <= lastEnd) continue;
      if (pts[i].spread >= T) {
        const e = pts[i].us.close;
        r1 += (pts[i + 1].us.close - e) / e;
        r3 += (pts[i + 3].us.close - e) / e;
        r5 += (pts[i + 5].us.close - e) / e;
        r10 += (pts[i + 10].us.close - e) / e;
        n++; lastEnd = i + 10;
      }
    }
    if (n === 0) { console.log(`  ${(T * 100).toFixed(2)}%        0`); continue; }
    const f = (x: number) => `${x >= 0 ? "+" : ""}${(x / n * 100).toFixed(4)}%`;
    console.log(
      `  ${(T * 100).toFixed(2)}%` +
      `${n}`.padStart(9) +
      `${f(r1)}`.padStart(10) +
      `${f(r3)}`.padStart(10) +
      `${f(r5)}`.padStart(10) +
      `${f(r10)}`.padStart(11)
    );
  }
  console.log();
})();
