import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US = "https://api.binance.us/api/v3";
const KEY = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const ALLOC = 25;
const EMA_PERIOD = 9;
const CONFLUENCE_TOL = 0.003; // VWAP within 0.3% of prev-day H/L = confluence

type Candle = { time: number; high: number; low: number; close: number; volume: number };

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
      time:   Number(c[0]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5]),
    });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(150);
  }
  return candles;
}

function dayStart(ts: number): number {
  return Math.floor(ts / 86400000) * 86400000;
}

// VWAP resets at midnight UTC each day
function calcVWAP(candles: Candle[]): number[] {
  const out: number[] = [];
  let cumTPV = 0, cumVol = 0, currentDay = -1;
  for (const c of candles) {
    const day = dayStart(c.time);
    if (day !== currentDay) { cumTPV = 0; cumVol = 0; currentDay = day; }
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
    out.push(cumVol > 0 ? cumTPV / cumVol : c.close);
  }
  return out;
}

function calcEMA(candles: Candle[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [candles[0].close];
  for (let i = 1; i < candles.length; i++) {
    out.push(candles[i].close * k + out[i - 1] * (1 - k));
  }
  return out;
}

// For each candle, return the previous calendar day's high and low (midnight UTC)
function calcPrevDayLevels(candles: Candle[]): { high: number; low: number }[] {
  const dayMap = new Map<number, { high: number; low: number }>();
  for (const c of candles) {
    const day = dayStart(c.time);
    const ex = dayMap.get(day);
    if (!ex) dayMap.set(day, { high: c.high, low: c.low });
    else { if (c.high > ex.high) ex.high = c.high; if (c.low < ex.low) ex.low = c.low; }
  }
  return candles.map(c => {
    const prev = dayStart(c.time) - 86400000;
    return dayMap.get(prev) ?? { high: 0, low: 0 };
  });
}

function sim(candles: Candle[], label: string, confluenceOnly: boolean) {
  const vwap  = calcVWAP(candles);
  const ema8  = calcEMA(candles, EMA_PERIOD);
  const pdl   = calcPrevDayLevels(candles);

  let bal = ALLOC, peak = ALLOC, maxDD = 0;
  let trades = 0, wins = 0, gW = 0, gL = 0;
  let totalHold = 0;
  let pos: { entry: number } | null = null;

  for (let i = EMA_PERIOD + 1; i < candles.length; i++) {
    const c = candles[i];

    if (pos) {
      // Exit: EMA 9 crosses below VWAP
      if (ema8[i] < vwap[i]) {
        const qty = ALLOC / pos.entry;
        const pnl = (c.close - pos.entry) * qty;
        bal += pnl; trades++;
        if (pnl >= 0) { wins++; gW += pnl; } else gL += Math.abs(pnl);
        if (bal > peak) peak = bal;
        if ((peak - bal) / peak * 100 > maxDD) maxDD = (peak - bal) / peak * 100;
        pos = null;
      }
      continue;
    }

    // Signal: previous candle was above VWAP, this candle dipped to/below VWAP but closed above
    const prevAbove  = candles[i - 1].close > vwap[i - 1];
    const dippedVWAP = c.low <= vwap[i];
    const closedAbove = c.close > vwap[i];
    const emaAboveVWAP = ema8[i] > vwap[i]; // EMA 9 above VWAP = uptrend

    if (!prevAbove || !dippedVWAP || !closedAbove || !emaAboveVWAP) continue;

    // Confluence check: is VWAP near previous day high or low?
    const { high: pdH, low: pdL } = pdl[i];
    const nearPDH = pdH > 0 && Math.abs(vwap[i] - pdH) / pdH < CONFLUENCE_TOL;
    const nearPDL = pdL > 0 && Math.abs(vwap[i] - pdL) / pdL < CONFLUENCE_TOL;
    const hasConfluence = nearPDH || nearPDL;

    if (confluenceOnly && !hasConfluence) continue;

    pos = { entry: c.close };
  }

  // Close open position at last candle
  if (pos) {
    const last = candles[candles.length - 1];
    const qty = ALLOC / pos.entry;
    const pnl = (last.close - pos.entry) * qty;
    bal += pnl; trades++;
    if (pnl >= 0) { wins++; gW += pnl; } else gL += Math.abs(pnl);
    if (bal > peak) peak = bal;
    if ((peak - bal) / peak * 100 > maxDD) maxDD = (peak - bal) / peak * 100;
    pos = null;
  }

  const days = candles.length / 288; // 288 five-min candles per day
  const pnl = bal - ALLOC;
  const wr  = trades > 0 ? wins / trades * 100 : 0;
  const pf  = gL > 0 ? gW / gL : Infinity;
  const pfStr = pf === Infinity ? "  inf" : pf.toFixed(2);

  return { label, trades, perDay: trades / days, wr, pf: pfStr, pnl, pct: pnl / ALLOC * 100, maxDD };
}

function printRow(r: ReturnType<typeof sim>) {
  const sign = r.pnl >= 0 ? "+" : "";
  console.log(
    `  ${r.label}`.padEnd(28) +
    `${r.trades}`.padStart(7) +
    `  ${r.perDay.toFixed(1)}`.padStart(6) +
    `  ${r.wr.toFixed(1)}%`.padStart(7) +
    `  ${r.pf}`.padStart(6) +
    `  ${sign}$${r.pnl.toFixed(2)}`.padStart(9) +
    `  ${sign}${r.pct.toFixed(1)}%`.padStart(8) +
    `  ${r.maxDD.toFixed(1)}%`.padStart(7)
  );
}

(async () => {
  console.log("\nVWAP + EMA 8  |  5-minute chart  |  30d  |  $25/trade  |  long only\n");
  console.log("  Signal                     Trades  /day    WR%    PF      PnL$     Ret%   MaxDD%");
  console.log("  " + "─".repeat(84));

  for (const symbol of ["BTCUSDT", "SOLUSDT", "XRPUSDT"]) {
    process.stdout.write(`Fetching ${symbol}... `);
    const candles = await fetchKlines(symbol);
    console.log(`${candles.length} candles (${(candles.length / 288).toFixed(1)} days)`);

    console.log(`\n  ── ${symbol} ──`);
    printRow(sim(candles, "VWAP retest only",   false));
    printRow(sim(candles, "VWAP + prev-day confluence", true));
  }

  console.log();
  console.log("  Notes:");
  console.log("  · Entry: 5m candle dips to VWAP (low ≤ VWAP), closes back above, price > EMA 8");
  console.log("  · Exit:  EMA 9 crosses below VWAP");
  console.log("  · Confluence: VWAP within 0.3% of previous day high or low");
  console.log("  · Pre-market substitute: previous calendar day H/L (midnight UTC reset)");
  console.log("  · No shorts (spot only)");
  console.log();
})();
