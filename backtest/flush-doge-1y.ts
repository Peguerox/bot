// Flush Bounce on DOGE — 1 full year of 1m candles, monthly + weekly PnL
// drop >=0.5% in one 1m candle -> market buy next open, TP +0.4%, SL -0.3%, hold 20
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US = "https://api.binance.us/api/v3";
const KEY = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000;
const ALLOC = 25;
const ENTRY_SLIP = 1.0002;
const MIN_DROP = 0.005, TP = 0.004, SL = 0.003, MAX_HOLD = 20;

type Candle = { time: number; open: number; high: number; low: number; close: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string): Promise<Candle[]> {
  const candles: Candle[] = [];
  let from = Date.now() - LOOKBACK_MS, end = Date.now();
  let reqs = 0;
  while (from < end) {
    const res = await fetch(`${BASE_US}/klines?symbol=${symbol}&interval=1m&startTime=${from}&endTime=${end}&limit=1000`, { headers: { "X-MBX-APIKEY": KEY } });
    if (res.status === 429) { await sleep(10000); continue; }
    const raw = await res.json() as any;
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) candles.push({
      time: Number(c[0]), open: parseFloat(c[1]), high: parseFloat(c[2]),
      low: parseFloat(c[3]), close: parseFloat(c[4]),
    });
    from = Number(raw[raw.length - 1][0]) + 1;
    if (++reqs % 50 === 0) process.stdout.write(`${reqs * 1000} `);
    await sleep(100);
  }
  return candles;
}

type Trade = { time: number; pnl: number };

function run(candles: Candle[]): Trade[] {
  const trades: Trade[] = [];
  let pos: { entry: number; tp: number; sl: number; hold: number; time: number } | null = null;

  for (let i = 1; i < candles.length - 1; i++) {
    const next = candles[i + 1];
    if (pos) {
      pos.hold++;
      const qty = ALLOC / pos.entry;
      let exit: number | null = null;
      if (next.low <= pos.sl) exit = pos.sl;
      else if (next.high >= pos.tp) exit = pos.tp;
      else if (pos.hold >= MAX_HOLD) exit = next.close;
      if (exit !== null) {
        trades.push({ time: pos.time, pnl: (exit - pos.entry) * qty });
        pos = null;
      }
      continue;
    }
    const drop = (candles[i].close - candles[i].open) / candles[i].open;
    if (drop <= -MIN_DROP) {
      const entry = next.open * ENTRY_SLIP;
      pos = { entry, tp: entry * (1 + TP), sl: entry * (1 - SL), hold: 0, time: next.time };
    }
  }
  return trades;
}

(async () => {
  console.log("\nFLUSH BOUNCE — DOGEUSDT | 1 year | 1m | drop>=0.5% TP0.4 SL0.3 h20 | $25/trade\n");
  process.stdout.write("Fetching 1 year of 1m candles (~525k)... ");
  const candles = await fetchKlines("DOGEUSDT");
  console.log(`\n${candles.length} candles fetched\n`);

  const trades = run(candles);
  const tot = trades.reduce((a, t) => a + t.pnl, 0);
  const wins = trades.filter(t => t.pnl >= 0).length;
  const gW = trades.filter(t => t.pnl >= 0).reduce((a, t) => a + t.pnl, 0);
  const gL = Math.abs(trades.filter(t => t.pnl < 0).reduce((a, t) => a + t.pnl, 0));

  // Monthly
  const byMonth = new Map<string, { pnl: number; n: number; w: number }>();
  for (const t of trades) {
    const d = new Date(t.time);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const m = byMonth.get(key) ?? { pnl: 0, n: 0, w: 0 };
    m.pnl += t.pnl; m.n++; if (t.pnl >= 0) m.w++;
    byMonth.set(key, m);
  }

  console.log("  ── MONTHLY PnL ──");
  console.log("  Month     Trades   WR%      PnL$      Ret%");
  console.log("  " + "─".repeat(46));
  let posM = 0;
  for (const [key, m] of [...byMonth.entries()].sort()) {
    const sign = m.pnl >= 0 ? "+" : "";
    if (m.pnl >= 0) posM++;
    console.log(
      `  ${key}` +
      `${m.n}`.padStart(8) +
      `  ${(m.w / m.n * 100).toFixed(0)}%`.padStart(7) +
      `  ${sign}$${m.pnl.toFixed(2)}`.padStart(9) +
      `  ${sign}${(m.pnl / ALLOC * 100).toFixed(1)}%`.padStart(8)
    );
  }
  console.log(`\n  Positive months: ${posM}/${byMonth.size}`);

  // Weekly
  const byWeek = new Map<string, number>();
  for (const t of trades) {
    const d = new Date(t.time);
    const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dow = (day.getUTCDay() + 6) % 7;
    day.setUTCDate(day.getUTCDate() - dow);
    const key = day.toISOString().slice(0, 10);
    byWeek.set(key, (byWeek.get(key) ?? 0) + t.pnl);
  }

  const weeks = [...byWeek.entries()].sort();
  const posW = weeks.filter(([, p]) => p >= 0).length;

  console.log(`\n  ── WEEKLY PnL ──   ${posW}/${weeks.length} weeks positive`);
  console.log("  " + "─".repeat(72));
  const cols = 3;
  const rowsN = Math.ceil(weeks.length / cols);
  const lines: string[] = [];
  for (let r = 0; r < rowsN; r++) {
    let line = "  ";
    for (let c = 0; c < cols; c++) {
      const w = weeks[r + c * rowsN];
      if (!w) continue;
      const sign = w[1] >= 0 ? "+" : "";
      line += `${w[0]}  ${sign}$${w[1].toFixed(2)}`.padEnd(24);
    }
    lines.push(line);
  }
  console.log(lines.join("\n"));

  const sign = tot >= 0 ? "+" : "";
  const pf = gL > 0 ? (gW / gL).toFixed(2) : "inf";
  console.log(`\n  TOTAL: ${sign}$${tot.toFixed(2)} (${sign}${(tot / ALLOC * 100).toFixed(1)}% on $25)  |  ${trades.length} trades (${(trades.length / 365).toFixed(1)}/day)  |  WR ${(wins / trades.length * 100).toFixed(1)}%  |  PF ${pf}`);
  const losingWeeks = weeks.filter(([, p]) => p < 0);
  if (losingWeeks.length) {
    const worst = losingWeeks.reduce((a, b) => (b[1] < a[1] ? b : a));
    console.log(`  Worst week: ${worst[0]}  $${worst[1].toFixed(2)}`);
  }
  console.log();
})();
