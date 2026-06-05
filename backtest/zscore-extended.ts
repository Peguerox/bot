/**
 * Z-Score Extended Sweep — push beyond 0.8% TP and 0.3% SL
 * TP: 0.6–1.2%, SL: 0.2–0.4%, hold=6, 1m, 6 months
 *
 * Run: npx ts-node --transpile-only backtest/zscore-extended.ts
 */

const BINANCE_BASE = "https://api.binance.us/api/v3";
const BINANCE_KEY  = process.env.BINANCE_API_KEY ?? "";

const CORR_WINDOW  = 20;
const Z_THRESH     = 2.0;
const MAX_HOLD     = 6;
const ALLOCATION   = 1000;
const LOOKBACK_MS  = 180 * 24 * 60 * 60 * 1000;

const TP_VARIANTS  = [0.006, 0.007, 0.008, 0.009, 0.010, 0.011, 0.012];
const SL_VARIANTS  = [0.002, 0.003, 0.004];

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
  if (spreads.length < CORR_WINDOW) return 0;
  const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const std  = Math.sqrt(spreads.reduce((a, b) => a + (b - mean) ** 2, 0) / spreads.length);
  if (std === 0) return 0;
  return (spreads[spreads.length - 1] - mean) / std;
}

function runBacktest(btcCloses: number[], altCloses: number[], tpPct: number, slPct: number) {
  let pnl = 0, wins = 0, losses = 0, expires = 0;
  let grossWin = 0, grossLoss = 0;
  let peak = ALLOCATION, maxDD = 0, runBal = ALLOCATION;
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
        const tradePnl  = (exitPrice - pos.entry) / pos.entry * ALLOCATION;
        pnl    += tradePnl;
        runBal += tradePnl;

        if (hitTP)      { wins++;    grossWin  += tradePnl; }
        else if (hitSL) { losses++;  grossLoss += Math.abs(tradePnl); }
        else            { expires++; tradePnl > 0 ? grossWin += tradePnl : grossLoss += Math.abs(tradePnl); }

        if (runBal > peak) peak = runBal;
        const dd = (runBal - peak) / peak * 100;
        if (dd < maxDD) maxDD = dd;
        pos = null;
      }
    }

    if (!pos) {
      const z = calcZScore(btcCloses, altCloses, i);
      if (z <= -Z_THRESH) {
        pos = { entry: price, sl: price * (1 - slPct), tp: price * (1 + tpPct), hold: 0 };
      }
    }
  }

  const trades  = wins + losses + expires;
  const winRate = trades > 0 ? (wins / trades * 100).toFixed(1) : "0.0";
  const pf      = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
  const expPct  = trades > 0 ? (expires / trades * 100).toFixed(0) : "0";
  return { pnl, trades, wins, losses, expires, winRate, pf, maxDD, expPct };
}

async function main() {
  const now = Date.now(), startMs = now - LOOKBACK_MS;

  process.stdout.write("Fetching 1m data (6 months)...\n");
  const btcCandles = await fetchAllKlines("BTCUSDT", "1m", startMs, now);
  process.stdout.write(`  BTC: ${btcCandles.length} candles\n`);

  const pairData: { name: string; btcArr: number[]; altArr: number[] }[] = [];
  for (const pair of PAIRS) {
    const alt = await fetchAllKlines(pair.symbol, "1m", startMs, now);
    process.stdout.write(`  ${pair.symbol}: ${alt.length} candles\n`);
    const altMap = new Map(alt.map(c => [c.time, c.close]));
    const btcArr: number[] = [], altArr: number[] = [];
    for (const c of btcCandles) {
      const ac = altMap.get(c.time);
      if (ac !== undefined) { btcArr.push(c.close); altArr.push(ac); }
    }
    pairData.push({ name: pair.name, btcArr, altArr });
  }

  type Row = { pair: string; tp: number; sl: number; pnl: number; winRate: string; pf: string; maxDD: number; expPct: string; trades: number };
  const allRows: Row[] = [];

  for (const { name, btcArr, altArr } of pairData) {
    for (const sl of SL_VARIANTS) {
      for (const tp of TP_VARIANTS) {
        const r = runBacktest(btcArr, altArr, tp, sl);
        allRows.push({ pair: name, tp, sl, pnl: r.pnl, winRate: r.winRate, pf: r.pf, maxDD: r.maxDD, expPct: r.expPct, trades: r.trades });
      }
    }
  }

  // ── Combined table ────────────────────────────────────────────────────────

  const tpLabels = TP_VARIANTS.map(t => `TP${(t*100).toFixed(1)}%`);
  const colW = 8;

  console.log(`\n╔══════╦${TP_VARIANTS.map(() => "═".repeat(colW+1)).join("╤")}╗`);
  console.log(`║  SL  ║${tpLabels.map(l => l.padStart(colW)).join(" │")} ║  ← Combined BNB+ATOM PnL ($)`);
  console.log(`╠══════╬${TP_VARIANTS.map(() => "═".repeat(colW+1)).join("╪")}╣`);

  let bestCombo = { tp: 0, sl: 0, pnl: -Infinity };

  for (const sl of SL_VARIANTS) {
    const cells = TP_VARIANTS.map(tp => {
      const combined = allRows.filter(r => r.tp === tp && r.sl === sl).reduce((s, r) => s + r.pnl, 0);
      if (combined > bestCombo.pnl) bestCombo = { tp, sl, pnl: combined };
      const sign = combined >= 0 ? "+" : "";
      return `${sign}${combined.toFixed(0)}`.padStart(colW);
    });
    console.log(`║ ${(sl*100).toFixed(1)}% ║${cells.join(" │")} ║`);
  }
  console.log(`╚══════╩${TP_VARIANTS.map(() => "═".repeat(colW+1)).join("╧")}╝`);

  // ── Winner detail ─────────────────────────────────────────────────────────

  const winnerRows = allRows.filter(r => r.tp === bestCombo.tp && r.sl === bestCombo.sl);
  console.log(`\n★  BEST: TP=${(bestCombo.tp*100).toFixed(1)}%  SL=${(bestCombo.sl*100).toFixed(1)}%  →  $+${bestCombo.pnl.toFixed(0)} combined (6 months)`);
  for (const r of winnerRows) {
    console.log(`   ${r.pair}: $+${r.pnl.toFixed(0)} | WR ${r.winRate}% | PF ${r.pf} | MaxDD ${r.maxDD.toFixed(2)}% | Expires ${r.expPct}% of ${r.trades} trades`);
  }

  // ── vs current ───────────────────────────────────────────────────────────
  const current = allRows.filter(r => r.tp === 0.006 && r.sl === 0.004).reduce((s, r) => s + r.pnl, 0);
  const uplift  = ((bestCombo.pnl - current) / Math.abs(current) * 100).toFixed(1);
  console.log(`\n   Current live (TP=0.6% SL=0.4%): $+${current.toFixed(0)}`);
  console.log(`   Best improvement: +${uplift}%`);

  // ── Gradient check: is curve still rising at edges? ───────────────────────
  console.log(`\n── Gradient check (combined, SL=0.2%) ──`);
  for (const tp of TP_VARIANTS) {
    const v = allRows.filter(r => r.tp === tp && r.sl === 0.002).reduce((s, r) => s + r.pnl, 0);
    console.log(`   TP ${(tp*100).toFixed(1)}%: $+${v.toFixed(0)}`);
  }
}

main().catch(console.error);
