import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_GL = "https://api.binance.com/api/v3";
const KEY = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const ALLOC = 25;
const TRAIL_PCT = 0.0015; // trailing stop 0.15% below highest price reached

const NY_OFFSET_MS  = 4 * 3600 * 1000;  // midnight EDT = 04:00 UTC
const FOUR_HOURS_MS = 4 * 3600 * 1000;

type Candle = { time: number; high: number; low: number; close: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string): Promise<Candle[]> {
  const candles: Candle[] = [];
  let from = Date.now() - LOOKBACK_MS, end = Date.now();
  while (from < end) {
    const res = await fetch(
      `${BASE_GL}/klines?symbol=${symbol}&interval=5m&startTime=${from}&endTime=${end}&limit=1000`,
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

function nyDayStart(ts: number): number {
  return Math.floor((ts - NY_OFFSET_MS) / 86400000) * 86400000 + NY_OFFSET_MS;
}

function buildRanges(candles: Candle[]): Map<number, { high: number; low: number }> {
  const map = new Map<number, { high: number; low: number }>();
  for (const c of candles) {
    const nyDay    = nyDayStart(c.time);
    const rangeEnd = nyDay + FOUR_HOURS_MS;
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

  type Pos = {
    side: "long" | "short";
    entry: number;
    dayEnd: number;
    best: number;   // highest high (long) or lowest low (short) seen since entry
    trail: number;  // current trailing stop level
  };
  let pos: Pos | null = null;
  let breakState: "none" | "above" | "below" = "none";
  let breakExtreme = 0;
  let currentNyDay = -1;

  const closePos = (exitPrice: number) => {
    if (!pos) return;
    const qty = ALLOC / pos.entry;
    const pnl = pos.side === "long"
      ? (exitPrice - pos.entry) * qty
      : (pos.entry - exitPrice) * qty;
    bal += pnl; trades++;
    if (pnl >= 0) { wins++; gW += pnl; } else gL += Math.abs(pnl);
    if (bal > peak) peak = bal;
    if ((peak - bal) / peak * 100 > maxDD) maxDD = (peak - bal) / peak * 100;
    pos = null; breakState = "none";
  };

  for (const c of candles) {
    const nyDay      = nyDayStart(c.time);
    const tradeStart = nyDay + FOUR_HOURS_MS;
    const tradeEnd   = nyDay + 24 * 3600 * 1000;

    if (nyDay !== currentNyDay) {
      currentNyDay = nyDay;
      breakState   = "none";
    }

    // Force-close at day boundary
    if (pos && c.time >= pos.dayEnd) {
      closePos(c.close);
    }

    if (c.time < tradeStart || c.time >= tradeEnd) continue;

    const range = ranges.get(nyDay);
    if (!range) continue;
    const { high: rH, low: rL } = range;

    // Update trailing stop and check exit
    if (pos) {
      if (pos.side === "long") {
        if (c.high > pos.best) {
          pos.best  = c.high;
          pos.trail = pos.best * (1 - TRAIL_PCT);
        }
        if (c.low <= pos.trail) {
          closePos(pos.trail); // fill at trail level
          continue;
        }
      } else {
        if (c.low < pos.best) {
          pos.best  = c.low;
          pos.trail = pos.best * (1 + TRAIL_PCT);
        }
        if (c.high >= pos.trail) {
          closePos(pos.trail);
          continue;
        }
      }
      continue;
    }

    // Detect breakout → re-entry
    if (breakState === "none") {
      if      (c.close > rH) { breakState = "above"; breakExtreme = c.high; }
      else if (c.close < rL) { breakState = "below"; breakExtreme = c.low;  }
    } else if (breakState === "above") {
      breakExtreme = Math.max(breakExtreme, c.high);
      if (c.close <= rH) {
        if (!longOnly) {
          const entry = c.close * 0.9998;
          pos = { side: "short", entry, dayEnd: tradeEnd,
            best: entry, trail: entry * (1 + TRAIL_PCT) };
          shorts++;
        }
        breakState = "none";
      }
    } else if (breakState === "below") {
      breakExtreme = Math.min(breakExtreme, c.low);
      if (c.close >= rL) {
        const entry = c.close * 1.0002;
        pos = { side: "long", entry, dayEnd: tradeEnd,
          best: entry, trail: entry * (1 - TRAIL_PCT) };
        longs++;
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
  console.log("\n4H Range Breakout + 0.15% Trailing Stop  |  5m  |  30d  |  $25/trade");
  console.log("Data: Binance Global  |  Trail chases up with price, exits on 0.15% pullback\n");
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
  console.log(`  Trail: stop starts at entry −0.15%, chases up by tracking highest price reached`);
  console.log(`  Exit:  price pulls back 0.15% from peak, or end of NY day (04:00 UTC)`);
  console.log(`  Short trail mirrors: stop starts at entry +0.15%, chases down`);
  console.log();
})();
