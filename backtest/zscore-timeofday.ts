/**
 * Z-Score Time-of-Day Analysis
 * Same strategy (TP=0.8%, SL=0.3%, hold=6, 1m) but broken down by hour
 * Shows which hours are profitable and which to avoid
 * EDT = UTC-4 (May = daylight saving active)
 *
 * Run: npx ts-node --transpile-only backtest/zscore-timeofday.ts
 */

const BINANCE_BASE = "https://api.binance.us/api/v3";
const BINANCE_KEY  = process.env.BINANCE_API_KEY ?? "";

const CORR_WINDOW  = 20;
const Z_THRESH     = 2.0;
const TP_PCT       = 0.008;
const SL_PCT       = 0.003;
const MAX_HOLD     = 6;
const ALLOCATION   = 1000;
const LOOKBACK_MS  = 180 * 24 * 60 * 60 * 1000; // 6 months
const UTC_OFFSET   = -4; // EDT (May, daylight saving)

const PAIRS = [
  { symbol: "BNBUSDT",  name: "BNB"  },
  { symbol: "ATOMUSDT", name: "ATOM" },
];

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAllKlines(symbol: string, interval: string, startMs: number, endMs: number) {
  const candles: { time: number; close: number }[] = [];
  let from = startMs;
  while (from < endMs) {
    const url = `${BINANCE_BASE}/klines?symbol=${symbol}&interval=${interval}` +
                `&startTime=${from}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url, { headers: { "X-MBX-APIKEY": BINANCE_KEY } });
    if (res.status === 429) { await sleep(10_000); continue; }
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const raw = await res.json() as string[][];
    if (!raw.length) break;
    for (const c of raw) candles.push({ time: Number(c[0]), close: parseFloat(c[4]) });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(120);
  }
  return candles;
}

function getHourLocal(utcMs: number): number {
  const utcHour = Math.floor(utcMs / 3_600_000) % 24;
  return ((utcHour + UTC_OFFSET) + 24) % 24;
}

function calcZScore(btcCloses: number[], altCloses: number[], upToIdx: number): number {
  if (upToIdx < CORR_WINDOW + 1) return 0;
  const spreads: number[] = [];
  for (let i = upToIdx - CORR_WINDOW; i <= upToIdx; i++) {
    spreads.push(Math.log(altCloses[i] / altCloses[i-1]) - Math.log(btcCloses[i] / btcCloses[i-1]));
  }
  if (spreads.length < CORR_WINDOW) return 0;
  const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const std  = Math.sqrt(spreads.reduce((a, b) => a + (b - mean) ** 2, 0) / spreads.length);
  if (std === 0) return 0;
  return (spreads[spreads.length - 1] - mean) / std;
}

interface HourStats {
  pnl: number; wins: number; losses: number; expires: number;
  grossWin: number; grossLoss: number;
}

function runBacktest(
  btcTimes: number[], btcCloses: number[], altCloses: number[],
  allowedHours: Set<number> | null // null = all hours
): { byHour: HourStats[]; total: HourStats } {
  const byHour: HourStats[] = Array.from({ length: 24 }, () =>
    ({ pnl: 0, wins: 0, losses: 0, expires: 0, grossWin: 0, grossLoss: 0 })
  );

  let pos: { entry: number; sl: number; tp: number; openHour: number } | null = null;

  for (let i = CORR_WINDOW + 1; i < btcCloses.length; i++) {
    const price = altCloses[i];
    const hour  = getHourLocal(btcTimes[i]);

    if (pos) {
      const holdCount = i - (i - MAX_HOLD); // track via hold logic below
      // We track hold differently — use a hold counter
    }

    // Simpler: track hold count directly
    // Re-implement with hold counter
    break;
  }

  // Cleaner implementation with hold counter
  let pos2: { entry: number; sl: number; tp: number; hold: number; openHour: number } | null = null;
  const total: HourStats = { pnl: 0, wins: 0, losses: 0, expires: 0, grossWin: 0, grossLoss: 0 };

  for (let i = CORR_WINDOW + 1; i < btcCloses.length; i++) {
    const price = altCloses[i];
    const hour  = getHourLocal(btcTimes[i]);

    if (pos2) {
      pos2.hold++;
      const hitTP  = price >= pos2.tp;
      const hitSL  = price <= pos2.sl;
      const expired = pos2.hold >= MAX_HOLD;

      if (hitTP || hitSL || expired) {
        const exitPrice = hitTP ? pos2.tp : hitSL ? pos2.sl : price;
        const tradePnl  = (exitPrice - pos2.entry) / pos2.entry * ALLOCATION;
        const h         = pos2.openHour;

        byHour[h].pnl += tradePnl;
        total.pnl      += tradePnl;

        if (hitTP) {
          byHour[h].wins++;    byHour[h].grossWin  += tradePnl;
          total.wins++;        total.grossWin       += tradePnl;
        } else if (hitSL) {
          byHour[h].losses++;  byHour[h].grossLoss += Math.abs(tradePnl);
          total.losses++;      total.grossLoss      += Math.abs(tradePnl);
        } else {
          byHour[h].expires++;
          total.expires++;
          if (tradePnl > 0) { byHour[h].grossWin += tradePnl; total.grossWin += tradePnl; }
          else              { byHour[h].grossLoss += Math.abs(tradePnl); total.grossLoss += Math.abs(tradePnl); }
        }
        pos2 = null;
      }
    }

    if (!pos2) {
      // Only enter if this hour is allowed
      if (allowedHours !== null && !allowedHours.has(hour)) continue;
      const z = calcZScore(btcCloses, altCloses, i);
      if (z <= -Z_THRESH) {
        pos2 = { entry: price, sl: price * (1 - SL_PCT), tp: price * (1 + TP_PCT), hold: 0, openHour: hour };
      }
    }
  }

  return { byHour, total };
}

function fmtHour(h: number): string {
  const ampm = h < 12 ? "am" : "pm";
  const h12  = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}${ampm}`;
}

async function main() {
  const now = Date.now(), startMs = now - LOOKBACK_MS;

  process.stdout.write("Fetching 1m data (6 months)...\n");
  const btcCandles = await fetchAllKlines("BTCUSDT", "1m", startMs, now);
  process.stdout.write(`  BTC: ${btcCandles.length} candles\n`);

  const pairData: { name: string; btcTimes: number[]; btcArr: number[]; altArr: number[] }[] = [];

  for (const pair of PAIRS) {
    const alt = await fetchAllKlines(pair.symbol, "1m", startMs, now);
    process.stdout.write(`  ${pair.symbol}: ${alt.length} candles\n`);
    const altMap = new Map(alt.map(c => [c.time, c.close]));
    const btcTimes: number[] = [], btcArr: number[] = [], altArr: number[] = [];
    for (const c of btcCandles) {
      const ac = altMap.get(c.time);
      if (ac !== undefined) { btcTimes.push(c.time); btcArr.push(c.close); altArr.push(ac); }
    }
    pairData.push({ name: pair.name, btcTimes, btcArr, altArr });
  }

  // ── Per-hour breakdown ────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(72)}`);
  console.log(`Hour-by-hour breakdown (EDT) — combined BNB+ATOM, TP=0.8% SL=0.3% hold=6`);
  console.log(`${"─".repeat(72)}`);
  console.log(`${"Hour (EDT)".padEnd(12)} ${"Trades".padStart(7)} ${"Win%".padStart(6)} ${"PF".padStart(5)} ${"PnL($)".padStart(9)}  Signal`);
  console.log(`${"─".repeat(72)}`);

  // Combine BNB+ATOM by hour
  const combinedByHour: HourStats[] = Array.from({ length: 24 }, () =>
    ({ pnl: 0, wins: 0, losses: 0, expires: 0, grossWin: 0, grossLoss: 0 })
  );

  for (const { name, btcTimes, btcArr, altArr } of pairData) {
    const { byHour } = runBacktest(btcTimes, btcArr, altArr, null);
    for (let h = 0; h < 24; h++) {
      combinedByHour[h].pnl      += byHour[h].pnl;
      combinedByHour[h].wins     += byHour[h].wins;
      combinedByHour[h].losses   += byHour[h].losses;
      combinedByHour[h].expires  += byHour[h].expires;
      combinedByHour[h].grossWin += byHour[h].grossWin;
      combinedByHour[h].grossLoss+= byHour[h].grossLoss;
    }
  }

  for (let h = 0; h < 24; h++) {
    const s      = combinedByHour[h];
    const trades = s.wins + s.losses + s.expires;
    const wr     = trades > 0 ? (s.wins / trades * 100).toFixed(1) : "—";
    const pf     = s.grossLoss > 0 ? (s.grossWin / s.grossLoss).toFixed(2) : s.grossWin > 0 ? "∞" : "—";
    const signal = s.pnl > 50  ? "✓✓ Strong" :
                   s.pnl > 10  ? "✓  Good"   :
                   s.pnl > -10 ? "~  Flat"   :
                   s.pnl > -50 ? "✗  Weak"   : "✗✗ Avoid";
    const pnlStr = `${s.pnl >= 0 ? "+" : ""}${s.pnl.toFixed(0)}`;
    console.log(
      `${fmtHour(h).padEnd(6)}–${fmtHour((h+1)%24).padEnd(5)} ` +
      `${String(trades).padStart(7)} ${`${wr}%`.padStart(6)} ${pf.padStart(5)} ${pnlStr.padStart(9)}  ${signal}`
    );
  }

  // ── Best window combinations ──────────────────────────────────────────────
  const profitableHours = new Set(
    Array.from({ length: 24 }, (_, h) => h).filter(h => combinedByHour[h].pnl > 0)
  );

  const testWindows: { label: string; hours: Set<number> }[] = [
    { label: "All hours (baseline)",      hours: new Set(Array.from({length:24},(_,i)=>i)) },
    { label: "NY open (8–10am EDT)",       hours: new Set([8,9]) },
    { label: "NY session (8am–4pm EDT)",   hours: new Set([8,9,10,11,12,13,14,15]) },
    { label: "London close (2–4pm EDT)",   hours: new Set([14,15]) },
    { label: "Avoid dead zone (skip 3–7am EDT)", hours: new Set([...Array.from({length:24},(_,i)=>i)].filter(h=>h<3||h>6)) },
    { label: "Profitable hours only",      hours: profitableHours },
    { label: "Skip 3am–8am EDT",           hours: new Set([...Array.from({length:24},(_,i)=>i)].filter(h=>h<3||h>=8)) },
  ];

  console.log(`\n${"─".repeat(72)}`);
  console.log(`Time window comparison — combined BNB+ATOM`);
  console.log(`${"─".repeat(72)}`);
  console.log(`${"Window".padEnd(38)} ${"Trades".padStart(7)} ${"Win%".padStart(6)} ${"PF".padStart(5)} ${"PnL($)".padStart(9)}`);
  console.log(`${"─".repeat(72)}`);

  for (const { label, hours } of testWindows) {
    let totalPnl = 0, totalWins = 0, totalLosses = 0, totalExpires = 0;
    let totalGW = 0, totalGL = 0;

    for (const { btcTimes, btcArr, altArr } of pairData) {
      const { total } = runBacktest(btcTimes, btcArr, altArr, hours);
      totalPnl     += total.pnl;
      totalWins    += total.wins;
      totalLosses  += total.losses;
      totalExpires += total.expires;
      totalGW      += total.grossWin;
      totalGL      += total.grossLoss;
    }

    const trades = totalWins + totalLosses + totalExpires;
    const wr     = trades > 0 ? (totalWins / trades * 100).toFixed(1) : "—";
    const pf     = totalGL > 0 ? (totalGW / totalGL).toFixed(2) : totalGW > 0 ? "∞" : "—";
    const pnlStr = `${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}`;
    console.log(
      `${label.padEnd(38)} ${String(trades).padStart(7)} ${`${wr}%`.padStart(6)} ${pf.padStart(5)} ${pnlStr.padStart(9)}`
    );
  }

  console.log(`\nNote: profitable hours = ${[...profitableHours].sort((a,b)=>a-b).map(fmtHour).join(", ")} EDT`);
}

main().catch(console.error);
