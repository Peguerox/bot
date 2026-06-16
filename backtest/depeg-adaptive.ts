// Adaptive USDT/USD market making — quote around rolling 24h median instead of fixed peg levels
// Buy at ref - N ticks, sell at ref + M ticks. Sell level re-quotes as ref drifts -> losses possible.
// STRICT fills only (price must trade 1 tick through the level). 0% maker fee (verified).
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US = "https://api.binance.us/api/v3";
const KEY = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000;
const ALLOC = 25;
const TICK = 0.0001;
const WINDOW = 1440;       // 24h of 1m candles
const REPRICE_EVERY = 60;  // recompute ref hourly

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
    if (++reqs % 100 === 0) process.stdout.write(".");
    await sleep(100);
  }
  return candles;
}

const roundTick = (p: number) => Math.round(p / TICK) * TICK;

type Trade = { time: number; pnl: number };

function run(candles: Candle[], offBuy: number, offSell: number): Trade[] {
  const trades: Trade[] = [];
  let ref = 0;
  let pos: { entry: number; since: number } | null = null;

  for (let i = WINDOW; i < candles.length; i++) {
    if ((i - WINDOW) % REPRICE_EVERY === 0) {
      const win = candles.slice(i - WINDOW, i).map(c => c.close).sort((a, b) => a - b);
      ref = roundTick(win[Math.floor(win.length / 2)]);
    }
    const c = candles[i];
    const buyLvl = ref - offBuy * TICK;
    const sellLvl = ref + offSell * TICK;

    if (!pos) {
      if (c.low <= buyLvl - TICK) pos = { entry: buyLvl, since: c.time };  // strict fill
    } else if (c.high >= sellLvl + TICK) {                                  // strict fill
      trades.push({ time: c.time, pnl: (sellLvl - pos.entry) * (ALLOC / pos.entry) });
      pos = null;
    }
  }
  return trades;
}

function stats(trades: Trade[], sinceMs?: number) {
  const t = sinceMs ? trades.filter(x => x.time >= sinceMs) : trades;
  const pnl = t.reduce((a, x) => a + x.pnl, 0);
  const wins = t.filter(x => x.pnl >= 0).length;
  return { n: t.length, pnl, wr: t.length ? wins / t.length * 100 : 0 };
}

(async () => {
  console.log("\nADAPTIVE USDT/USD MM — quote around rolling 24h median | 1y | 1m | strict fills | $25\n");
  process.stdout.write("Fetching ");
  const candles = await fetchKlines("USDTUSD");
  console.log(` ${candles.length} candles\n`);

  const variants: [number, number, string][] = [
    [1, 1, "buy ref-1t, sell ref+1t (0.02%)"],
    [2, 1, "buy ref-2t, sell ref+1t (0.03%)"],
    [2, 2, "buy ref-2t, sell ref+2t (0.04%)"],
    [3, 2, "buy ref-3t, sell ref+2t (0.05%)"],
  ];

  const D90 = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const D180 = Date.now() - 180 * 24 * 60 * 60 * 1000;

  console.log("  Variant                              Year: Tr    WR%     PnL$  |  Last180d: Tr    PnL$  |  Last90d: Tr   /day    PnL$");
  console.log("  " + "─".repeat(116));

  let best: { label: string; trades: Trade[]; pnl90: number } | null = null;

  for (const [ob, os, label] of variants) {
    const tr = run(candles, ob, os);
    const y = stats(tr), h = stats(tr, D180), q = stats(tr, D90);
    const f = (x: number) => `${x >= 0 ? "+" : ""}$${x.toFixed(2)}`;
    console.log(
      `  ${label}`.padEnd(39) +
      `${y.n}`.padStart(6) +
      `  ${y.wr.toFixed(0)}%`.padStart(6) +
      `  ${f(y.pnl)}`.padStart(9) +
      `  |  ${h.n}`.padStart(9) +
      `  ${f(h.pnl)}`.padStart(9) +
      `  |  ${q.n}`.padStart(8) +
      `  ${(q.n / 90).toFixed(1)}`.padStart(6) +
      `  ${f(q.pnl)}`.padStart(9)
    );
    if (!best || q.pnl > best.pnl90) best = { label, trades: tr, pnl90: q.pnl };
  }

  if (best) {
    console.log(`\n  ── MONTHLY — best recent variant: ${best.label} ──`);
    const byMonth = new Map<string, { pnl: number; n: number }>();
    for (const t of best.trades) {
      const d = new Date(t.time);
      const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const m = byMonth.get(k) ?? { pnl: 0, n: 0 };
      m.pnl += t.pnl; m.n++;
      byMonth.set(k, m);
    }
    console.log("  Month     Trades   /day      PnL$      Ret%");
    console.log("  " + "─".repeat(48));
    for (const [k, m] of [...byMonth.entries()].sort()) {
      const sign = m.pnl >= 0 ? "+" : "";
      console.log(
        `  ${k}` +
        `${m.n}`.padStart(8) +
        `  ${(m.n / 30).toFixed(1)}`.padStart(7) +
        `  ${sign}$${m.pnl.toFixed(2)}`.padStart(10) +
        `  ${sign}${(m.pnl / ALLOC * 100).toFixed(1)}%`.padStart(8)
      );
    }

    const byWeek = new Map<string, number>();
    for (const t of best.trades) {
      const d = new Date(t.time);
      const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      const dow = (day.getUTCDay() + 6) % 7;
      day.setUTCDate(day.getUTCDate() - dow);
      const k = day.toISOString().slice(0, 10);
      byWeek.set(k, (byWeek.get(k) ?? 0) + t.pnl);
    }
    const weeks = [...byWeek.entries()].sort();
    const posW = weeks.filter(([, p]) => p > 0).length;
    const worst = weeks.reduce((a, b) => (b[1] < a[1] ? b : a));
    console.log(`\n  Weeks with trades: ${weeks.length}/53 | positive: ${posW}/${weeks.length} | worst week: ${worst[0]} ${worst[1] >= 0 ? "+" : ""}$${worst[1].toFixed(2)}`);
  }
  console.log();
})();
