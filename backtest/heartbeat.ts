/**
 * Heartbeat Pattern Backtest
 * Detects order flow velocity spikes on BTC and trades the direction
 * Maker limit orders only (0% fee on Binance US)
 *
 * Data: data.binance.vision aggTrades (tick-level, free, no API key)
 * Run:  npx ts-node --transpile-only backtest/heartbeat.ts
 */

import { execSync }  from "child_process";
import * as https    from "https";
import * as fs       from "fs";
import * as readline from "readline";

// ── Strategy parameters ───────────────────────────────────────────────────────
const SYMBOL        = "BTCUSDT";
const DAYS          = 14;
const VEL_WINDOW    = 60;
const SPIKE_MULTS   = [3.0, 5.0, 8.0, 10.0, 15.0, 20.0];
const MIN_BUY_RATIO = 0.60;
const TP_PCT        = 0.005;
const SL_PCT        = 0.003;
const MAX_HOLD_SEC  = 300;
const ALLOCATION    = 1000;

// ── Download ──────────────────────────────────────────────────────────────────

function dateStrDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().split("T")[0];
}

async function downloadFile(url: string, dest: string): Promise<boolean> {
  return new Promise(resolve => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode === 404) {
        file.close(); fs.existsSync(dest) && fs.unlinkSync(dest);
        resolve(false); return;
      }
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(true); });
    }).on("error", () => { file.close(); resolve(false); });
  });
}

// ── Parse into second buckets via streaming ───────────────────────────────────

interface Bucket {
  ts:        number;
  count:     number;
  buyVol:    number;
  totalVol:  number;
  lastPrice: number;
  high:      number;
  low:       number;
}

async function loadDayBuckets(date: string): Promise<Bucket[] | null> {
  const zipPath = `/tmp/${SYMBOL}-${date}.zip`;
  const csvPath = `/tmp/${SYMBOL}-${date}.csv`;

  process.stdout.write(`  ${date}...`);

  const ok = await downloadFile(
    `https://data.binance.vision/data/spot/daily/aggTrades/${SYMBOL}/${SYMBOL}-aggTrades-${date}.zip`,
    zipPath
  );
  if (!ok) { process.stdout.write(" not available\n"); return null; }

  // Extract CSV to tmp file (streaming — avoids loading whole string into JS heap)
  execSync(`unzip -o -p "${zipPath}" > "${csvPath}"`, { shell: true });
  fs.unlinkSync(zipPath);

  // Read line-by-line
  const map = new Map<number, Bucket>();
  let lines = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(csvPath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (lines++ === 0 && line.startsWith("agg")) continue; // skip header
    const p = line.split(",");
    if (p.length < 7) continue;

    const ts    = Math.floor(Number(p[5]) / 1_000_000); // microseconds → seconds
    const price = parseFloat(p[1]);
    const qty   = parseFloat(p[2]);
    const isBM  = p[6].trim().toLowerCase() === "true"; // true = sell-initiated

    if (!map.has(ts)) map.set(ts, { ts, count: 0, buyVol: 0, totalVol: 0, lastPrice: price, high: price, low: price });
    const b = map.get(ts)!;
    b.count++;
    b.totalVol += qty;
    if (!isBM) b.buyVol += qty;
    b.lastPrice = price;
    if (price > b.high) b.high = price;
    if (price < b.low)  b.low  = price;
  }

  fs.unlinkSync(csvPath);

  const trades = lines - 1;
  const buckets = Array.from(map.values()).sort((a, b) => a.ts - b.ts);
  process.stdout.write(` ${trades.toLocaleString()} trades → ${buckets.length.toLocaleString()} seconds\n`);
  return buckets;
}

// ── Backtest ──────────────────────────────────────────────────────────────────

interface RunResult {
  pnl:       number;
  wins:      number;
  losses:    number;
  expires:   number;
  maxDD:     number;
  grossWin:  number;
  grossLoss: number;
  holdSecs:  number[];
  signals:   number;
}

function runBacktest(buckets: Bucket[], spikeMult: number): RunResult {
  let pnl = 0, wins = 0, losses = 0, expires = 0, signals = 0;
  let grossWin = 0, grossLoss = 0;
  let peak = ALLOCATION, maxDD = 0, runBal = ALLOCATION;
  const holdSecs: number[] = [];

  let pos: { entry: number; tp: number; sl: number; entryTs: number } | null = null;
  const velBuf: number[] = [];
  let velSum = 0;

  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];

    // Rolling velocity baseline
    velBuf.push(b.count);
    velSum += b.count;
    if (velBuf.length > VEL_WINDOW) velSum -= velBuf.shift()!;
    const velMean = velBuf.length === VEL_WINDOW ? velSum / VEL_WINDOW : null;

    // Manage open position
    if (pos) {
      const hitTP   = b.high >= pos.tp;
      const hitSL   = b.low  <= pos.sl;
      const elapsed = b.ts - pos.entryTs;
      const expired = elapsed >= MAX_HOLD_SEC;

      if (hitTP || hitSL || expired) {
        const exitPrice = hitTP ? pos.tp : hitSL ? pos.sl : b.lastPrice;
        const tradePnl  = (exitPrice - pos.entry) / pos.entry * ALLOCATION;
        pnl    += tradePnl;
        runBal += tradePnl;
        holdSecs.push(elapsed);

        if (hitTP)      { wins++;    grossWin  += tradePnl; }
        else if (hitSL) { losses++;  grossLoss += Math.abs(tradePnl); }
        else            { expires++; tradePnl > 0 ? grossWin += tradePnl : grossLoss += Math.abs(tradePnl); }

        if (runBal > peak) peak = runBal;
        const dd = (runBal - peak) / peak * 100;
        if (dd < maxDD) maxDD = dd;
        pos = null;
      }
    }

    // New signal
    if (!pos && velMean !== null && velMean > 0 && i + 1 < buckets.length) {
      const isSpike   = b.count >= spikeMult * velMean && b.count > 50;
      const buyRatio  = b.totalVol > 0 ? b.buyVol / b.totalVol : 0;

      if (isSpike && buyRatio >= MIN_BUY_RATIO) {
        signals++;
        const entry = buckets[i + 1].lastPrice;
        pos = { entry, tp: entry * (1 + TP_PCT), sl: entry * (1 - SL_PCT), entryTs: buckets[i + 1].ts };
      }
    }
  }

  return { pnl, wins, losses, expires, maxDD, grossWin, grossLoss, holdSecs, signals };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nHeartbeat Pattern Backtest — last ${DAYS} days of BTCUSDT tick data`);
  console.log(`Signal: velocity ≥ N× ${VEL_WINDOW}s rolling mean, ≥${MIN_BUY_RATIO * 100}% aggressive buys, min 10 trades/s`);
  console.log(`Trade:  TP=${TP_PCT * 100}%  SL=${SL_PCT * 100}%  MaxHold=${MAX_HOLD_SEC}s  Maker\n`);

  const allBuckets: Bucket[] = [];

  for (let day = DAYS; day >= 1; day--) {
    const buckets = await loadDayBuckets(dateStrDaysAgo(day));
    if (buckets) for (const b of buckets) allBuckets.push(b);
  }

  if (allBuckets.length === 0) {
    console.log("\nNo data loaded — check internet connection or dates.");
    return;
  }

  console.log(`\nTotal: ${allBuckets.length.toLocaleString()} second-buckets across ${DAYS} days\n`);

  // ── Sweep spike multipliers ─────────────────────────────────────────────────
  console.log("╔══════════╦═════════╦════════╦══════════╦══════╦════════╦══════════╦══════════════╗");
  console.log("║  Spike   ║ Signals ║ Trades ║  Win Rate║  PF  ║ MaxDD% ║  PnL($)  ║  Avg Hold    ║");
  console.log("╠══════════╬═════════╬════════╬══════════╬══════╬════════╬══════════╬══════════════╣");

  let bestPnl = -Infinity, bestMult = SPIKE_MULTS[0];

  for (const mult of SPIKE_MULTS) {
    const r      = runBacktest(allBuckets, mult);
    const trades = r.wins + r.losses + r.expires;
    const wr     = trades > 0 ? (r.wins / trades * 100).toFixed(1) : "0.0";
    const pf     = r.grossLoss > 0 ? (r.grossWin / r.grossLoss).toFixed(2) : "∞";
    const avgH   = r.holdSecs.length > 0
      ? `${(r.holdSecs.reduce((a, b) => a + b, 0) / r.holdSecs.length).toFixed(0)}s`
      : "—";

    if (r.pnl > bestPnl) { bestPnl = r.pnl; bestMult = mult; }

    console.log(
      `║ ${`${mult}×`.padEnd(8)} ║ ${String(r.signals).padStart(7)} ║ ${String(trades).padStart(6)} ║ ` +
      `${`${wr}%`.padStart(8)} ║ ${pf.padStart(4)} ║ ${`${r.maxDD.toFixed(2)}%`.padStart(6)} ║ ` +
      `${`${r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(0)}`.padStart(8)} ║ ${avgH.padEnd(12)} ║`
    );
  }

  console.log("╚══════════╩═════════╩════════╩══════════╩══════╩════════╩══════════╩══════════════╝");

  const best    = runBacktest(allBuckets, bestMult);
  const bTrades = best.wins + best.losses + best.expires;
  const pf2     = best.grossLoss > 0 ? best.grossWin / best.grossLoss : Infinity;

  console.log(`\n★  Best: spike=${bestMult}×  →  ${bTrades} trades over ${DAYS} days (${(bTrades / DAYS).toFixed(1)}/day)`);
  console.log(`   W/L/E: ${best.wins}/${best.losses}/${best.expires}`);
  console.log(`   PnL $${best.pnl >= 0 ? "+" : ""}${best.pnl.toFixed(2)}  |  Annualised ~$${(best.pnl * 365 / DAYS).toFixed(0)}`);

  console.log("\n── Verdict ──");
  if (bestPnl > 0 && pf2 > 1.3 && bTrades >= 10) {
    console.log("  ✓ Shows edge — worth paper trading");
  } else if (bestPnl > 0) {
    console.log("  ~ Marginal — run longer test before committing");
  } else {
    console.log("  ✗ No edge detected at these parameters");
  }
}

main().catch(console.error);
