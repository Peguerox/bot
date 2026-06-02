/**
 * Z-Score Expire Fee Impact
 * Shows how much taker fees on EXPIRE exits eat into PnL.
 *
 * Entry/TP/SL = maker limit (0% fee)
 * EXPIRE      = market order  (taker fee — tested at 0.1% and 0.075% BNB-discount)
 *
 * Run: npx ts-node --transpile-only backtest/zscore-expire-fee.ts
 */

const BINANCE_BASE = "https://api.binance.us/api/v3";
const BINANCE_KEY  = process.env.BINANCE_API_KEY ?? "";

const CORR_WINDOW = 20;
const Z_THRESH    = 2.0;
const TP_PCT      = 0.008;  // current live settings
const SL_PCT      = 0.003;
const MAX_HOLD    = 6;
const ALLOCATION  = 1000;
const LOOKBACK_MS = 180 * 24 * 60 * 60 * 1000; // 6 months

const PAIRS = [
  { symbol: "BNBUSDT", name: "BNB"  },
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
    if (!res.ok) throw new Error(`Binance ${res.status} for ${symbol}`);
    const raw = await res.json() as string[][];
    if (!raw.length) break;
    for (const c of raw) candles.push({ time: Number(c[0]), close: parseFloat(c[4]) });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(120);
  }
  return candles;
}

function runBacktest(btcCloses: number[], altCloses: number[], expireFee: number) {
  let pnl = 0, pnlNoFee = 0;
  let wins = 0, losses = 0, expires = 0;
  let totalFeesPaid = 0;
  let pos: { entry: number; sl: number; tp: number; hold: number } | null = null;

  for (let i = CORR_WINDOW + 1; i < btcCloses.length; i++) {
    const price = altCloses[i];

    if (pos) {
      pos.hold++;
      const hitTP   = price >= pos.tp;
      const hitSL   = price <= pos.sl;
      const expired = pos.hold >= MAX_HOLD;

      if (hitTP || hitSL || expired) {
        const exitPrice = hitTP ? pos.tp : hitSL ? pos.sl : price;
        const rawPnl    = (exitPrice - pos.entry) / pos.entry * ALLOCATION;
        const fee       = expired ? ALLOCATION * expireFee : 0;  // only EXPIRE pays taker
        const netPnl    = rawPnl - fee;

        pnlNoFee     += rawPnl;
        pnl          += netPnl;
        totalFeesPaid += fee;

        if (hitTP)      wins++;
        else if (hitSL) losses++;
        else            expires++;

        pos = null;
      }
    }

    if (!pos) {
      const z = calcZScore(btcCloses, altCloses, i);
      if (z <= -Z_THRESH) {
        pos = { entry: price, sl: price * (1 - SL_PCT), tp: price * (1 + TP_PCT), hold: 0 };
      }
    }
  }

  const trades = wins + losses + expires;
  return { pnl, pnlNoFee, totalFeesPaid, trades, wins, losses, expires };
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

async function main() {
  const now     = Date.now();
  const startMs = now - LOOKBACK_MS;

  console.log("Fetching data...");
  const btcCandles = await fetchAllKlines("BTCUSDT", "1m", startMs, now);
  console.log(`  BTC: ${btcCandles.length} candles`);

  const results: { name: string; r0: ReturnType<typeof runBacktest>; r1: ReturnType<typeof runBacktest>; r2: ReturnType<typeof runBacktest> }[] = [];

  for (const pair of PAIRS) {
    const alt = await fetchAllKlines(pair.symbol, "1m", startMs, now);
    console.log(`  ${pair.symbol}: ${alt.length} candles`);

    const altMap = new Map(alt.map(c => [c.time, c.close]));
    const btcArr: number[] = [], altArr: number[] = [];
    for (const c of btcCandles) {
      const ac = altMap.get(c.time);
      if (ac !== undefined) { btcArr.push(c.close); altArr.push(ac); }
    }

    results.push({
      name: pair.name,
      r0:  runBacktest(btcArr, altArr, 0.000),   // 0% (current paper)
      r1:  runBacktest(btcArr, altArr, 0.001),   // 0.1% taker
      r2:  runBacktest(btcArr, altArr, 0.00075), // 0.075% taker (BNB discount)
    });
  }

  console.log("\n" + "═".repeat(72));
  console.log("  Z-SCORE BOT — EXPIRE TAKER FEE IMPACT  (TP=0.8% SL=0.3% Hold=6)");
  console.log("═".repeat(72));

  let combined0 = 0, combined1 = 0, combined2 = 0, combinedFees1 = 0, combinedFees2 = 0;

  for (const { name, r0, r1, r2 } of results) {
    const expirePct = (r0.expires / r0.trades * 100).toFixed(0);
    console.log(`\n  ${name}`);
    console.log(`  Trades: ${r0.trades.toLocaleString()}  |  TP: ${r0.wins}  SL: ${r0.losses}  EXPIRE: ${r0.expires} (${expirePct}%)`);
    const fmt = (label: string, pnl: number, fees: string, diff: string) =>
      `  ${label.padEnd(22)} ${"$"+pnl.toFixed(0).padStart(8)}  ${fees.padStart(12)}  ${diff.padStart(10)}`;
    console.log(`  ${"Scenario".padEnd(22)} ${"PnL".padStart(9)}  ${"Fees paid".padStart(12)}  ${"vs no-fee".padStart(10)}`);
    console.log(`  ${"-".repeat(56)}`);
    console.log(fmt("0% (paper now)",   r0.pnl, "$0",                             "—"));
    console.log(fmt("0.1% taker",       r1.pnl, "-$"+r1.totalFeesPaid.toFixed(0), (r1.pnl-r0.pnl >= 0 ? "+" : "")+((r1.pnl-r0.pnl).toFixed(0))));
    console.log(fmt("0.075% (BNB disc)",r2.pnl, "-$"+r2.totalFeesPaid.toFixed(0), (r2.pnl-r0.pnl >= 0 ? "+" : "")+((r2.pnl-r0.pnl).toFixed(0))));

    combined0    += r0.pnl;
    combined1    += r1.pnl;
    combined2    += r2.pnl;
    combinedFees1 += r1.totalFeesPaid;
    combinedFees2 += r2.totalFeesPaid;
  }

  console.log("\n" + "─".repeat(72));
  console.log("  COMBINED (BNB + ATOM)");
  console.log(`  ${"0% (paper now)".padEnd(22)} ${"$"+combined0.toFixed(0).padStart(8)}`);
  console.log(`  ${"0.1% taker".padEnd(22)} ${"$"+combined1.toFixed(0).padStart(8)}   fees: -$${combinedFees1.toFixed(0)}   killed ${((combined0-combined1)/combined0*100).toFixed(0)}% of profit`);
  console.log(`  ${"0.075% (BNB disc)".padEnd(22)} ${"$"+combined2.toFixed(0).padStart(8)}   fees: -$${combinedFees2.toFixed(0)}   killed ${((combined0-combined2)/combined0*100).toFixed(0)}% of profit`);
  console.log("═".repeat(72));
}

main().catch(console.error);
