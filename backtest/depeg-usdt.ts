// USDT depeg scalp — 1 year of 1m USDTUSD on Binance.US
// Standing limit buy below peg, sell on re-peg. How often does it fire and pay?
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US = "https://api.binance.us/api/v3";
const KEY = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000;
const ALLOC = 25;

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

(async () => {
  console.log("\nUSDT DEPEG SCALP — USDTUSD on Binance.US | 1 year | 1m\n");
  process.stdout.write("Fetching ");
  const candles = await fetchKlines("USDTUSD");
  console.log(` ${candles.length} candles\n`);
  if (!candles.length) { console.log("  No data — pair may not exist."); return; }

  // Distribution: how often does price dip below thresholds?
  const TH = [0.9995, 0.999, 0.998, 0.997, 0.995, 0.99];
  console.log("  ── TIME BELOW PEG ──");
  console.log("  Threshold   Minutes   % of time   Min print");
  console.log("  " + "─".repeat(48));
  let minLow = Infinity;
  for (const c of candles) if (c.low < minLow) minLow = c.low;
  for (const t of TH) {
    const m = candles.filter(c => c.low <= t).length;
    console.log(
      `  ${t.toFixed(4)}`.padEnd(13) +
      `${m}`.padStart(7) +
      `  ${(m / candles.length * 100).toFixed(3)}%`.padStart(10) +
      (t === TH[0] ? `  ${minLow.toFixed(4)}`.padStart(12) : "")
    );
  }

  // Sim: standing limit buy at B, then sell limit at S. One position at a time.
  // touch mode: fill when price touches level (optimistic — assumes front of queue)
  // strict mode: fill only when price trades THROUGH level by 1 tick (pessimistic — assumes back of queue)
  const TICK = 0.0001;
  const combos: [number, number][] = [
    [0.9995, 0.9999],
    [0.999, 0.9995],
    [0.998, 0.999],
    [0.997, 0.999],
    [0.995, 0.998],
  ];

  // Monthly + weekly breakdown for strict-fill buy 0.9990 / sell 0.9995
  {
    const B = 0.999, S = 0.9995;
    type Trade = { time: number; pnl: number };
    const trades: Trade[] = [];
    let pos: { qty: number; since: number } | null = null;
    for (const c of candles) {
      if (!pos) {
        if (c.low <= B - TICK) pos = { qty: ALLOC / B, since: c.time };
      } else if (c.high >= S + TICK) {
        trades.push({ time: c.time, pnl: pos.qty * (S - B) });
        pos = null;
      }
    }

    const byMonth = new Map<string, { pnl: number; n: number }>();
    const byWeek = new Map<string, number>();
    for (const t of trades) {
      const d = new Date(t.time);
      const mk = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const m = byMonth.get(mk) ?? { pnl: 0, n: 0 };
      m.pnl += t.pnl; m.n++;
      byMonth.set(mk, m);
      const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      const dow = (day.getUTCDay() + 6) % 7;
      day.setUTCDate(day.getUTCDate() - dow);
      const wk = day.toISOString().slice(0, 10);
      byWeek.set(wk, (byWeek.get(wk) ?? 0) + t.pnl);
    }

    console.log(`\n  ── STRICT buy ${B} / sell ${S} — MONTHLY ──`);
    console.log("  Month     Trades   /day      PnL$      Ret%");
    console.log("  " + "─".repeat(48));
    for (const [k, m] of [...byMonth.entries()].sort()) {
      console.log(
        `  ${k}` +
        `${m.n}`.padStart(8) +
        `  ${(m.n / 30).toFixed(1)}`.padStart(7) +
        `  +$${m.pnl.toFixed(2)}`.padStart(10) +
        `  +${(m.pnl / ALLOC * 100).toFixed(1)}%`.padStart(8)
      );
    }

    const weeks = [...byWeek.entries()].sort();
    const posW = weeks.filter(([, p]) => p > 0).length;
    const worst = weeks.reduce((a, b) => (b[1] < a[1] ? b : a));
    const best = weeks.reduce((a, b) => (b[1] > a[1] ? b : a));
    console.log(`\n  Weeks with trades: ${weeks.length}/53 | positive: ${posW}/${weeks.length}`);
    console.log(`  Best week: ${best[0]} +$${best[1].toFixed(2)} | worst: ${worst[0]} +$${worst[1].toFixed(2)}`);
    console.log(`  Total: +$${trades.reduce((a, t) => a + t.pnl, 0).toFixed(2)} | ${trades.length} trades | ${(trades.length / 365).toFixed(1)}/day avg`);
  }

  for (const strict of [false, true]) {
    console.log(`\n  ── SCALP SIM (${strict ? "STRICT fills: trade-through 1 tick" : "TOUCH fills: optimistic"}, 0% maker fee) ──`);
    console.log("  Buy@      Sell@     Fills   AvgHoldMin   PnL$      Ret%/yr on $25");
    console.log("  " + "─".repeat(68));

    for (const [B, S] of combos) {
      const buyFillAt = strict ? B - TICK : B;   // strict: price must trade one tick through
      const sellFillAt = strict ? S + TICK : S;
      let pnl = 0, fills = 0, holdSum = 0;
      let pos: { qty: number; since: number } | null = null;
      for (const c of candles) {
        if (!pos) {
          if (c.low <= buyFillAt) pos = { qty: ALLOC / B, since: c.time };
        } else if (c.high >= sellFillAt) {
          pnl += pos.qty * (S - B);
          fills++;
          holdSum += (c.time - pos.since) / 60000;
          pos = null;
        }
      }
      const sign = pnl >= 0 ? "+" : "";
      console.log(
        `  ${B.toFixed(4)}    ${S.toFixed(4)}` +
        `${fills}`.padStart(8) +
        `${fills ? (holdSum / fills).toFixed(0) : "-"}`.padStart(11) +
        `  ${sign}$${pnl.toFixed(2)}`.padStart(10) +
        `  ${sign}${(pnl / ALLOC * 100).toFixed(1)}%`.padStart(10)
      );
    }
  }
  console.log();
})();
