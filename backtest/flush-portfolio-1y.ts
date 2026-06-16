// Flush Bounce portfolio (DOGE+ADA+SOL) — 1 year, 1m, with circuit-breaker variants
//   A: baseline (drop>=0.5% TP0.4 SL0.3 h20)
//   B: halt coin 24h after 3 consecutive SL exits
//   C: max 4 trades/day per coin (UTC)
//   D: B + C combined
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US = "https://api.binance.us/api/v3";
const KEY = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000;
const ALLOC = 25;
const ENTRY_SLIP = 1.0002;
const MIN_DROP = 0.005, TP = 0.004, SL = 0.003, MAX_HOLD = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

type Candle = { time: number; open: number; high: number; low: number; close: number };
type Trade = { time: number; pnl: number; isSL: boolean };

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
    if (++reqs % 100 === 0) process.stdout.write(".");
    await sleep(100);
  }
  return candles;
}

function run(candles: Candle[], useBreaker: boolean, maxPerDay: number): Trade[] {
  const trades: Trade[] = [];
  let pos: { entry: number; tp: number; sl: number; hold: number; time: number } | null = null;
  let consecSL = 0, haltUntil = 0;
  let dayKey = "", dayCount = 0;

  for (let i = 1; i < candles.length - 1; i++) {
    const next = candles[i + 1];
    if (pos) {
      pos.hold++;
      const qty = ALLOC / pos.entry;
      let exit: number | null = null, isSL = false;
      if (next.low <= pos.sl) { exit = pos.sl; isSL = true; }
      else if (next.high >= pos.tp) exit = pos.tp;
      else if (pos.hold >= MAX_HOLD) exit = next.close;
      if (exit !== null) {
        trades.push({ time: pos.time, pnl: (exit - pos.entry) * qty, isSL });
        if (isSL) {
          consecSL++;
          if (useBreaker && consecSL >= 3) { haltUntil = next.time + DAY_MS; consecSL = 0; }
        } else consecSL = 0;
        pos = null;
      }
      continue;
    }
    if (candles[i].time < haltUntil) continue;

    const d = new Date(candles[i].time);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    if (key !== dayKey) { dayKey = key; dayCount = 0; }
    if (maxPerDay > 0 && dayCount >= maxPerDay) continue;

    const drop = (candles[i].close - candles[i].open) / candles[i].open;
    if (drop <= -MIN_DROP) {
      const entry = next.open * ENTRY_SLIP;
      pos = { entry, tp: entry * (1 + TP), sl: entry * (1 - SL), hold: 0, time: next.time };
      dayCount++;
    }
  }
  return trades;
}

function monthKey(t: number) {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function weekKey(t: number) {
  const d = new Date(t);
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - dow);
  return day.toISOString().slice(0, 10);
}

function summarize(trades: Trade[]) {
  const tot = trades.reduce((a, t) => a + t.pnl, 0);
  const wins = trades.filter(t => t.pnl >= 0).length;
  const gW = trades.filter(t => t.pnl >= 0).reduce((a, t) => a + t.pnl, 0);
  const gL = Math.abs(trades.filter(t => t.pnl < 0).reduce((a, t) => a + t.pnl, 0));
  const byMonth = new Map<string, number>(), byWeek = new Map<string, number>();
  for (const t of trades) {
    byMonth.set(monthKey(t.time), (byMonth.get(monthKey(t.time)) ?? 0) + t.pnl);
    byWeek.set(weekKey(t.time), (byWeek.get(weekKey(t.time)) ?? 0) + t.pnl);
  }
  const months = [...byMonth.entries()].sort();
  const weeks = [...byWeek.entries()].sort();
  return {
    tot, n: trades.length, wr: trades.length ? wins / trades.length * 100 : 0,
    pf: gL > 0 ? gW / gL : Infinity,
    months, weeks,
    posM: months.filter(([, p]) => p >= 0).length,
    posW: weeks.filter(([, p]) => p >= 0).length,
    worstW: weeks.length ? weeks.reduce((a, b) => (b[1] < a[1] ? b : a)) : null,
  };
}

(async () => {
  const SYMBOLS = ["DOGEUSDT", "ADAUSDT", "SOLUSDT"];
  console.log("\nFLUSH BOUNCE PORTFOLIO — DOGE+ADA+SOL | 1 year | 1m | drop0.5 TP0.4 SL0.3 h20 | $25/trade\n");

  const data = new Map<string, Candle[]>();
  for (const s of SYMBOLS) {
    process.stdout.write(`Fetching ${s} (525k candles) `);
    data.set(s, await fetchKlines(s));
    console.log(` done (${data.get(s)!.length})`);
  }

  const variants: [string, boolean, number][] = [
    ["A: baseline", false, 0],
    ["B: halt 24h after 3 consec SL", true, 0],
    ["C: max 4 trades/day", false, 4],
    ["D: breaker + max 4/day", true, 4],
  ];

  let bestD: ReturnType<typeof summarize> | null = null;

  console.log("\n  ── VARIANT COMPARISON (portfolio = all 3 coins) ──");
  console.log("  Variant                            Trades   WR%    PF      PnL$     Ret%   Mo+   Wk+    WorstWk");
  console.log("  " + "─".repeat(100));

  for (const [label, breaker, maxDay] of variants) {
    const all: Trade[] = [];
    const perCoin: string[] = [];
    for (const s of SYMBOLS) {
      const tr = run(data.get(s)!, breaker, maxDay);
      all.push(...tr);
      const sub = tr.reduce((a, t) => a + t.pnl, 0);
      perCoin.push(`${s.replace("USDT", "")} ${sub >= 0 ? "+" : ""}$${sub.toFixed(2)}`);
    }
    all.sort((a, b) => a.time - b.time);
    const s = summarize(all);
    const sign = s.tot >= 0 ? "+" : "";
    console.log(
      `  ${label}`.padEnd(36) +
      `${s.n}`.padStart(6) +
      `  ${s.wr.toFixed(1)}%`.padStart(7) +
      `  ${s.pf === Infinity ? "inf" : s.pf.toFixed(2)}`.padStart(6) +
      `  ${sign}$${s.tot.toFixed(2)}`.padStart(9) +
      `  ${sign}${(s.tot / ALLOC * 100).toFixed(1)}%`.padStart(8) +
      `  ${s.posM}/${s.months.length}`.padStart(7) +
      `  ${s.posW}/${s.weeks.length}`.padStart(7) +
      `  ${s.worstW ? "$" + s.worstW[1].toFixed(2) : "-"}`.padStart(9)
    );
    console.log(`      └ ${perCoin.join("   ")}`);
    if (label.startsWith("D")) bestD = s;
  }

  if (bestD) {
    console.log("\n  ── VARIANT D — MONTHLY PnL (portfolio) ──");
    console.log("  Month        PnL$      Ret%");
    console.log("  " + "─".repeat(32));
    for (const [k, p] of bestD.months) {
      const sign = p >= 0 ? "+" : "";
      console.log(`  ${k}  ${sign}$${p.toFixed(2)}`.padEnd(20) + `${sign}${(p / ALLOC * 100).toFixed(1)}%`.padStart(8));
    }

    console.log(`\n  ── VARIANT D — WEEKLY PnL ──   ${bestD.posW}/${bestD.weeks.length} weeks positive`);
    console.log("  " + "─".repeat(72));
    const weeks = bestD.weeks;
    const cols = 3, rowsN = Math.ceil(weeks.length / cols);
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
  }
  console.log();
})();
