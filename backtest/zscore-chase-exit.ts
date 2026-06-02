/**
 * Z-Score Chase Exit Backtest
 *
 * On EXPIRE: instead of market close, place a limit sell 0.05% below current price.
 * Next candle: if close <= chasePrice → filled (maker, 0% fee).
 *              if close > chasePrice  → price ran up, cancel & re-place 0.05% below new price.
 * Repeat until filled. No market orders, no taker fees ever.
 *
 * Compares vs 0% paper (baseline) and 0.1% taker on every expire.
 *
 * Run: npx ts-node --transpile-only backtest/zscore-chase-exit.ts
 */

const BINANCE_BASE  = "https://api.binance.us/api/v3";
const BINANCE_KEY   = process.env.BINANCE_API_KEY ?? "";

const CORR_WINDOW   = 20;
const Z_THRESH      = 2.0;
const TP_PCT        = 0.008;
const SL_PCT        = 0.003;
const MAX_HOLD      = 6;
const ALLOCATION    = 1000;
const CHASE_OFFSET  = 0.0005;   // 0.05% below current price
const LOOKBACK_DAYS = 365;

const PAIRS = [
  { symbol: "BNBUSDT",  name: "BNB"  },
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
    if (!res.ok) throw new Error(`Binance ${res.status} for ${symbol}`);
    const raw = await res.json() as string[][];
    if (!raw.length) break;
    for (const c of raw) candles.push({ time: Number(c[0]), close: parseFloat(c[4]) });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(120);
  }
  return candles;
}

function calcZScore(btcCloses: number[], altCloses: number[], upToIdx: number): number {
  if (upToIdx < CORR_WINDOW + 1) return 0;
  const spreads: number[] = [];
  for (let i = upToIdx - CORR_WINDOW; i <= upToIdx; i++) {
    spreads.push(Math.log(altCloses[i] / altCloses[i-1]) - Math.log(btcCloses[i] / btcCloses[i-1]));
  }
  const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const std  = Math.sqrt(spreads.reduce((a, b) => a + (b - mean) ** 2, 0) / spreads.length);
  if (std === 0) return 0;
  return (spreads[spreads.length - 1] - mean) / std;
}

type Result = {
  pnl: number;
  trades: number;
  wins: number;
  losses: number;
  expires: number;
  avgChasCandles: number;
  maxChaseCandles: number;
  maxDD: number;
};

function runBacktest(btcCloses: number[], altCloses: number[], mode: "baseline" | "taker" | "chase"): Result {
  let pnl = 0;
  let wins = 0, losses = 0, expires = 0;
  let peak = ALLOCATION, maxDD = 0, runBal = ALLOCATION;
  let totalChaseCandles = 0, maxChaseCandles = 0;

  type OpenPos  = { entry: number; sl: number; tp: number; hold: number };
  type ChasePos = { entry: number; chasePrice: number; chaseCount: number };

  let pos: OpenPos | null = null;
  let chase: ChasePos | null = null;

  for (let i = CORR_WINDOW + 1; i < btcCloses.length; i++) {
    const price = altCloses[i];

    // ── Manage chasing exit ──────────────────────────────────────────────────
    if (chase) {
      if (price <= chase.chasePrice) {
        // Limit filled — price came down to our order
        const tradePnl = (chase.chasePrice - chase.entry) / chase.entry * ALLOCATION;
        pnl    += tradePnl;
        runBal += tradePnl;
        totalChaseCandles += chase.chaseCount;
        if (chase.chaseCount > maxChaseCandles) maxChaseCandles = chase.chaseCount;
        expires++;
        if (runBal > peak) peak = runBal;
        const dd = (runBal - peak) / peak * 100;
        if (dd < maxDD) maxDD = dd;
        chase = null;
      } else {
        // Price ran up — cancel and re-place 0.05% below new price
        chase.chasePrice = price * (1 - CHASE_OFFSET);
        chase.chaseCount++;
      }
      continue; // don't open new positions while chasing
    }

    // ── Manage open position ─────────────────────────────────────────────────
    if (pos) {
      pos.hold++;
      const hitTP   = price >= pos.tp;
      const hitSL   = price <= pos.sl;
      const expired = pos.hold >= MAX_HOLD;

      if (hitTP || hitSL || expired) {
        if (mode === "chase" && expired) {
          // Enter chase mode instead of closing
          chase = { entry: pos.entry, chasePrice: price * (1 - CHASE_OFFSET), chaseCount: 1 };
          pos = null;
          continue;
        }

        const fee       = (mode === "taker" && expired) ? ALLOCATION * 0.001 : 0;
        const exitPrice = hitTP ? pos.tp : hitSL ? pos.sl : price;
        const tradePnl  = (exitPrice - pos.entry) / pos.entry * ALLOCATION - fee;
        pnl    += tradePnl;
        runBal += tradePnl;

        if (hitTP)      wins++;
        else if (hitSL) losses++;
        else            expires++;

        if (runBal > peak) peak = runBal;
        const dd = (runBal - peak) / peak * 100;
        if (dd < maxDD) maxDD = dd;
        pos = null;
      }
    }

    // ── Look for new entry ───────────────────────────────────────────────────
    if (!pos && !chase) {
      const z = calcZScore(btcCloses, altCloses, i);
      if (z <= -Z_THRESH) {
        pos = { entry: price, sl: price * (1 - SL_PCT), tp: price * (1 + TP_PCT), hold: 0 };
      }
    }
  }

  const trades = wins + losses + expires;
  return { pnl, trades, wins, losses, expires, avgChasCandles: expires > 0 ? totalChaseCandles / expires : 0, maxChaseCandles, maxDD };
}

async function main() {
  const now     = Date.now();
  const startMs = now - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  console.log("Fetching 1 year of 1m data...");
  const btcCandles = await fetchAllKlines("BTCUSDT", startMs, now);
  console.log(`  BTC: ${btcCandles.length.toLocaleString()} candles`);

  type PairResult = { name: string; base: Result; taker: Result; chase: Result };
  const allResults: PairResult[] = [];

  for (const pair of PAIRS) {
    const alt = await fetchAllKlines(pair.symbol, startMs, now);
    console.log(`  ${pair.symbol}: ${alt.length.toLocaleString()} candles`);

    const altMap = new Map(alt.map(c => [c.time, c.close]));
    const btcArr: number[] = [], altArr: number[] = [];
    for (const c of btcCandles) {
      const ac = altMap.get(c.time);
      if (ac !== undefined) { btcArr.push(c.close); altArr.push(ac); }
    }

    allResults.push({
      name:  pair.name,
      base:  runBacktest(btcArr, altArr, "baseline"),
      taker: runBacktest(btcArr, altArr, "taker"),
      chase: runBacktest(btcArr, altArr, "chase"),
    });
  }

  console.log("\n" + "═".repeat(74));
  console.log("  Z-SCORE CHASE EXIT  (TP=0.8% SL=0.3% Hold=6 Z=2.0 · 1 year · 1m)");
  console.log("═".repeat(74));

  let totBase = 0, totTaker = 0, totChase = 0;

  for (const { name, base, taker, chase } of allResults) {
    const expPct = (base.expires / base.trades * 100).toFixed(0);
    console.log(`\n  ${name}  (${base.trades.toLocaleString()} trades · ${expPct}% expire)`);
    console.log(`  ${"─".repeat(60)}`);
    console.log(`  ${"Scenario".padEnd(26)} ${"PnL".padStart(10)}  ${"MaxDD".padStart(8)}`);
    console.log(`  ${"─".repeat(60)}`);
    console.log(`  ${"0% maker (paper)".padEnd(26)} ${"$"+base.pnl.toFixed(0).padStart(9)}  ${base.maxDD.toFixed(1).padStart(7)}%`);
    console.log(`  ${"0.1% taker on expire".padEnd(26)} ${"$"+taker.pnl.toFixed(0).padStart(9)}  ${taker.maxDD.toFixed(1).padStart(7)}%`);
    console.log(`  ${"Chase limit (0.05%)".padEnd(26)} ${"$"+chase.pnl.toFixed(0).padStart(9)}  ${chase.maxDD.toFixed(1).padStart(7)}%`);
    console.log(`  ${"─".repeat(60)}`);
    console.log(`  Chase stats: avg ${chase.avgChasCandles.toFixed(1)} candles to fill · max ${chase.maxChaseCandles} candles`);
    totBase  += base.pnl;
    totTaker += taker.pnl;
    totChase += chase.pnl;
  }

  console.log("\n" + "─".repeat(74));
  console.log("  COMBINED (BNB + ATOM)");
  console.log(`  ${"─".repeat(60)}`);
  console.log(`  ${"0% maker (paper)".padEnd(26)} ${"$"+totBase.toFixed(0).padStart(9)}`);
  console.log(`  ${"0.1% taker on expire".padEnd(26)} ${"$"+totTaker.toFixed(0).padStart(9)}   (${((totTaker-totBase)/Math.abs(totBase)*100).toFixed(0)}% vs baseline)`);
  console.log(`  ${"Chase limit (0.05%)".padEnd(26)} ${"$"+totChase.toFixed(0).padStart(9)}   (${((totChase-totBase)/Math.abs(totBase)*100).toFixed(0)}% vs baseline)`);
  console.log("═".repeat(74));
}

main().catch(console.error);
