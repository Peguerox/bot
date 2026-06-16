// Out-of-sample validation: flush bounce on days 30-60 back (previous month)
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US = "https://api.binance.us/api/v3";
const KEY = process.env.BINANCE_API_KEY ?? "";
const ALLOC = 25;
const ENTRY_SLIP = 1.0002;

type Candle = { time: number; open: number; high: number; low: number; close: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchRange(symbol: string, startMs: number, endMs: number): Promise<Candle[]> {
  const candles: Candle[] = [];
  let from = startMs;
  while (from < endMs) {
    const res = await fetch(`${BASE_US}/klines?symbol=${symbol}&interval=1m&startTime=${from}&endTime=${endMs}&limit=1000`, { headers: { "X-MBX-APIKEY": KEY } });
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

function sim(candles: Candle[], minDrop: number, tp: number, sl: number, maxHold: number) {
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
    const drop = (candles[i].close - candles[i].open) / candles[i].open;
    if (drop <= -minDrop) {
      const entry = next.open * ENTRY_SLIP;
      pos = { entry, tp: entry * (1 + tp), sl: entry * (1 - sl), hold: 0 };
    }
  }

  const pnl = bal - ALLOC, wr = trades > 0 ? wins / trades * 100 : 0, pf = gL > 0 ? gW / gL : Infinity;
  return { pnl, wr, pf, trades, maxDD };
}

(async () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  // Out-of-sample window: 60 to 30 days ago
  const start = now - 60 * DAY, end = now - 30 * DAY;

  console.log("\nOUT-OF-SAMPLE  |  flush bounce drop0.5% TP0.40/SL0.30 h20  |  days 30-60 back\n");
  console.log("  Coin       Trades    WR%     PF      PnL$    MaxDD%");
  console.log("  " + "─".repeat(56));

  let totPnl = 0, totTr = 0;
  for (const symbol of ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT"]) {
    process.stdout.write(`  fetching ${symbol}...`);
    const candles = await fetchRange(symbol, start, end);
    const r = sim(candles, 0.005, 0.004, 0.003, 20);
    const pfStr = r.pf === Infinity ? "  inf" : r.pf.toFixed(2);
    const sign = r.pnl >= 0 ? "+" : "";
    process.stdout.write("\r");
    console.log(
      `  ${symbol.replace("USDT","").padEnd(9)}` +
      `${r.trades}`.padStart(7) +
      `  ${r.wr.toFixed(1)}%`.padStart(7) +
      `  ${pfStr}`.padStart(6) +
      `  ${sign}$${r.pnl.toFixed(2)}`.padStart(9) +
      `  ${r.maxDD.toFixed(1)}%`.padStart(7) + "          "
    );
    totPnl += r.pnl; totTr += r.trades;
  }
  console.log("  " + "─".repeat(56));
  const sign = totPnl >= 0 ? "+" : "";
  console.log(`  TOTAL    ${totTr}`.padEnd(20) + ` ${sign}$${totPnl.toFixed(2)}  (${(totTr/30).toFixed(1)} trades/day)\n`);
})();
