/**
 * Z-Score Hold-Period Backtest
 * Tests MAX_HOLD = 3 vs 6 on timeframes 1m (6 months) and 5m (1 year)
 * Pairs: BNB and ATOM vs BTC
 *
 * Run: npx ts-node --skip-project backtest/zscore-holdtest.ts
 */

const BINANCE_BASE  = "https://api.binance.us/api/v3";
const BINANCE_KEY   = process.env.BINANCE_API_KEY ?? "";

const CORR_WINDOW   = 20;
const Z_THRESH      = 2.0;
const TP_PCT        = 0.006;   // 0.6%
const SL_PCT        = 0.004;   // 0.4%
const ALLOCATION    = 1000;    // USD per pair

const PAIRS = [
  { symbol: "BNBUSDT",  btcSymbol: "BTCUSDT", name: "BNB" },
  { symbol: "ATOMUSDT", btcSymbol: "BTCUSDT", name: "ATOM" },
];

const HOLD_VARIANTS  = [3, 6];
const TF_VARIANTS: { interval: string; label: string; lookbackMs: number }[] = [
  { interval: "1m", label: "1m",  lookbackMs: 180 * 24 * 60 * 60 * 1000 }, // 6 months
  { interval: "5m", label: "5m",  lookbackMs: 365 * 24 * 60 * 60 * 1000 }, // 1 year
];

// ── Binance fetch with pagination ─────────────────────────────────────────────

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAllKlines(symbol: string, interval: string, startMs: number, endMs: number) {
  const candles: { time: number; close: number }[] = [];
  let from = startMs;
  let pages = 0;

  while (from < endMs) {
    const url = `${BINANCE_BASE}/klines?symbol=${symbol}&interval=${interval}` +
                `&startTime=${from}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url, { headers: { "X-MBX-APIKEY": BINANCE_KEY } });

    if (res.status === 429) {
      console.log("  Rate limited — waiting 10s...");
      await sleep(10_000);
      continue;
    }
    if (!res.ok) throw new Error(`Binance ${res.status} for ${symbol} ${interval}`);

    const raw = await res.json() as string[][];
    if (!raw.length) break;

    for (const c of raw) {
      candles.push({ time: Number(c[0]), close: parseFloat(c[4]) });
    }

    from = Number(raw[raw.length - 1][0]) + 1;
    pages++;
    if (pages % 50 === 0) process.stdout.write(`    ${symbol} ${interval}: ${candles.length} candles fetched...\r`);
    await sleep(120); // ~500 req/min, well under 6000 weight/min with key
  }

  process.stdout.write("\n");
  return candles;
}

// ── Z-Score calculation ───────────────────────────────────────────────────────

function calcZScore(btcCloses: number[], altCloses: number[], upToIdx: number): number {
  if (upToIdx < CORR_WINDOW + 1) return 0;

  const spreads: number[] = [];
  const start = upToIdx - CORR_WINDOW; // compute CORR_WINDOW spreads ending at upToIdx
  for (let i = start; i <= upToIdx; i++) {
    const btcRet = Math.log(btcCloses[i] / btcCloses[i - 1]);
    const altRet = Math.log(altCloses[i] / altCloses[i - 1]);
    spreads.push(altRet - btcRet);
  }

  if (spreads.length < CORR_WINDOW) return 0;
  const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const std  = Math.sqrt(spreads.reduce((a, b) => a + (b - mean) ** 2, 0) / spreads.length);
  if (std === 0) return 0;

  return (spreads[spreads.length - 1] - mean) / std;
}

// ── Single backtest run ───────────────────────────────────────────────────────

interface BacktestResult {
  pnl: number;
  trades: number;
  wins: number;
  losses: number;
  expires: number;
  maxDD: number;
  grossWin: number;
  grossLoss: number;
}

function runBacktest(btcCloses: number[], altCloses: number[], maxHold: number): BacktestResult {
  let pnl = 0, wins = 0, losses = 0, expires = 0;
  let grossWin = 0, grossLoss = 0;
  let peak = ALLOCATION, maxDD = 0, runBal = ALLOCATION;

  let pos: { entry: number; sl: number; tp: number; hold: number } | null = null;

  for (let i = CORR_WINDOW + 1; i < btcCloses.length; i++) {
    const price = altCloses[i];

    // Manage open position
    if (pos) {
      pos.hold++;
      const hitTP  = price >= pos.tp;
      const hitSL  = price <= pos.sl;
      const expired = pos.hold >= maxHold;

      if (hitTP || hitSL || expired) {
        const exitPrice = hitTP ? pos.tp : hitSL ? pos.sl : price;
        const tradePnl  = (exitPrice - pos.entry) / pos.entry * ALLOCATION;
        pnl    += tradePnl;
        runBal += tradePnl;

        if (hitTP) { wins++;   grossWin  += tradePnl; }
        else if (hitSL) { losses++; grossLoss += Math.abs(tradePnl); }
        else { expires++; if (tradePnl > 0) grossWin += tradePnl; else grossLoss += Math.abs(tradePnl); }

        if (runBal > peak) peak = runBal;
        const dd = (runBal - peak) / peak * 100;
        if (dd < maxDD) maxDD = dd;

        pos = null;
      }
    }

    // Look for new signal (only when flat)
    if (!pos) {
      const z = calcZScore(btcCloses, altCloses, i);
      if (z <= -Z_THRESH) {
        pos = { entry: price, sl: price * (1 - SL_PCT), tp: price * (1 + TP_PCT), hold: 0 };
      }
    }
  }

  const trades = wins + losses + expires;
  return { pnl, trades, wins, losses, expires, maxDD, grossWin, grossLoss };
}

// ── Main ──────────────────────────────────────────────────────────────────────

interface Row {
  tf: string;
  pair: string;
  hold: number;
  pnl: number;
  trades: number;
  winRate: string;
  pf: string;
  maxDD: string;
  expires: number;
}

async function main() {
  const now = Date.now();
  const results: Row[] = [];

  for (const tf of TF_VARIANTS) {
    const startMs  = now - tf.lookbackMs;
    const periodLabel = tf.interval === "1m" ? "6-month" : "1-year";
    console.log(`\n=== Fetching ${tf.label} data (${periodLabel}) ===`);

    // Fetch BTC once per timeframe
    console.log(`  Fetching BTCUSDT ${tf.interval}...`);
    const btcCandles = await fetchAllKlines("BTCUSDT", tf.interval, startMs, now);
    console.log(`  BTCUSDT: ${btcCandles.length} candles`);

    for (const pair of PAIRS) {
      console.log(`  Fetching ${pair.symbol} ${tf.interval}...`);
      const altCandles = await fetchAllKlines(pair.symbol, tf.interval, startMs, now);
      console.log(`  ${pair.symbol}: ${altCandles.length} candles`);

      // Align arrays by time (inner join on timestamp)
      const altMap = new Map(altCandles.map(c => [c.time, c.close]));
      const btcArr: number[] = [], altArr: number[] = [];
      for (const c of btcCandles) {
        const altClose = altMap.get(c.time);
        if (altClose !== undefined) {
          btcArr.push(c.close);
          altArr.push(altClose);
        }
      }
      console.log(`  Aligned: ${btcArr.length} candles`);

      for (const hold of HOLD_VARIANTS) {
        const r = runBacktest(btcArr, altArr, hold);
        const winRate = r.trades > 0 ? (r.wins / r.trades * 100).toFixed(1) : "0.0";
        const pf      = r.grossLoss > 0 ? (r.grossWin / r.grossLoss).toFixed(2) : "∞";
        results.push({
          tf:       tf.label,
          pair:     pair.name,
          hold,
          pnl:      r.pnl,
          trades:   r.trades,
          winRate,
          pf,
          maxDD:    r.maxDD.toFixed(2),
          expires:  r.expires,
        });
      }
    }
  }

  // ── Print results table ───────────────────────────────────────────────────
  console.log("\n");
  console.log("╔══════════════════════════════════════════════════════════════════════════════════╗");
  console.log("║              Z-SCORE BOT — HOLD PERIOD BACKTEST RESULTS                         ║");
  console.log("╠════╤══════╤══════╤══════════╤════════╤══════════╤══════╤════════╤══════════════╣");
  console.log("║ TF │ Pair │ Hold │  PnL ($) │ Trades │ Win Rate │  PF  │ MaxDD% │ Expires      ║");
  console.log("╠════╪══════╪══════╪══════════╪════════╪══════════╪══════╪════════╪══════════════╣");

  for (const r of results) {
    const pnlSign = r.pnl >= 0 ? "+" : "";
    const row = [
      r.tf.padEnd(4),
      r.pair.padEnd(4),
      String(r.hold).padEnd(4),
      `${pnlSign}${r.pnl.toFixed(2)}`.padStart(8),
      String(r.trades).padStart(6),
      `${r.winRate}%`.padStart(8),
      r.pf.padStart(4),
      `${r.maxDD}%`.padStart(6),
      `${r.expires} (${r.trades > 0 ? (r.expires / r.trades * 100).toFixed(0) : 0}%)`.padEnd(12),
    ];
    console.log(`║ ${row.join(" │ ")} ║`);
  }
  console.log("╚════╧══════╧══════╧══════════╧════════╧══════════╧══════╧════════╧══════════════╝");

  // Summary: best config per pair
  console.log("\n── Best hold per pair/timeframe (by PnL) ──");
  const grouped = new Map<string, Row[]>();
  for (const r of results) {
    const key = `${r.tf}|${r.pair}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(r);
  }
  for (const [key, rows] of grouped) {
    const best = rows.reduce((a, b) => a.pnl > b.pnl ? a : b);
    const [tf, pair] = key.split("|");
    console.log(`  ${tf} ${pair}: hold=${best.hold} → $${best.pnl >= 0 ? "+" : ""}${best.pnl.toFixed(2)} PnL | ${best.winRate}% WR | PF ${best.pf}`);
  }
}

main().catch(console.error);
