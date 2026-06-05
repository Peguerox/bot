/**
 * Binance.com vs Binance.US — Z-Score Lag Backtest
 * Confirms BTC→ATOM lag still exists on Binance.com (higher liquidity)
 * Chase exit, 1 year, ATOM only, Z=2.0, TP=0.8%, SL=0.3%, Hold=6
 *
 * Run: npx ts-node --transpile-only backtest/zscore-binance-com.ts
 */

const BASE_COM = "https://api.binance.com/api/v3";
const BASE_US  = "https://api.binance.us/api/v3";

const CORR_WINDOW   = 20;
const Z_THRESH      = 2.0;
const TP_PCT        = 0.008;
const SL_PCT        = 0.003;
const MAX_HOLD      = 6;
const CHASE_OFFSET  = 0.0005;
const ALLOCATION    = 1000;
const LOOKBACK_DAYS = 365;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAllKlines(base: string, symbol: string, startMs: number, endMs: number) {
  const candles: { time: number; close: number }[] = [];
  let from = startMs;
  while (from < endMs) {
    const url = `${base}/klines?symbol=${symbol}&interval=1m` +
                `&startTime=${from}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url);
    if (res.status === 429) { await sleep(10_000); continue; }
    if (!res.ok) throw new Error(`${res.status} for ${symbol} on ${base}`);
    const raw = await res.json() as string[][];
    if (!raw.length) break;
    for (const c of raw) candles.push({ time: Number(c[0]), close: parseFloat(c[4]) });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(100);
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

function runBacktest(btc: number[], alt: number[]) {
  let pnl = 0, peak = ALLOCATION, maxDD = 0, runBal = ALLOCATION;
  let wins = 0, losses = 0, chases = 0;

  type Pos   = { entry: number; sl: number; tp: number; hold: number };
  type Chase = { entry: number; chasePrice: number };

  let pos:   Pos   | null = null;
  let chase: Chase | null = null;

  for (let i = CORR_WINDOW + 1; i < btc.length; i++) {
    const price = alt[i];

    if (chase) {
      if (price <= chase.chasePrice) {
        const tradePnl = (chase.chasePrice - chase.entry) / chase.entry * ALLOCATION;
        pnl += tradePnl; runBal += tradePnl; chases++;
        if (runBal > peak) peak = runBal;
        if ((runBal - peak) / peak * 100 < maxDD) maxDD = (runBal - peak) / peak * 100;
        chase = null;
      } else {
        chase.chasePrice = price * (1 - CHASE_OFFSET);
      }
      continue;
    }

    if (pos) {
      pos.hold++;
      const hitTP = price >= pos.tp, hitSL = price <= pos.sl, expire = pos.hold >= MAX_HOLD;
      if (hitTP || hitSL || expire) {
        if (expire) { chase = { entry: pos.entry, chasePrice: price * (1 - CHASE_OFFSET) }; pos = null; continue; }
        const exit = hitTP ? pos.tp : pos.sl;
        const tradePnl = (exit - pos.entry) / pos.entry * ALLOCATION;
        pnl += tradePnl; runBal += tradePnl;
        if (hitTP) wins++; else losses++;
        if (runBal > peak) peak = runBal;
        if ((runBal - peak) / peak * 100 < maxDD) maxDD = (runBal - peak) / peak * 100;
        pos = null;
      }
    }

    if (!pos && !chase) {
      const z = calcZScore(btc, alt, i);
      if (z <= -Z_THRESH)
        pos = { entry: price, sl: price*(1-SL_PCT), tp: price*(1+TP_PCT), hold: 0 };
    }
  }

  const trades = wins + losses + chases;
  return { pnl, finalBalance: ALLOCATION + pnl, maxDD, trades, wins, losses, chases,
           winRate: trades > 0 ? (wins / trades * 100).toFixed(1) : "0" };
}

async function main() {
  const now     = Date.now();
  const startMs = now - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  console.log("Fetching 1 year ATOMUSDT + BTCUSDT from both exchanges...\n");

  // Binance.com
  console.log("── Binance.com ──────────────────────────────");
  const btcCom  = await fetchAllKlines(BASE_COM, "BTCUSDT", startMs, now);
  console.log(`  BTC: ${btcCom.length.toLocaleString()} candles`);
  const atomCom = await fetchAllKlines(BASE_COM, "ATOMUSDT", startMs, now);
  console.log(`  ATOM: ${atomCom.length.toLocaleString()} candles`);

  // Binance.US
  console.log("\n── Binance.US ───────────────────────────────");
  const btcUs   = await fetchAllKlines(BASE_US, "BTCUSDT", startMs, now);
  console.log(`  BTC: ${btcUs.length.toLocaleString()} candles`);
  const atomUs  = await fetchAllKlines(BASE_US, "ATOMUSDT", startMs, now);
  console.log(`  ATOM: ${atomUs.length.toLocaleString()} candles`);

  function align(btcRaw: typeof btcCom, altRaw: typeof atomCom) {
    const altMap = new Map(altRaw.map(c => [c.time, c.close]));
    const btc: number[] = [], alt: number[] = [];
    for (const c of btcRaw) { const a = altMap.get(c.time); if (a !== undefined) { btc.push(c.close); alt.push(a); } }
    return { btc, alt };
  }

  const comData = align(btcCom, atomCom);
  const usData  = align(btcUs,  atomUs);

  const comResult = runBacktest(comData.btc, comData.alt);
  const usResult  = runBacktest(usData.btc,  usData.alt);

  console.log("\n" + "═".repeat(70));
  console.log("  BTC→ATOM LAG  (Z=2.0 · TP=0.8% · SL=0.3% · Hold=6 · Chase exit · 1yr)");
  console.log("═".repeat(70));
  console.log(`\n  ${"Exchange".padEnd(16)} ${"Final $".padStart(10)} ${"PnL".padStart(10)} ${"Trades".padStart(8)} ${"WinRate".padStart(9)} ${"MaxDD".padStart(8)}`);
  console.log(`  ${"─".repeat(64)}`);
  for (const [label, r] of [["Binance.com", comResult], ["Binance.US", usResult]] as const) {
    console.log(`  ${label.padEnd(16)} ${"$"+r.finalBalance.toFixed(0).padStart(9)} ${("+$"+r.pnl.toFixed(0)).padStart(10)} ${String(r.trades).padStart(8)} ${(r.winRate+"%").padStart(9)} ${(r.maxDD.toFixed(1)+"%").padStart(8)}`);
  }
  console.log(`\n  Trade breakdown:`);
  console.log(`  ${"─".repeat(64)}`);
  console.log(`  ${"".padEnd(16)} ${"TP hits".padStart(10)} ${"SL hits".padStart(10)} ${"Chase fills".padStart(12)}`);
  console.log(`  ${"Binance.com".padEnd(16)} ${String(comResult.wins).padStart(10)} ${String(comResult.losses).padStart(10)} ${String(comResult.chases).padStart(12)}`);
  console.log(`  ${"Binance.US".padEnd(16)}  ${String(usResult.wins).padStart(10)} ${String(usResult.losses).padStart(10)} ${String(usResult.chases).padStart(12)}`);
  console.log("\n" + "═".repeat(70));
  const diff = ((comResult.pnl - usResult.pnl) / Math.abs(usResult.pnl) * 100).toFixed(1);
  console.log(`  Binance.com vs Binance.US: ${Number(diff) >= 0 ? "+" : ""}${diff}% PnL difference`);
  console.log("═".repeat(70));
}

main().catch(console.error);
