import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US = "https://api.binance.us/api/v3";
const KEY = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const ALLOC = 25;
const RR = 2; // 2:1 reward/risk

// NYC summer (EDT) = UTC-4 → midnight NY = 04:00 UTC
// First 4H candle of the NY day: 04:00–08:00 UTC
const NY_OFFSET_MS = 4 * 3600 * 1000;
const FOUR_HOURS_MS = 4 * 3600 * 1000;

type Candle = { time: number; high: number; low: number; close: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string): Promise<Candle[]> {
  const candles: Candle[] = [];
  let from = Date.now() - LOOKBACK_MS, end = Date.now();
  while (from < end) {
    const res = await fetch(
      `${BASE_US}/klines?symbol=${symbol}&interval=5m&startTime=${from}&endTime=${end}&limit=1000`,
      { headers: { "X-MBX-APIKEY": KEY } }
    );
    if (res.status === 429) { await sleep(10000); continue; }
    const raw = await res.json() as any;
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) candles.push({
      time:  Number(c[0]),
      high:  parseFloat(c[2]),
      low:   parseFloat(c[3]),
      close: parseFloat(c[4]),
    });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(150);
  }
  return candles;
}

// Returns the 04:00 UTC timestamp that starts the current NY "trading day"
function nyDayStart(ts: number): number {
  return Math.floor((ts - NY_OFFSET_MS) / 86400000) * 86400000 + NY_OFFSET_MS;
}

// Build map: nyDay → high/low of the first 4H candle (04:00–08:00 UTC)
function buildRanges(candles: Candle[]): Map<number, { high: number; low: number }> {
  const map = new Map<number, { high: number; low: number }>();
  for (const c of candles) {
    const nyDay    = nyDayStart(c.time);
    const rangeEnd = nyDay + FOUR_HOURS_MS; // 08:00 UTC
    if (c.time >= nyDay && c.time < rangeEnd) {
      const ex = map.get(nyDay);
      if (!ex) map.set(nyDay, { high: c.high, low: c.low });
      else {
        if (c.high > ex.high) ex.high = c.high;
        if (c.low  < ex.low)  ex.low  = c.low;
      }
    }
  }
  return map;
}

function sim(candles: Candle[], longOnly: boolean) {
  const ranges = buildRanges(candles);

  let bal = ALLOC, peak = ALLOC, maxDD = 0;
  let trades = 0, wins = 0, gW = 0, gL = 0, longs = 0, shorts = 0;

  type Pos = { side: "long" | "short"; entry: number; sl: number; tp: number; dayEnd: number };
  let pos: Pos | null = null;
  let breakState: "none" | "above" | "below" = "none";
  let breakExtreme = 0;
  let currentNyDay = -1;

  for (const c of candles) {
    const nyDay      = nyDayStart(c.time);
    const tradeStart = nyDay + FOUR_HOURS_MS;       // 08:00 UTC — range candle has closed
    const tradeEnd   = nyDay + 24 * 3600 * 1000;   // 04:00 UTC next day

    // New NY day → reset breakout tracking
    if (nyDay !== currentNyDay) {
      currentNyDay = nyDay;
      breakState   = "none";
    }

    // Force-close if position has passed its day boundary
    if (pos && c.time >= pos.dayEnd) {
      const qty = ALLOC / pos.entry;
      const pnl = pos.side === "long"
        ? (c.close - pos.entry) * qty
        : (pos.entry - c.close) * qty;
      bal += pnl; trades++;
      if (pnl >= 0) { wins++; gW += pnl; } else gL += Math.abs(pnl);
      if (bal > peak) peak = bal;
      if ((peak - bal) / peak * 100 > maxDD) maxDD = (peak - bal) / peak * 100;
      pos = null; breakState = "none";
    }

    // Only act within the trading window (after the 4H candle has closed)
    if (c.time < tradeStart || c.time >= tradeEnd) continue;

    const range = ranges.get(nyDay);
    if (!range) continue;
    const { high: rH, low: rL } = range;

    // Check TP/SL for open position
    if (pos) {
      const hitTP = pos.side === "long" ? c.high >= pos.tp : c.low  <= pos.tp;
      const hitSL = pos.side === "long" ? c.low  <= pos.sl : c.high >= pos.sl;

      if (hitSL || hitTP) {
        const win       = hitTP && !hitSL; // if both hit same candle, take SL (conservative)
        const exitPrice = win ? pos.tp : pos.sl;
        const qty       = ALLOC / pos.entry;
        const pnl       = pos.side === "long"
          ? (exitPrice - pos.entry) * qty
          : (pos.entry - exitPrice) * qty;
        bal += pnl; trades++;
        if (win) { wins++; gW += pnl; } else gL += Math.abs(pnl);
        if (bal > peak) peak = bal;
        if ((peak - bal) / peak * 100 > maxDD) maxDD = (peak - bal) / peak * 100;
        pos = null; breakState = "none"; // can take another trade same day
      }
      continue;
    }

    // Step 2 → 3: detect breakout then re-entry
    if (breakState === "none") {
      if      (c.close > rH) { breakState = "above"; breakExtreme = c.high; }
      else if (c.close < rL) { breakState = "below"; breakExtreme = c.low;  }
    } else if (breakState === "above") {
      breakExtreme = Math.max(breakExtreme, c.high);
      if (c.close <= rH) {
        // Re-entered from above → SHORT
        if (!longOnly) {
          const entry = c.close * 0.9998; // market order
          const sl    = breakExtreme;
          const risk  = sl - entry;
          if (risk > 0) {
            pos = { side: "short", entry, sl, tp: entry - RR * risk, dayEnd: tradeEnd };
            shorts++;
          }
        }
        breakState = "none";
      }
    } else if (breakState === "below") {
      breakExtreme = Math.min(breakExtreme, c.low);
      if (c.close >= rL) {
        // Re-entered from below → LONG
        const entry = c.close * 1.0002; // market order
        const sl    = breakExtreme;
        const risk  = entry - sl;
        if (risk > 0) {
          pos = { side: "long", entry, sl, tp: entry + RR * risk, dayEnd: tradeEnd };
          longs++;
        }
        breakState = "none";
      }
    }
  }

  const days   = candles.length / 288;
  const pnl    = bal - ALLOC;
  const wr     = trades > 0 ? wins / trades * 100 : 0;
  const pf     = gL > 0 ? gW / gL : Infinity;
  return { trades, wins, wr, pf, pnl, pct: pnl / ALLOC * 100, maxDD, longs, shorts, perDay: trades / days };
}

function row(label: string, r: ReturnType<typeof sim>) {
  const pfStr = r.pf === Infinity ? "  inf" : r.pf.toFixed(2);
  const sign  = r.pnl >= 0 ? "+" : "";
  console.log(
    `  ${label}`.padEnd(16) +
    `${r.trades}`.padStart(7) +
    `  ${r.perDay.toFixed(1)}`.padStart(6) +
    `  ${r.wr.toFixed(1)}%`.padStart(7) +
    `  ${pfStr}`.padStart(6) +
    `  ${sign}$${r.pnl.toFixed(2)}`.padStart(9) +
    `  ${sign}${r.pct.toFixed(1)}%`.padStart(8) +
    `  ${r.maxDD.toFixed(1)}%`.padStart(7) +
    `  L:${r.longs} S:${r.shorts}`
  );
}

(async () => {
  console.log("\n4H Range Breakout/Retest  |  5m chart  |  30d  |  $25/trade  |  2R:1R TP");
  console.log("Step 1: high/low of first 4H candle (04:00–08:00 UTC = midnight NY EDT)");
  console.log("Step 2: 5m candle closes outside range, then closes back inside");
  console.log("Step 3: enter on re-entry close, SL at breakout extreme, TP at 2×SL\n");
  console.log("  Mode            Trades  /day    WR%    PF      PnL$     Ret%   MaxDD%");
  console.log("  " + "─".repeat(78));

  for (const symbol of ["BTCUSDT", "SOLUSDT", "XRPUSDT"]) {
    process.stdout.write(`Fetching ${symbol}... `);
    const candles = await fetchKlines(symbol);
    console.log(`${candles.length} candles (${(candles.length / 288).toFixed(1)} days)`);

    console.log(`\n  ── ${symbol} ──`);
    row("Both sides",  sim(candles, false));
    row("Long only",   sim(candles, true));
  }

  console.log();
  console.log("  Notes:");
  console.log("  · 'Both sides' = longs + shorts (requires futures/margin for shorts)");
  console.log("  · 'Long only'  = spot compatible — only takes broke-below → re-entered signals");
  console.log("  · SL at extreme of breakout move, TP at 2× risk (2R)");
  console.log("  · Conservative: if TP and SL both hit same candle, counts as SL");
  console.log("  · All trades must close by end of NY day (04:00 UTC next day)");
  console.log();
})();
