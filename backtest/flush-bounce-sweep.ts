// Flush Bounce deep-dive: parameter sweep + more coins to boost trade frequency
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US = "https://api.binance.us/api/v3";
const KEY = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const ALLOC = 25;
const ENTRY_SLIP = 1.0002;

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

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
      low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5]),
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

  const days = candles.length / 1440;
  const pnl = bal - ALLOC, wr = trades > 0 ? wins / trades * 100 : 0, pf = gL > 0 ? gW / gL : Infinity;
  return { pnl, pct: pnl / ALLOC * 100, wr, pf, trades, maxDD, perDay: trades / days };
}

function row(label: string, r: ReturnType<typeof sim>) {
  const pfStr = r.pf === Infinity ? "  inf" : r.pf.toFixed(2);
  const sign = r.pnl >= 0 ? "+" : "";
  console.log(
    `  ${label}`.padEnd(36) +
    `${r.trades}`.padStart(5) +
    `  ${r.perDay.toFixed(2)}`.padStart(7) +
    `  ${r.wr.toFixed(1)}%`.padStart(7) +
    `  ${pfStr}`.padStart(6) +
    `  ${sign}$${r.pnl.toFixed(2)}`.padStart(9) +
    `  ${sign}${r.pct.toFixed(1)}%`.padStart(8) +
    `  ${r.maxDD.toFixed(1)}%`.padStart(7)
  );
}

(async () => {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT"];
  console.log("\nFLUSH BOUNCE SWEEP  |  1m  |  30d  |  $25/trade\n");

  const results: { symbol: string; cfg: string; pnl: number; trades: number; pf: number }[] = [];

  for (const symbol of symbols) {
    process.stdout.write(`Fetching ${symbol}... `);
    const candles = await fetchKlines(symbol);
    console.log(`${candles.length} candles`);

    console.log(`\n  ── ${symbol} ──`);
    console.log("  Config                              Tr    /day    WR%    PF      PnL$     Ret%   MaxDD%");
    console.log("  " + "─".repeat(92));

    const cfgs: [number, number, number, number, string][] = [
      [0.004, 0.0025, 0.0025, 15, "drop0.4 TP/SL 0.25/0.25 h15"],
      [0.005, 0.003,  0.003,  15, "drop0.5 TP/SL 0.30/0.30 h15"],
      [0.005, 0.004,  0.003,  20, "drop0.5 TP/SL 0.40/0.30 h20"],
      [0.005, 0.0025, 0.0025, 10, "drop0.5 TP/SL 0.25/0.25 h10"],
      [0.006, 0.003,  0.003,  15, "drop0.6 TP/SL 0.30/0.30 h15"],
      [0.007, 0.004,  0.004,  20, "drop0.7 TP/SL 0.40/0.40 h20"],
    ];

    for (const [drop, tp, sl, hold, label] of cfgs) {
      const r = sim(candles, drop, tp, sl, hold);
      row(label, r);
      results.push({ symbol, cfg: label, pnl: r.pnl, trades: r.trades, pf: r.pf });
    }
  }

  // Portfolio summary: best uniform config across all coins
  console.log("\n  ── PORTFOLIO (same config, all 6 coins combined) ──");
  console.log("  Config                               Total PnL$   Total trades");
  console.log("  " + "─".repeat(64));
  const cfgNames = [...new Set(results.map(r => r.cfg))];
  for (const cfg of cfgNames) {
    const rs = results.filter(r => r.cfg === cfg);
    const totPnl = rs.reduce((a, b) => a + b.pnl, 0);
    const totTr  = rs.reduce((a, b) => a + b.trades, 0);
    const sign = totPnl >= 0 ? "+" : "";
    console.log(`  ${cfg}`.padEnd(38) + `${sign}$${totPnl.toFixed(2)}`.padStart(9) + `${totTr}`.padStart(13) + `  (${(totTr/30).toFixed(1)}/day)`);
  }
  console.log();
})();
