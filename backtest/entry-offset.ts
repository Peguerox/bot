/**
 * Entry offset comparison: close price vs +0.1% above close
 * ATOM only, 1 month, live settings (TP=0.8%, SL=0.3%, Hold=6)
 * $200 allocation matching live bot
 *
 * Run: npx ts-node --transpile-only backtest/entry-offset.ts
 */

const BINANCE_BASE = "https://api.binance.us/api/v3";
const BINANCE_KEY  = process.env.BINANCE_API_KEY ?? "";

const CORR_WINDOW  = 20;
const Z_THRESH     = 2.0;
const MAX_HOLD     = 6;
const TP_PCT       = 0.008;   // 0.8%
const SL_PCT       = 0.003;   // 0.3%
const ALLOCATION   = 200;     // $200 live
const LOOKBACK_MS  = 30 * 24 * 60 * 60 * 1000; // 1 month

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string, startMs: number, endMs: number) {
  const candles: { time: number; close: number }[] = [];
  let from = startMs;
  while (from < endMs) {
    const url = `${BINANCE_BASE}/klines?symbol=${symbol}&interval=1m` +
                `&startTime=${from}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url, { headers: { "X-MBX-APIKEY": BINANCE_KEY } });
    if (res.status === 429) { await sleep(10_000); continue; }
    if (!res.ok) throw new Error(`Binance ${res.status} ${symbol}`);
    const raw = await res.json() as string[][];
    if (!raw.length) break;
    for (const c of raw) candles.push({ time: Number(c[0]), close: parseFloat(c[4]) });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(120);
  }
  return candles;
}

function calcZ(btc: number[], alt: number[], i: number): number {
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

interface Trade {
  entry: number;
  tp: number;
  sl: number;
  result: "TP" | "SL" | "EXPIRE";
  pnl: number;
  exitPrice: number;
}

function runBacktest(btc: number[], alt: number[], entryOffset: number): {
  trades: Trade[];
  pnl: number;
  wins: number;
  losses: number;
  expires: number;
} {
  const trades: Trade[] = [];
  let pos: { entry: number; tp: number; sl: number; hold: number } | null = null;

  for (let i = CORR_WINDOW + 1; i < btc.length; i++) {
    const close = alt[i];

    if (pos) {
      pos.hold++;
      const hitTP   = close >= pos.tp;
      const hitSL   = close <= pos.sl;
      const expired = pos.hold >= MAX_HOLD;

      if (hitTP || hitSL || expired) {
        const exitPrice = hitTP ? pos.tp : hitSL ? pos.sl : close;
        const pnl       = (exitPrice - pos.entry) / pos.entry * ALLOCATION;
        const result    = hitTP ? "TP" : hitSL ? "SL" : "EXPIRE";
        trades.push({ entry: pos.entry, tp: pos.tp, sl: pos.sl, result, pnl, exitPrice });
        pos = null;
      }
    }

    if (!pos) {
      const z = calcZ(btc, alt, i);
      if (z <= -Z_THRESH) {
        // entryOffset = 0 → entry at close; entryOffset = 0.001 → 0.1% above close
        const entry = close * (1 + entryOffset);
        pos = {
          entry,
          tp: entry * (1 + TP_PCT),
          sl: entry * (1 - SL_PCT),
          hold: 0,
        };
      }
    }
  }

  const pnl    = trades.reduce((s, t) => s + t.pnl, 0);
  const wins   = trades.filter(t => t.result === "TP").length;
  const losses = trades.filter(t => t.result === "SL").length;
  const expires = trades.filter(t => t.result === "EXPIRE").length;
  return { trades, pnl, wins, losses, expires };
}

function bar(label: string, r: ReturnType<typeof runBacktest>) {
  const total   = r.trades.length;
  const wr      = total > 0 ? (r.wins / total * 100).toFixed(1) : "0.0";
  const avgPnl  = total > 0 ? (r.pnl / total).toFixed(3) : "0.000";
  const expPct  = total > 0 ? (r.expires / total * 100).toFixed(0) : "0";
  const sign    = r.pnl >= 0 ? "+" : "";
  console.log(`\n  ${label}`);
  console.log(`  ────────────────────────────────`);
  console.log(`  Trades : ${total}   (TP: ${r.wins}  SL: ${r.losses}  Expire: ${r.expires} [${expPct}%])`);
  console.log(`  Win rate: ${wr}%`);
  console.log(`  Total PnL: $${sign}${r.pnl.toFixed(2)}  (avg $${avgPnl} / trade)`);
  console.log(`  Final balance: $${(ALLOCATION + r.pnl).toFixed(2)}`);
}

async function main() {
  const now     = Date.now();
  const startMs = now - LOOKBACK_MS;

  const startDate = new Date(startMs).toISOString().slice(0, 10);
  const endDate   = new Date(now).toISOString().slice(0, 10);
  console.log(`\nFetching ATOM 1-month data (${startDate} → ${endDate})...`);

  const btcRaw  = await fetchKlines("BTCUSDT",  startMs, now);
  const atomRaw = await fetchKlines("ATOMUSDT", startMs, now);
  console.log(`  BTC: ${btcRaw.length} candles  |  ATOM: ${atomRaw.length} candles`);

  // Align on shared timestamps
  const atomMap = new Map(atomRaw.map(c => [c.time, c.close]));
  const btc: number[] = [], alt: number[] = [];
  for (const c of btcRaw) {
    const a = atomMap.get(c.time);
    if (a !== undefined) { btc.push(c.close); alt.push(a); }
  }
  console.log(`  Aligned: ${btc.length} candles`);

  const baseline = runBacktest(btc, alt, 0);
  const offset   = runBacktest(btc, alt, 0.001);

  console.log(`\n${"═".repeat(48)}`);
  console.log(`  ATOM  TP=${TP_PCT*100}%  SL=${SL_PCT*100}%  Hold=${MAX_HOLD}  $${ALLOCATION} alloc`);
  console.log(`${"═".repeat(48)}`);

  bar("Entry at close (current)", baseline);
  bar("Entry at close +0.1%    (new)", offset);

  // Side-by-side diff
  const diff     = offset.pnl - baseline.pnl;
  const diffSign = diff >= 0 ? "+" : "";
  console.log(`\n  ── Difference ──────────────────`);
  console.log(`  PnL delta : $${diffSign}${diff.toFixed(2)}`);
  console.log(`  Trade delta: ${offset.trades.length - baseline.trades.length} fewer signals fired`);
  if (baseline.trades.length > 0 && offset.trades.length > 0) {
    const wrBaseline = baseline.wins / baseline.trades.length * 100;
    const wrOffset   = offset.wins   / offset.trades.length   * 100;
    console.log(`  Win rate  : ${wrBaseline.toFixed(1)}% → ${wrOffset.toFixed(1)}%`);
  }
  console.log(`${"═".repeat(48)}\n`);
}

main().catch(console.error);
