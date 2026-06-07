/**
 * Market Order Cost Backtest — ATOM only, $50 allocation
 * Compares 0% maker (old limit orders) vs market order cost.
 *
 * Cost model per side:
 *   SLIP   = 0.02%  (taker fee)
 *   SPREAD = 0.01%  (bid-ask spread estimate)
 *   Total  = 0.03% per side → 0.06% round trip
 *
 * Run: npx ts-node --transpile-only backtest/market-order-cost.ts
 */

const BINANCE_BASE = "https://api.binance.us/api/v3";
const BINANCE_KEY  = process.env.BINANCE_API_KEY ?? "";

const CORR_WINDOW = 20;
const Z_THRESH    = 2.0;
const TP_PCT      = 0.008;
const SL_PCT      = 0.003;
const MAX_HOLD    = 6;
const ALLOCATION  = 50;
const LOOKBACK_MS = 180 * 24 * 60 * 60 * 1000;  // 6 months

const SLIP   = 0.0002;          // 0.02% taker fee per side
const SPREAD = 0.0001;          // 0.01% bid-ask spread per side
const COST   = SLIP + SPREAD;   // 0.03% per side

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

function calcZScore(btc: number[], alt: number[], i: number): number {
  if (i < CORR_WINDOW + 1) return 0;
  const spreads: number[] = [];
  for (let j = i - CORR_WINDOW; j <= i; j++) {
    spreads.push(Math.log(alt[j] / alt[j-1]) - Math.log(btc[j] / btc[j-1]));
  }
  const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const std  = Math.sqrt(spreads.reduce((a, b) => a + (b - mean) ** 2, 0) / spreads.length);
  if (std === 0) return 0;
  return (spreads[spreads.length - 1] - mean) / std;
}

function runBacktest(btc: number[], alt: number[], withCost: boolean) {
  let pnl = 0, wins = 0, losses = 0, expires = 0;
  let grossWin = 0, grossLoss = 0;
  let peak = ALLOCATION, maxDD = 0, runBal = ALLOCATION;
  let pos: { entryFill: number; sl: number; tp: number; hold: number } | null = null;

  for (let i = CORR_WINDOW + 1; i < btc.length; i++) {
    const price = alt[i];

    if (pos) {
      pos.hold++;
      const hitTP   = price >= pos.tp;
      const hitSL   = price <= pos.sl;
      const expired = pos.hold >= MAX_HOLD;

      if (hitTP || hitSL || expired) {
        const rawExit  = hitTP ? pos.tp : hitSL ? pos.sl : price;
        const exitFill = withCost ? rawExit * (1 - COST) : rawExit;
        const tradePnl = (exitFill - pos.entryFill) / pos.entryFill * ALLOCATION;

        pnl    += tradePnl;
        runBal += tradePnl;

        if (tradePnl >= 0) { wins++;   grossWin  += tradePnl; }
        else               { losses++; grossLoss += Math.abs(tradePnl); }
        if (!hitTP && !hitSL) expires++;

        if (runBal > peak) peak = runBal;
        const dd = (runBal - peak) / peak * 100;
        if (dd < maxDD) maxDD = dd;
        pos = null;
      }
    }

    if (!pos) {
      const z = calcZScore(btc, alt, i);
      if (z <= -Z_THRESH) {
        const entryFill = withCost ? price * (1 + COST) : price;
        pos = {
          entryFill,
          tp: entryFill * (1 + TP_PCT),
          sl: entryFill * (1 - SL_PCT),
          hold: 0,
        };
      }
    }
  }

  const trades  = wins + losses;
  const winRate = trades > 0 ? (wins / trades * 100).toFixed(1) : "0.0";
  const pf      = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
  return { pnl, trades, wins, losses, expires, winRate, pf, maxDD };
}

async function main() {
  const now     = Date.now();
  const startMs = now - LOOKBACK_MS;

  console.log("Fetching candles...");
  const btcRaw  = await fetchAllKlines("BTCUSDT", startMs, now);
  console.log(`  BTC:  ${btcRaw.length} candles`);
  const atomRaw = await fetchAllKlines("ATOMUSDT", startMs, now);
  console.log(`  ATOM: ${atomRaw.length} candles`);

  // Align on shared timestamps
  const atomMap = new Map(atomRaw.map(c => [c.time, c.close]));
  const btc: number[] = [], atom: number[] = [];
  for (const c of btcRaw) {
    const a = atomMap.get(c.time);
    if (a !== undefined) { btc.push(c.close); atom.push(a); }
  }
  console.log(`  Aligned: ${btc.length} candles\n`);

  const maker  = runBacktest(btc, atom, false);
  const market = runBacktest(btc, atom, true);

  const costDrag  = maker.pnl - market.pnl;
  const pctImpact = maker.pnl !== 0 ? (costDrag / Math.abs(maker.pnl) * 100).toFixed(1) : "n/a";

  const w = (s: string | number, n: number) => String(s).padStart(n);

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  ATOM/USDT  Z=2.0  TP=0.8%  SL=0.3%  Hold=6  $50  6 months");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  ${"Scenario".padEnd(26)} ${w("PnL",9)} ${w("Trades",8)} ${w("WR",6)} ${w("PF",6)} ${w("MaxDD",8)}`);
  console.log("──────────────────────────────────────────────────────────────");

  const row = (r: ReturnType<typeof runBacktest>, label: string) =>
    `  ${label.padEnd(26)} ${w("$"+r.pnl.toFixed(2),9)} ${w(r.trades,8)} ${w(r.winRate+"%",6)} ${w(r.pf,6)} ${w(r.maxDD.toFixed(2)+"%",8)}`;

  console.log(row(maker,  "0% maker fees (old)"));
  console.log(row(market, "0.03%/side market (new)"));
  console.log("──────────────────────────────────────────────────────────────");
  console.log(`  Cost drag: -$${costDrag.toFixed(2)}  (${pctImpact}% of gross PnL)`);
  console.log(`  Round-trip cost: ${(COST * 2 * 100).toFixed(2)}%  ` +
              `(fee ${(SLIP*100).toFixed(2)}% + spread ${(SPREAD*100).toFixed(2)}%) × 2 sides`);
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`\n  Expires breakdown:`);
  console.log(`    Maker:  ${maker.expires} expires of ${maker.trades} trades (${(maker.expires/maker.trades*100).toFixed(1)}%)`);
  console.log(`    Market: ${market.expires} expires of ${market.trades} trades (${(market.expires/market.trades*100).toFixed(1)}%)`);
}

main().catch(console.error);
