/**
 * Z-Score TP Sweep Backtest
 * Fixed: hold=6, SL=0.4%, 1m timeframe, 6 months
 * Varying: TP = 0.4%, 0.5%, 0.6%
 *
 * Run: npx ts-node --transpile-only backtest/zscore-tptest.ts
 */

const BINANCE_BASE = "https://api.binance.us/api/v3";
const BINANCE_KEY  = process.env.BINANCE_API_KEY ?? "";

const CORR_WINDOW  = 20;
const Z_THRESH     = 2.0;
const SL_PCT       = 0.004;   // fixed 0.4%
const MAX_HOLD     = 6;       // fixed hold=6
const ALLOCATION   = 1000;

const TP_VARIANTS  = [0.004, 0.005, 0.006]; // 0.4%, 0.5%, 0.6%

const PAIRS = [
  { symbol: "BNBUSDT",  name: "BNB"  },
  { symbol: "ATOMUSDT", name: "ATOM" },
];

const LOOKBACK_MS = 180 * 24 * 60 * 60 * 1000; // 6 months

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
  const start = upToIdx - CORR_WINDOW;
  for (let i = start; i <= upToIdx; i++) {
    spreads.push(Math.log(altCloses[i] / altCloses[i-1]) - Math.log(btcCloses[i] / btcCloses[i-1]));
  }
  if (spreads.length < CORR_WINDOW) return 0;
  const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const std  = Math.sqrt(spreads.reduce((a, b) => a + (b - mean) ** 2, 0) / spreads.length);
  if (std === 0) return 0;
  return (spreads[spreads.length - 1] - mean) / std;
}

function runBacktest(btcCloses: number[], altCloses: number[], tpPct: number) {
  let pnl = 0, wins = 0, losses = 0, expires = 0;
  let grossWin = 0, grossLoss = 0;
  let peak = ALLOCATION, maxDD = 0, runBal = ALLOCATION;
  let pos: { entry: number; sl: number; tp: number; hold: number } | null = null;

  for (let i = CORR_WINDOW + 1; i < btcCloses.length; i++) {
    const price = altCloses[i];

    if (pos) {
      pos.hold++;
      const hitTP  = price >= pos.tp;
      const hitSL  = price <= pos.sl;
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
        pos = { entry: price, sl: price * (1 - SL_PCT), tp: price * (1 + tpPct), hold: 0 };
      }
    }
  }

  const trades = wins + losses + expires;
  const winRate = trades > 0 ? (wins / trades * 100).toFixed(1) : "0.0";
  const pf      = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
  return { pnl, trades, wins, losses, expires, winRate, pf, maxDD };
}

async function main() {
  const now    = Date.now();
  const startMs = now - LOOKBACK_MS;

  console.log("Fetching 1m data (6 months)...");
  const btcCandles = await fetchAllKlines("BTCUSDT", "1m", startMs, now);
  console.log(`  BTCUSDT: ${btcCandles.length} candles`);

  const pairData: { name: string; btcArr: number[]; altArr: number[] }[] = [];

  for (const pair of PAIRS) {
    const altCandles = await fetchAllKlines(pair.symbol, "1m", startMs, now);
    console.log(`  ${pair.symbol}: ${altCandles.length} candles`);
    const altMap = new Map(altCandles.map(c => [c.time, c.close]));
    const btcArr: number[] = [], altArr: number[] = [];
    for (const c of btcCandles) {
      const ac = altMap.get(c.time);
      if (ac !== undefined) { btcArr.push(c.close); altArr.push(ac); }
    }
    pairData.push({ name: pair.name, btcArr, altArr });
  }

  console.log("\n");
  console.log("╔═══════════════════════════════════════════════════════════════════════════╗");
  console.log("║         Z-SCORE BOT — TP SWEEP  (hold=6, SL=0.4%, 1m, 6-month)          ║");
  console.log("╠══════╤══════╤════════╤════════╤══════════╤══════╤════════╤═══════════════╣");
  console.log("║ Pair │  TP  │ PnL($) │ Trades │ Win Rate │  PF  │ MaxDD% │ Expires       ║");
  console.log("╠══════╪══════╪════════╪════════╪══════════╪══════╪════════╪═══════════════╣");

  const rows: { name: string; tp: number; r: ReturnType<typeof runBacktest> }[] = [];

  for (const { name, btcArr, altArr } of pairData) {
    for (const tp of TP_VARIANTS) {
      const r = runBacktest(btcArr, altArr, tp);
      rows.push({ name, tp, r });

      const pnlSign = r.pnl >= 0 ? "+" : "";
      const row = [
        name.padEnd(4),
        `${(tp * 100).toFixed(1)}%`.padStart(4),
        `${pnlSign}${r.pnl.toFixed(0)}`.padStart(6),
        String(r.trades).padStart(6),
        `${r.winRate}%`.padStart(8),
        r.pf.padStart(4),
        `${r.maxDD.toFixed(2)}%`.padStart(6),
        `${r.expires} (${r.trades > 0 ? (r.expires / r.trades * 100).toFixed(0) : 0}%)`.padEnd(13),
      ];
      console.log(`║ ${row.join(" │ ")} ║`);
    }
    console.log("╠══════╪══════╪════════╪════════╪══════════╪══════╪════════╪═══════════════╣");
  }

  console.log("╚══════╧══════╧════════╧════════╧══════════╧══════╧════════╧═══════════════╝");

  console.log("\n── Best TP per pair (by PnL) ──");
  for (const { name, btcArr, altArr } of pairData) {
    const best = rows
      .filter(r => r.name === name)
      .reduce((a, b) => a.r.pnl > b.r.pnl ? a : b);
    console.log(`  ${name}: TP=${(best.tp * 100).toFixed(1)}% → $${best.r.pnl >= 0 ? "+" : ""}${best.r.pnl.toFixed(0)} | WR ${best.r.winRate}% | PF ${best.r.pf}`);
  }

  // Also show combined PnL (BNB + ATOM) per TP
  console.log("\n── Combined BNB+ATOM PnL per TP ──");
  for (const tp of TP_VARIANTS) {
    const combined = rows.filter(r => r.tp === tp).reduce((s, r) => s + r.r.pnl, 0);
    console.log(`  TP ${(tp * 100).toFixed(1)}%: $${combined >= 0 ? "+" : ""}${combined.toFixed(0)} total`);
  }
}

main().catch(console.error);
