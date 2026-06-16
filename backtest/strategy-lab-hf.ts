// High-Frequency Lab — strategies that fire many times per day
// 1) Maker grid scalp: limit buy 0.15% below price, TP 0.15% above fill (both maker = no fee)
// 2) EMA20 stretch reversion
// 3) 5-minute cumulative drop bounce
// 4) Hourly drift table — which hours does price reliably rise?
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US = "https://api.binance.us/api/v3";
const KEY = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const ALLOC = 25;

type Candle = { time: number; open: number; high: number; low: number; close: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string): Promise<Candle[]> {
  const candles: Candle[] = [];
  let from = Date.now() - LOOKBACK_MS, end = Date.now();
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
    await sleep(120);
  }
  return candles;
}

type Result = { pnl: number; pct: number; wr: number; pf: number; trades: number; maxDD: number; perDay: number };

function finish(bal: number, peak: number, maxDD: number, trades: number, wins: number, gW: number, gL: number, days: number): Result {
  const pnl = bal - ALLOC, wr = trades > 0 ? wins / trades * 100 : 0, pf = gL > 0 ? gW / gL : Infinity;
  return { pnl, pct: pnl / ALLOC * 100, wr, pf, trades, maxDD, perDay: trades / days };
}

// 1) Maker grid scalp — limit buy `off` below close; if filled, TP limit `tp` above fill; SL market at `sl`
function gridScalp(candles: Candle[], off: number, tp: number, sl: number, maxHold: number): Result {
  let bal = ALLOC, peak = ALLOC, maxDD = 0, trades = 0, wins = 0, gW = 0, gL = 0;
  let pos: { entry: number; tp: number; sl: number; hold: number } | null = null;
  let order: { price: number } | null = null;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];

    if (pos) {
      pos.hold++;
      const qty = ALLOC / pos.entry;
      let exit: number | null = null;
      if (c.low <= pos.sl) exit = pos.sl;            // conservative: SL first
      else if (c.high >= pos.tp) exit = pos.tp;
      else if (pos.hold >= maxHold) exit = c.close;
      if (exit !== null) {
        const pnl = (exit - pos.entry) * qty;
        bal += pnl; trades++;
        if (pnl >= 0) { wins++; gW += pnl; } else gL += Math.abs(pnl);
        if (bal > peak) peak = bal;
        if ((peak - bal) / peak * 100 > maxDD) maxDD = (peak - bal) / peak * 100;
        pos = null;
      }
      order = null;
      continue;
    }

    if (order) {
      if (c.low <= order.price) {
        // filled at limit (maker)
        const entry = order.price;
        pos = { entry, tp: entry * (1 + tp), sl: entry * (1 - sl), hold: 0 };
        order = null;
        continue;
      }
      order = null; // cancel unfilled, replace below
    }
    order = { price: c.close * (1 - off) };
  }
  return finish(bal, peak, maxDD, trades, wins, gW, gL, candles.length / 1440);
}

// 2) EMA stretch reversion — market buy when price is `stretch` below EMA(n)
function emaReversion(candles: Candle[], n: number, stretch: number, tp: number, sl: number, maxHold: number): Result {
  let bal = ALLOC, peak = ALLOC, maxDD = 0, trades = 0, wins = 0, gW = 0, gL = 0;
  let pos: { entry: number; tp: number; sl: number; hold: number } | null = null;
  const k = 2 / (n + 1);
  let ema = candles[0].close;

  for (let i = 1; i < candles.length - 1; i++) {
    ema = candles[i].close * k + ema * (1 - k);
    const next = candles[i + 1];

    if (pos) {
      pos.hold++;
      const qty = ALLOC / pos.entry;
      let exit: number | null = null;
      if (next.low <= pos.sl) exit = pos.sl;
      else if (next.high >= pos.tp) exit = pos.tp;
      else if (pos.hold >= maxHold) exit = next.close;
      if (exit !== null) {
        const pnl = (exit - pos.entry) * qty;
        bal += pnl; trades++;
        if (pnl >= 0) { wins++; gW += pnl; } else gL += Math.abs(pnl);
        if (bal > peak) peak = bal;
        if ((peak - bal) / peak * 100 > maxDD) maxDD = (peak - bal) / peak * 100;
        pos = null;
      }
      continue;
    }

    if ((candles[i].close - ema) / ema <= -stretch) {
      const entry = next.open * 1.0002;
      pos = { entry, tp: entry * (1 + tp), sl: entry * (1 - sl), hold: 0 };
    }
  }
  return finish(bal, peak, maxDD, trades, wins, gW, gL, candles.length / 1440);
}

// 3) 5-minute cumulative drop bounce
function drop5m(candles: Candle[], minDrop: number, tp: number, sl: number, maxHold: number): Result {
  let bal = ALLOC, peak = ALLOC, maxDD = 0, trades = 0, wins = 0, gW = 0, gL = 0;
  let pos: { entry: number; tp: number; sl: number; hold: number } | null = null;

  for (let i = 5; i < candles.length - 1; i++) {
    const next = candles[i + 1];
    if (pos) {
      pos.hold++;
      const qty = ALLOC / pos.entry;
      let exit: number | null = null;
      if (next.low <= pos.sl) exit = pos.sl;
      else if (next.high >= pos.tp) exit = pos.tp;
      else if (pos.hold >= maxHold) exit = next.close;
      if (exit !== null) {
        const pnl = (exit - pos.entry) * qty;
        bal += pnl; trades++;
        if (pnl >= 0) { wins++; gW += pnl; } else gL += Math.abs(pnl);
        if (bal > peak) peak = bal;
        if ((peak - bal) / peak * 100 > maxDD) maxDD = (peak - bal) / peak * 100;
        pos = null;
      }
      continue;
    }
    const ret5 = (candles[i].close - candles[i - 5].close) / candles[i - 5].close;
    if (ret5 <= -minDrop) {
      const entry = next.open * 1.0002;
      pos = { entry, tp: entry * (1 + tp), sl: entry * (1 - sl), hold: 0 };
    }
  }
  return finish(bal, peak, maxDD, trades, wins, gW, gL, candles.length / 1440);
}

// 4) Hourly drift — avg return per UTC hour
function hourlyDrift(candles: Candle[]): { hour: number; avgPct: number; posDays: number; totDays: number }[] {
  const byHourDay = new Map<string, { open: number; close: number }>();
  for (const c of candles) {
    const d = new Date(c.time);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}`;
    const ex = byHourDay.get(key);
    if (!ex) byHourDay.set(key, { open: c.open, close: c.close });
    else ex.close = c.close;
  }
  const stats = new Map<number, { rets: number[] }>();
  for (const [key, v] of byHourDay) {
    const hour = Number(key.split("-")[3]);
    if (!stats.has(hour)) stats.set(hour, { rets: [] });
    stats.get(hour)!.rets.push((v.close - v.open) / v.open * 100);
  }
  return [...stats.entries()].map(([hour, s]) => ({
    hour,
    avgPct: s.rets.reduce((a, b) => a + b, 0) / s.rets.length,
    posDays: s.rets.filter(r => r > 0).length,
    totDays: s.rets.length,
  })).sort((a, b) => a.hour - b.hour);
}

function row(label: string, r: Result) {
  const pfStr = r.pf === Infinity ? "  inf" : r.pf.toFixed(2);
  const sign = r.pnl >= 0 ? "+" : "";
  console.log(
    `  ${label}`.padEnd(38) +
    `${r.trades}`.padStart(6) +
    `  ${r.perDay.toFixed(1)}`.padStart(7) +
    `  ${r.wr.toFixed(1)}%`.padStart(7) +
    `  ${pfStr}`.padStart(6) +
    `  ${sign}$${r.pnl.toFixed(2)}`.padStart(9) +
    `  ${sign}${r.pct.toFixed(1)}%`.padStart(8) +
    `  ${r.maxDD.toFixed(1)}%`.padStart(7)
  );
}

(async () => {
  console.log("\nHIGH-FREQUENCY LAB  |  1m  |  30d  |  $25/trade");
  console.log("Grid entries are maker limit (no fee); others market entry (+0.02%)\n");

  const allDrift = new Map<number, number[]>();

  for (const symbol of ["BTCUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT"]) {
    process.stdout.write(`Fetching ${symbol}... `);
    const candles = await fetchKlines(symbol);
    console.log(`${candles.length} candles`);

    console.log(`\n  ── ${symbol} ──`);
    console.log("  Strategy                             Tr     /day    WR%    PF      PnL$     Ret%   MaxDD%");
    console.log("  " + "─".repeat(96));

    row("Grid: -0.15% buy, +0.15% TP, SL0.45", gridScalp(candles, 0.0015, 0.0015, 0.0045, 30));
    row("Grid: -0.20% buy, +0.20% TP, SL0.60", gridScalp(candles, 0.002,  0.002,  0.006,  30));
    row("Grid: -0.30% buy, +0.25% TP, SL0.75", gridScalp(candles, 0.003,  0.0025, 0.0075, 45));
    row("EMA20 -0.25%, TP0.2 SL0.25",          emaReversion(candles, 20, 0.0025, 0.002, 0.0025, 15));
    row("EMA20 -0.40%, TP0.3 SL0.3",           emaReversion(candles, 20, 0.004,  0.003, 0.003,  20));
    row("5m drop -0.4%, TP0.25 SL0.25",        drop5m(candles, 0.004, 0.0025, 0.0025, 15));
    row("5m drop -0.6%, TP0.3 SL0.3",          drop5m(candles, 0.006, 0.003,  0.003,  20));

    const drift = hourlyDrift(candles);
    for (const d of drift) {
      if (!allDrift.has(d.hour)) allDrift.set(d.hour, []);
      allDrift.get(d.hour)!.push(d.avgPct);
    }
  }

  console.log("\n  ── HOURLY DRIFT (avg % return per UTC hour, averaged across 5 coins) ──");
  console.log("  Hour UTC   Avg%     Hour UTC   Avg%");
  console.log("  " + "─".repeat(44));
  const rows: string[] = [];
  const sorted = [...allDrift.entries()].sort((a, b) => a[0] - b[0]);
  for (let h = 0; h < 12; h++) {
    const a = sorted[h], b = sorted[h + 12];
    const fmtA = a ? `${a[0].toString().padStart(2, "0")}:00  ${(a[1].reduce((x, y) => x + y, 0) / a[1].length).toFixed(4)}%` : "";
    const fmtB = b ? `${b[0].toString().padStart(2, "0")}:00  ${(b[1].reduce((x, y) => x + y, 0) / b[1].length).toFixed(4)}%` : "";
    rows.push(`  ${fmtA.padEnd(22)}  ${fmtB}`);
  }
  console.log(rows.join("\n"));
  console.log();
})();
