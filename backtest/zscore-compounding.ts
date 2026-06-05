/**
 * Fixed vs Compounding Allocation Comparison
 * Chase exit (0.05%), 1 year, BNB+ATOM, Z=2.0, TP=0.8%, SL=0.3%, Hold=6
 *
 * Fixed:      always trade $1,000 per pair regardless of gains
 * Compounded: trade with current balance — earnings reinvested each trade
 *
 * Run: npx ts-node --transpile-only backtest/zscore-compounding.ts
 */

const BINANCE_BASE  = "https://api.binance.us/api/v3";
const BINANCE_KEY   = process.env.BINANCE_API_KEY ?? "";
const CORR_WINDOW   = 20;
const Z_THRESH      = 2.0;
const TP_PCT        = 0.008;
const SL_PCT        = 0.003;
const MAX_HOLD      = 6;
const CHASE_OFFSET  = 0.0005;
const INITIAL       = 1000;
const LOOKBACK_DAYS = 365;

const PAIRS = [
  { symbol: "BNBUSDT", name: "BNB"  },
  { symbol: "ATOMUSDT", name: "ATOM" },
];

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAllKlines(symbol: string, startMs: number, endMs: number) {
  const candles: { time: number; close: number }[] = [];
  let from = startMs;
  while (from < endMs) {
    const url = `${BINANCE_BASE}/klines?symbol=${symbol}&interval=1m` +
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

function calcZScore(btc: number[], alt: number[], i: number): number {
  if (i < CORR_WINDOW + 1) return 0;
  const spreads: number[] = [];
  for (let j = i - CORR_WINDOW; j <= i; j++)
    spreads.push(Math.log(alt[j] / alt[j-1]) - Math.log(btc[j] / btc[j-1]));
  const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const std  = Math.sqrt(spreads.reduce((a, b) => a + (b - mean) ** 2, 0) / spreads.length);
  if (std === 0) return 0;
  return (spreads[spreads.length - 1] - mean) / std;
}

// Monthly rebalance: update allocation at the start of each month's worth of candles
const CANDLES_PER_MONTH = 30 * 24 * 60; // 1m candles in ~30 days

function runBacktest(btc: number[], alt: number[], mode: "fixed" | "monthly") {
  let balance  = INITIAL;
  let alloc    = INITIAL;
  let peak     = INITIAL;
  let maxDD    = 0;
  let trades   = 0;
  let nextRebalance = CANDLES_PER_MONTH;

  type Pos   = { entry: number; sl: number; tp: number; hold: number; alloc: number };
  type Chase = { entry: number; chasePrice: number; alloc: number };

  let pos:   Pos   | null = null;
  let chase: Chase | null = null;

  for (let i = CORR_WINDOW + 1; i < btc.length; i++) {
    // Monthly rebalance: update allocation to current balance
    if (mode === "monthly" && i >= nextRebalance && !pos && !chase) {
      alloc = balance;
      nextRebalance += CANDLES_PER_MONTH;
    }

    const price = alt[i];

    if (chase) {
      if (price <= chase.chasePrice) {
        const pnl = (chase.chasePrice - chase.entry) / chase.entry * chase.alloc;
        balance  += pnl;
        trades++;
        if (balance > peak) peak = balance;
        const dd = (balance - peak) / peak * 100;
        if (dd < maxDD) maxDD = dd;
        chase = null;
      } else {
        chase.chasePrice = price * (1 - CHASE_OFFSET);
      }
      continue;
    }

    if (pos) {
      pos.hold++;
      const hitTP  = price >= pos.tp;
      const hitSL  = price <= pos.sl;
      const expire = pos.hold >= MAX_HOLD;

      if (hitTP || hitSL || expire) {
        if (expire) {
          chase = { entry: pos.entry, chasePrice: price * (1 - CHASE_OFFSET), alloc: pos.alloc };
          pos   = null;
          continue;
        }
        const exit = hitTP ? pos.tp : pos.sl;
        const pnl  = (exit - pos.entry) / pos.entry * pos.alloc;
        balance   += pnl;
        trades++;
        if (balance > peak) peak = balance;
        const dd = (balance - peak) / peak * 100;
        if (dd < maxDD) maxDD = dd;
        pos = null;
      }
    }

    if (!pos && !chase) {
      const z = calcZScore(btc, alt, i);
      if (z <= -Z_THRESH)
        pos = { entry: price, sl: price*(1-SL_PCT), tp: price*(1+TP_PCT), hold: 0, alloc };
    }
  }

  return { finalBalance: balance, maxDD, trades };
}

async function main() {
  const now     = Date.now();
  const startMs = now - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  console.log("Fetching 1 year of 1m data...");
  const btcRaw = await fetchAllKlines("BTCUSDT", startMs, now);
  console.log(`  BTC: ${btcRaw.length.toLocaleString()} candles`);

  let fixedTotal = 0, compTotal = 0;

  console.log("\n" + "═".repeat(72));
  console.log("  FIXED vs COMPOUNDING  (chase exit · 1yr · $1,000 start per pair)");
  console.log("═".repeat(72));

  for (const { symbol, name } of PAIRS) {
    const altRaw = await fetchAllKlines(symbol, startMs, now);
    console.log(`  ${symbol}: ${altRaw.length.toLocaleString()} candles`);

    const altMap = new Map(altRaw.map(c => [c.time, c.close]));
    const btc: number[] = [], alt: number[] = [];
    for (const c of btcRaw) {
      const a = altMap.get(c.time);
      if (a !== undefined) { btc.push(c.close); alt.push(a); }
    }

    const fixed   = runBacktest(btc, alt, "fixed");
    const monthly = runBacktest(btc, alt, "monthly");

    fixedTotal += fixed.finalBalance;
    compTotal  += monthly.finalBalance;

    console.log(`\n  ${name}`);
    console.log(`  ${"─".repeat(55)}`);
    console.log(`  ${"Scenario".padEnd(22)} ${"Final $".padStart(12)} ${"Gain".padStart(10)} ${"MaxDD".padStart(8)}`);
    console.log(`  ${"─".repeat(55)}`);
    console.log(`  ${"Fixed $1,000".padEnd(22)} ${"$"+fixed.finalBalance.toFixed(0).padStart(11)} ${("+"+(fixed.finalBalance-INITIAL).toFixed(0)).padStart(10)} ${fixed.maxDD.toFixed(1).padStart(7)}%`);
    console.log(`  ${"Monthly rebalance".padEnd(22)} ${"$"+monthly.finalBalance.toFixed(0).padStart(11)} ${("+"+(monthly.finalBalance-INITIAL).toFixed(0)).padStart(10)} ${monthly.maxDD.toFixed(1).padStart(7)}%`);
    console.log(`  Compounding boost: ${(monthly.finalBalance / fixed.finalBalance).toFixed(1)}×`);
  }

  console.log("\n" + "─".repeat(72));
  console.log("  COMBINED (BNB + ATOM · $2,000 total start)");
  console.log(`  ${"─".repeat(55)}`);
  console.log(`  ${"Fixed".padEnd(20)} ${"$"+fixedTotal.toFixed(0).padStart(11)}   gain: +$${(fixedTotal - INITIAL*2).toFixed(0)}`);
  console.log(`  ${"Compounded".padEnd(20)} ${"$"+compTotal.toFixed(0).padStart(11)}   gain: +$${(compTotal  - INITIAL*2).toFixed(0)}`);
  console.log(`  Compounding multiplier: ${(compTotal / fixedTotal).toFixed(1)}×`);
  console.log("═".repeat(72));
}

main().catch(console.error);
