/**
 * Accumulator Time-of-Day Analysis
 * Tests whether restricting switches to certain hours improves BTC accumulation
 * Strategy: BB(10) on BTCUSDT 5m — hold SOL when uptrend, BTC when downtrend
 * EDT = UTC-4 (May = daylight saving)
 *
 * Run: npx ts-node --transpile-only backtest/accumulator-timeofday.ts
 */

const BINANCE_BASE = "https://api.binance.us/api/v3";
const BINANCE_KEY  = process.env.BINANCE_API_KEY ?? "";

const BB_PERIOD    = 10;
const UTC_OFFSET   = -4; // EDT
const LOOKBACK_MS  = 365 * 24 * 60 * 60 * 1000; // 1 year (same as original accumulator backtest)
const START_BTC    = 0.013557; // actual starting BTC (what the live bot started with)

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

function getHourEDT(utcMs: number): number {
  return (Math.floor(utcMs / 3_600_000) % 24 + UTC_OFFSET + 24) % 24;
}

function getBBSignal(closes: number[], upToIdx: number): boolean {
  if (upToIdx < BB_PERIOD) return false;
  const window = closes.slice(upToIdx - BB_PERIOD + 1, upToIdx + 1);
  const mean   = window.reduce((a, b) => a + b, 0) / BB_PERIOD;
  return closes[upToIdx] > mean; // true = uptrend = hold SOL
}

interface AccResult {
  finalBtc:  number;
  gainBtc:   number;
  gainPct:   number;
  switches:  number;
  byHour:    { switches: number; gainBtc: number }[];
}

function runAccumulator(
  btcCandles: { time: number; close: number }[],
  solBtcCandles: { time: number; close: number }[],
  allowedHours: Set<number> | null
): AccResult {
  // Align by time
  const solMap = new Map(solBtcCandles.map(c => [c.time, c.close]));
  const aligned: { time: number; btcClose: number; solBtcPrice: number }[] = [];
  for (const c of btcCandles) {
    const sp = solMap.get(c.time);
    if (sp !== undefined) aligned.push({ time: c.time, btcClose: c.close, solBtcPrice: sp });
  }

  const btcCloses = aligned.map(c => c.btcClose);
  let holding: "BTC" | "SOL" = "BTC";
  let quantity = START_BTC; // start with BTC
  let btcValue = START_BTC;
  let switches = 0;
  const byHour = Array.from({ length: 24 }, () => ({ switches: 0, gainBtc: 0 }));

  for (let i = BB_PERIOD; i < aligned.length; i++) {
    const { time, solBtcPrice } = aligned[i];
    const uptrend    = getBBSignal(btcCloses, i);
    const target     = uptrend ? "SOL" : "BTC";
    const hour       = getHourEDT(time);

    // Update mark-to-market BTC value
    btcValue = holding === "BTC" ? quantity : quantity * solBtcPrice;

    if (target !== holding) {
      // Switch blocked by time filter?
      if (allowedHours !== null && !allowedHours.has(hour)) continue;

      const btcBefore = btcValue;
      let newQty: number, newBtcVal: number;

      if (target === "SOL") {
        newQty    = quantity / solBtcPrice;
        newBtcVal = quantity;
      } else {
        newQty    = quantity * solBtcPrice;
        newBtcVal = newQty;
      }

      byHour[hour].switches++;
      byHour[hour].gainBtc += newBtcVal - btcBefore;

      holding  = target;
      quantity = newQty;
      btcValue = newBtcVal;
      switches++;
    }
  }

  // Final BTC value
  const lastSolBtc = aligned[aligned.length - 1].solBtcPrice;
  const finalBtc   = holding === "BTC" ? quantity : quantity * lastSolBtc;

  return {
    finalBtc,
    gainBtc: finalBtc - START_BTC,
    gainPct: (finalBtc - START_BTC) / START_BTC * 100,
    switches,
    byHour,
  };
}

function fmtHour(h: number): string {
  const ampm = h < 12 ? "am" : "pm";
  const h12  = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}${ampm}`;
}

async function main() {
  const now = Date.now(), startMs = now - LOOKBACK_MS;

  process.stdout.write("Fetching 5m data (1 year)...\n");
  const btcCandles    = await fetchAllKlines("BTCUSDT",  "5m", startMs, now);
  const solBtcCandles = await fetchAllKlines("SOLBTC",   "5m", startMs, now);
  process.stdout.write(`  BTC: ${btcCandles.length} candles | SOLBTC: ${solBtcCandles.length} candles\n\n`);

  // ── Baseline (all hours) ────────────────────────────────────────────────────
  const baseline = runAccumulator(btcCandles, solBtcCandles, null);
  console.log(`Baseline (all hours): ${baseline.finalBtc.toFixed(6)} BTC | ` +
    `${baseline.gainBtc >= 0 ? "+" : ""}${baseline.gainBtc.toFixed(6)} BTC gain ` +
    `(${baseline.gainPct >= 0 ? "+" : ""}${baseline.gainPct.toFixed(2)}%) | ${baseline.switches} switches\n`);

  // ── Per-hour switch breakdown ───────────────────────────────────────────────
  console.log(`${"─".repeat(60)}`);
  console.log(`Switch profitability by hour (EDT) — which hours earn BTC?`);
  console.log(`${"─".repeat(60)}`);
  console.log(`${"Hour (EDT)".padEnd(14)} ${"Switches".padStart(8)} ${"BTC Gain".padStart(12)}  Signal`);
  console.log(`${"─".repeat(60)}`);

  for (let h = 0; h < 24; h++) {
    const s       = baseline.byHour[h];
    if (s.switches === 0) continue;
    const gainStr = `${s.gainBtc >= 0 ? "+" : ""}${s.gainBtc.toFixed(6)}`;
    const signal  = s.gainBtc > 0.0005 ? "✓✓ Strong" :
                    s.gainBtc > 0      ? "✓  Positive" :
                    s.gainBtc > -0.0005? "~  Flat"   : "✗  Avoid";
    console.log(`${fmtHour(h).padEnd(6)}–${fmtHour((h+1)%24).padEnd(7)} ${String(s.switches).padStart(8)} ${gainStr.padStart(12)}  ${signal}`);
  }

  // ── Time window comparison ──────────────────────────────────────────────────
  const profitableHours = new Set(
    Array.from({ length: 24 }, (_, h) => h)
      .filter(h => baseline.byHour[h].switches > 0 && baseline.byHour[h].gainBtc > 0)
  );

  const windows: { label: string; hours: Set<number> | null }[] = [
    { label: "All hours (baseline)",         hours: null },
    { label: "NY session (8am–4pm EDT)",     hours: new Set([8,9,10,11,12,13,14,15]) },
    { label: "Avoid dead zone (skip 3–7am)", hours: new Set([...Array.from({length:24},(_,i)=>i)].filter(h=>h<3||h>6)) },
    { label: "Only profitable hours",        hours: profitableHours },
    { label: "Asian session (8pm–2am EDT)",  hours: new Set([20,21,22,23,0,1]) },
    { label: "24/7 no restriction",          hours: null },
  ];

  console.log(`\n${"─".repeat(65)}`);
  console.log(`Time window comparison — how does restricting switch hours affect BTC gain?`);
  console.log(`${"─".repeat(65)}`);
  console.log(`${"Window".padEnd(38)} ${"Switches".padStart(8)} ${"Final BTC".padStart(10)} ${"Gain%".padStart(7)}`);
  console.log(`${"─".repeat(65)}`);

  for (const { label, hours } of windows) {
    const r       = runAccumulator(btcCandles, solBtcCandles, hours);
    const gainStr = `${r.gainPct >= 0 ? "+" : ""}${r.gainPct.toFixed(2)}%`;
    console.log(`${label.padEnd(38)} ${String(r.switches).padStart(8)} ${r.finalBtc.toFixed(6).padStart(10)} ${gainStr.padStart(7)}`);
  }

  console.log(`\nProfitable switch hours: ${[...profitableHours].sort((a,b)=>a-b).map(fmtHour).join(", ")} EDT`);
}

main().catch(console.error);
