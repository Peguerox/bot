/**
 * Weekend Effect Backtest
 * Tests whether day-of-week has consistent edge in crypto.
 *
 * Tests:
 *   1. BTC daily returns by day of week (Mon–Sun)
 *   2. Z-Score bot (BNB+ATOM) performance by day of week
 *   3. Accumulator: hold SOL on "good" days, BTC on "bad" days
 *   4. Simple day-of-week rotation strategy
 *
 * Run: npx ts-node --transpile-only backtest/weekend-effect.ts
 */

const BINANCE_BASE = "https://api.binance.us/api/v3";
const BINANCE_KEY  = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS  = 365 * 24 * 60 * 60 * 1000;
const START_BTC    = 0.013557;
const ALLOCATION   = 1000;

// Z-Score params (current live bot)
const CORR_WINDOW  = 20;
const Z_THRESH     = 2.0;
const TP_PCT       = 0.008;
const SL_PCT       = 0.003;
const MAX_HOLD     = 6;
const UTC_OFFSET   = -4; // EDT

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string, interval: string, startMs: number, endMs: number) {
  const candles: { time: number; open: number; high: number; low: number; close: number }[] = [];
  let from = startMs;
  while (from < endMs) {
    const url = `${BINANCE_BASE}/klines?symbol=${symbol}&interval=${interval}` +
                `&startTime=${from}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url, { headers: { "X-MBX-APIKEY": BINANCE_KEY } });
    if (res.status === 429) { await sleep(10_000); continue; }
    if (!res.ok) throw new Error(`Binance ${res.status}: ${symbol}`);
    const raw = await res.json() as string[][];
    if (!raw.length) break;
    for (const c of raw) candles.push({
      time:  Number(c[0]),
      open:  parseFloat(c[1]),
      high:  parseFloat(c[2]),
      low:   parseFloat(c[3]),
      close: parseFloat(c[4]),
    });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(120);
  }
  return candles;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function getDow(utcMs: number): number {
  // Day of week in EDT
  const edtMs = utcMs + UTC_OFFSET * 3_600_000;
  return new Date(edtMs).getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
}

// ── Test 1: BTC daily returns by day of week ─────────────────────────────
function analyzeBtcDow(candles: { time: number; open: number; close: number }[]) {
  const byDay: { returns: number[]; positive: number; total: number }[] =
    Array.from({ length: 7 }, () => ({ returns: [], positive: 0, total: 0 }));

  for (const c of candles) {
    const dow = getDow(c.time);
    const ret = (c.close - c.open) / c.open * 100;
    byDay[dow].returns.push(ret);
    byDay[dow].total++;
    if (ret > 0) byDay[dow].positive++;
  }

  console.log("\n── 1. BTC daily return by day of week ──");
  console.log(`${"Day".padEnd(6)} ${"N".padStart(4)} ${"Avg Return".padStart(11)} ${"% Positive".padStart(11)} ${"Avg Win".padStart(9)} ${"Avg Loss".padStart(10)}`);
  console.log("─".repeat(55));

  for (let d = 0; d < 7; d++) {
    const { returns, positive, total } = byDay[d];
    if (!total) continue;
    const avg    = returns.reduce((a, b) => a + b, 0) / total;
    const wins   = returns.filter(r => r > 0);
    const losses = returns.filter(r => r <= 0);
    const avgW   = wins.length   ? wins.reduce((a, b) => a + b, 0)   / wins.length   : 0;
    const avgL   = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
    const signal = avg > 0.3 ? "✓✓" : avg > 0 ? "✓" : avg > -0.3 ? "~" : "✗";
    console.log(
      `${DAYS[d].padEnd(6)} ${String(total).padStart(4)}` +
      ` ${`${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%`.padStart(11)}` +
      ` ${`${(positive / total * 100).toFixed(0)}%`.padStart(11)}` +
      ` ${`+${avgW.toFixed(2)}%`.padStart(9)}` +
      ` ${`${avgL.toFixed(2)}%`.padStart(10)}  ${signal}`
    );
  }
}

// ── Test 2: Z-Score bot by day of week ──────────────────────────────────
function calcZScore(btc: number[], alt: number[], i: number): number {
  if (i < CORR_WINDOW + 1) return 0;
  const spreads: number[] = [];
  for (let j = i - CORR_WINDOW; j <= i; j++) {
    spreads.push(Math.log(alt[j] / alt[j-1]) - Math.log(btc[j] / btc[j-1]));
  }
  const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const std  = Math.sqrt(spreads.reduce((a, b) => a + (b - mean) ** 2, 0) / spreads.length);
  return std === 0 ? 0 : (spreads[spreads.length - 1] - mean) / std;
}

function analyzeZScoreDow(
  btcTimes: number[], btcCloses: number[], altCloses: number[], name: string
) {
  const byDay: { pnl: number; wins: number; losses: number; expires: number;
                 grossWin: number; grossLoss: number }[] =
    Array.from({ length: 7 }, () =>
      ({ pnl: 0, wins: 0, losses: 0, expires: 0, grossWin: 0, grossLoss: 0 })
    );

  let pos: { entry: number; sl: number; tp: number; hold: number; dow: number } | null = null;

  for (let i = CORR_WINDOW + 1; i < btcCloses.length; i++) {
    const price = altCloses[i];
    const dow   = getDow(btcTimes[i]);

    if (pos) {
      pos.hold++;
      const hitTP   = price >= pos.tp;
      const hitSL   = price <= pos.sl;
      const expired = pos.hold >= MAX_HOLD;

      if (hitTP || hitSL || expired) {
        const exit   = hitTP ? pos.tp : hitSL ? pos.sl : price;
        const tradePnl = (exit - pos.entry) / pos.entry * ALLOCATION;
        const d      = pos.dow;

        byDay[d].pnl += tradePnl;
        if (hitTP)      { byDay[d].wins++;    byDay[d].grossWin  += tradePnl; }
        else if (hitSL) { byDay[d].losses++;  byDay[d].grossLoss += Math.abs(tradePnl); }
        else            {
          byDay[d].expires++;
          tradePnl > 0 ? byDay[d].grossWin += tradePnl : byDay[d].grossLoss += Math.abs(tradePnl);
        }
        pos = null;
      }
    }

    if (!pos) {
      const z = calcZScore(btcCloses, altCloses, i);
      if (z <= -Z_THRESH) {
        pos = { entry: price, sl: price * (1 - SL_PCT), tp: price * (1 + TP_PCT), hold: 0, dow };
      }
    }
  }

  return byDay;
}

// ── Test 3: Accumulator day-of-week filter ───────────────────────────────
function runAccumulatorDow(
  btcArr: number[], solArr: number[], period: number,
  allowedDows: Set<number> | null, times: number[]
) {
  let holding: "BTC" | "SOL" = "BTC";
  let quantity = START_BTC, switches = 0;

  for (let i = period; i < btcArr.length; i++) {
    const window = btcArr.slice(i - period + 1, i + 1);
    const mean   = window.reduce((a, b) => a + b, 0) / period;
    const target: "BTC" | "SOL" = btcArr[i] > mean ? "SOL" : "BTC";

    if (target !== holding) {
      const dow = getDow(times[i]);
      if (allowedDows !== null && !allowedDows.has(dow)) continue;
      quantity = holding === "BTC" ? quantity / solArr[i] : quantity * solArr[i];
      holding  = target;
      switches++;
    }
  }

  const finalBtc = holding === "BTC" ? quantity : quantity * solArr[solArr.length - 1];
  return { finalBtc, gainPct: (finalBtc - START_BTC) / START_BTC * 100, switches };
}

async function main() {
  const now = Date.now(), startMs = now - LOOKBACK_MS;
  console.log("\nWeekend Effect Backtest\n");

  // Fetch data
  process.stdout.write("Fetching BTCUSDT 1d...");
  const btcDaily = await fetchKlines("BTCUSDT", "1d", startMs, now);
  process.stdout.write(` ${btcDaily.length} candles\n`);

  process.stdout.write("Fetching BTCUSDT 1m...");
  const btc1m = await fetchKlines("BTCUSDT", "1m", startMs, now);
  process.stdout.write(` ${btc1m.length} candles\n`);

  process.stdout.write("Fetching BNBUSDT 1m...");
  const bnb1m = await fetchKlines("BNBUSDT", "1m", startMs, now);
  process.stdout.write(` ${bnb1m.length} candles\n`);

  process.stdout.write("Fetching ATOMUSDT 1m...");
  const atom1m = await fetchKlines("ATOMUSDT", "1m", startMs, now);
  process.stdout.write(` ${atom1m.length} candles\n`);

  process.stdout.write("Fetching SOLBTC 5m...");
  const solBtc = await fetchKlines("SOLBTC", "5m", startMs, now);
  process.stdout.write(` ${solBtc.length} candles\n\n`);

  // ── Test 1: BTC daily returns ─────────────────────────────────────────
  analyzeBtcDow(btcDaily);

  // ── Test 2: Z-Score by day ────────────────────────────────────────────
  const bnbMap  = new Map(bnb1m.map(c => [c.time, c.close]));
  const atomMap = new Map(atom1m.map(c => [c.time, c.close]));
  const btcTimes: number[] = [], btcCloses: number[] = [];
  const bnbCloses: number[] = [], atomCloses: number[] = [];

  for (const c of btc1m) {
    const b = bnbMap.get(c.time), a = atomMap.get(c.time);
    if (b !== undefined && a !== undefined) {
      btcTimes.push(c.time); btcCloses.push(c.close);
      bnbCloses.push(b); atomCloses.push(a);
    }
  }

  const bnbByDay  = analyzeZScoreDow(btcTimes, btcCloses, bnbCloses,  "BNB");
  const atomByDay = analyzeZScoreDow(btcTimes, btcCloses, atomCloses, "ATOM");

  console.log("\n── 2. Z-Score bot performance by day (BNB + ATOM combined) ──");
  console.log(`${"Day".padEnd(6)} ${"Trades".padStart(7)} ${"Win%".padStart(6)} ${"PF".padStart(5)} ${"PnL($)".padStart(9)}  Signal`);
  console.log("─".repeat(45));

  let bestDays: number[] = [], worstDays: number[] = [];

  for (let d = 0; d < 7; d++) {
    const b = bnbByDay[d], a = atomByDay[d];
    const trades = b.wins + b.losses + b.expires + a.wins + a.losses + a.expires;
    const wins   = b.wins + a.wins;
    const gw     = b.grossWin + a.grossWin;
    const gl     = b.grossLoss + a.grossLoss;
    const pnl    = b.pnl + a.pnl;
    const wr     = trades > 0 ? (wins / trades * 100).toFixed(1) : "—";
    const pf     = gl > 0 ? (gw / gl).toFixed(2) : gw > 0 ? "∞" : "—";
    const signal = pnl > 300 ? "✓✓ Strong" : pnl > 100 ? "✓  Good" : pnl > 0 ? "~  Flat" : "✗  Avoid";
    if (pnl > 100)  bestDays.push(d);
    if (pnl < 0)    worstDays.push(d);
    console.log(
      `${DAYS[d].padEnd(6)} ${String(trades).padStart(7)} ${`${wr}%`.padStart(6)} ${pf.padStart(5)}` +
      ` ${`${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}`.padStart(9)}  ${signal}`
    );
  }

  // ── Test 3: Accumulator day filter ───────────────────────────────────
  const solMap  = new Map(solBtc.map(c => [c.time, c.close]));
  const btc5m   = await fetchKlines("BTCUSDT", "5m", startMs, now);
  process.stdout.write("\nFetching BTCUSDT 5m for accumulator test...");
  const btcArr: number[] = [], solArr: number[] = [], btc5mTimes: number[] = [];
  for (const c of btc5m) {
    const sp = solMap.get(c.time);
    if (sp !== undefined) { btcArr.push(c.close); solArr.push(sp); btc5mTimes.push(c.time); }
  }
  process.stdout.write(` aligned ${btcArr.length}\n`);

  const baseline  = runAccumulatorDow(btcArr, solArr, 10, null, btc5mTimes);
  const weekdays  = runAccumulatorDow(btcArr, solArr, 10, new Set([1,2,3,4,5]), btc5mTimes);
  const weekends  = runAccumulatorDow(btcArr, solArr, 10, new Set([0,6]), btc5mTimes);
  const monWed    = runAccumulatorDow(btcArr, solArr, 10, new Set([1,2,3]), btc5mTimes);
  const bestDaySet = bestDays.length > 0 ? new Set(bestDays) : new Set([0,1,2,3,4,5,6]);
  const bestOnly  = runAccumulatorDow(btcArr, solArr, 10, bestDaySet, btc5mTimes);

  console.log("\n── 3. Accumulator with day-of-week switch filter ──");
  console.log(`${"Window".padEnd(30)} ${"FinalBTC".padStart(10)} ${"Gain%".padStart(8)} ${"Switches".padStart(9)}`);
  console.log("─".repeat(62));
  for (const [label, r] of [
    ["All days (baseline)",       baseline],
    ["Weekdays only (Mon–Fri)",   weekdays],
    ["Weekends only (Sat–Sun)",   weekends],
    ["Mon–Wed only",              monWed],
    ["Best Z-Score days only",    bestOnly],
  ] as [string, { finalBtc: number; gainPct: number; switches: number }][]) {
    console.log(
      label.padEnd(30) +
      ` ${r.finalBtc.toFixed(6).padStart(10)}` +
      ` ${`${r.gainPct >= 0 ? "+" : ""}${r.gainPct.toFixed(1)}%`.padStart(8)}` +
      ` ${String(r.switches).padStart(9)}`
    );
  }

  console.log(`\nBest Z-Score days: ${bestDays.map(d => DAYS[d]).join(", ") || "none"}`);
  console.log(`Worst Z-Score days: ${worstDays.map(d => DAYS[d]).join(", ") || "none"}`);
}

main().catch(console.error);
