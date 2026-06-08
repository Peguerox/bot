/**
 * Z-Lag multi-coin comparison · 1m · 1 month · exit-at-price
 * Finds which coin is most profitable with the live XLM bot settings.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE         = "https://api.binance.com/api/v3";
const KEY          = process.env.BINANCE_API_KEY ?? "";
const CORR_WINDOW  = 20;
const Z_THRESH     = 1.5;
const TP_PCT       = 0.008;
const SL_PCT       = 0.0015;
const MAX_HOLD     = 6;
const ALLOCATION   = 25;
const LOOKBACK_MS  = 365 * 24 * 60 * 60 * 1000;

const COINS = [
  "XRPFDUSD",
];

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string, startMs: number) {
  const candles: { time: number; open: number; high: number; low: number; close: number }[] = [];
  let from = startMs;
  const end = Date.now();
  while (from < end) {
    const res = await fetch(
      `${BASE}/klines?symbol=${symbol}&interval=1m&startTime=${from}&endTime=${end}&limit=1000`,
      { headers: { "X-MBX-APIKEY": KEY } }
    );
    if (res.status === 429) { await sleep(10000); continue; }
    const raw = await res.json() as any;
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) candles.push({
      time:  Number(c[0]),
      open:  parseFloat(c[1]),
      high:  parseFloat(c[2]),
      low:   parseFloat(c[3]),
      close: parseFloat(c[4]),
    });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(150);
  }
  return candles;
}

function calcZ(btcClose: number[], altClose: number[], i: number): number {
  if (i < CORR_WINDOW + 1) return 0;
  const spreads: number[] = [];
  for (let j = i - CORR_WINDOW; j <= i; j++) {
    spreads.push(Math.log(altClose[j] / altClose[j - 1]) - Math.log(btcClose[j] / btcClose[j - 1]));
  }
  const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const std  = Math.sqrt(spreads.reduce((a, b) => a + (b - mean) ** 2, 0) / spreads.length);
  return std === 0 ? 0 : (spreads[spreads.length - 1] - mean) / std;
}

async function runCoin(symbol: string, btcCandles: { time: number; close: number }[]) {
  const altCandles = await fetchKlines(symbol, Date.now() - LOOKBACK_MS);
  const btcMap     = new Map(btcCandles.map(c => [c.time, c.close]));
  const aligned    = altCandles.filter(c => btcMap.has(c.time));
  const btcClose   = aligned.map(c => btcMap.get(c.time)!);
  const altClose   = aligned.map(c => c.close);

  let bal = ALLOCATION, peak = ALLOCATION, maxDD = 0;
  let grossWin = 0, grossLoss = 0, trades = 0, wins = 0;

  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chasePrice: number };
  let pos: Pos | null = null;

  for (let i = CORR_WINDOW + 1; i < aligned.length; i++) {
    const { high, low, close } = aligned[i];

    if (pos) {
      if (pos.chasing) {
        // Exit at price: if filled (low touched chasePrice) close it
        if (low <= pos.chasePrice) {
          const exit     = pos.chasePrice;
          const qty      = bal / pos.entry;
          const tradePnl = (exit - pos.entry) * qty;
          bal += tradePnl;
          trades++;
          if (tradePnl >= 0) { wins++; grossWin += tradePnl; }
          else grossLoss += Math.abs(tradePnl);
          if (bal > peak) peak = bal;
          const dd = (bal - peak) / peak * 100;
          if (dd < maxDD) maxDD = dd;
          pos = null;
        } else {
          // Reprice to current close each candle
          pos.chasePrice = close;
        }
      } else {
        pos.hold++;
        if (low <= pos.sl) {
          const qty      = bal / pos.entry;
          const tradePnl = (pos.sl - pos.entry) * qty;
          bal += tradePnl;
          trades++;
          grossLoss += Math.abs(tradePnl);
          if (bal > peak) peak = bal;
          const dd = (bal - peak) / peak * 100;
          if (dd < maxDD) maxDD = dd;
          pos = null;
        } else if (high >= pos.tp) {
          const qty      = bal / pos.entry;
          const tradePnl = (pos.tp - pos.entry) * qty;
          bal += tradePnl;
          trades++;
          wins++;
          grossWin += tradePnl;
          if (bal > peak) peak = bal;
          const dd = (bal - peak) / peak * 100;
          if (dd < maxDD) maxDD = dd;
          pos = null;
        } else if (pos.hold >= MAX_HOLD) {
          pos.chasing    = true;
          pos.chasePrice = close;
        }
      }
      continue;
    }

    const z = calcZ(btcClose, altClose, i);
    if (z <= -Z_THRESH) {
      pos = { entry: close, tp: close * (1 + TP_PCT), sl: close * (1 - SL_PCT), hold: 0, chasing: false, chasePrice: 0 };
    }
  }

  const pnl  = bal - ALLOCATION;
  const pct  = (pnl / ALLOCATION * 100).toFixed(1);
  const wr   = trades > 0 ? (wins / trades * 100).toFixed(1) : "0";
  const pf   = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
  const coin = symbol.replace("USDT", "").padEnd(6);

  return { symbol, pnl, pct: parseFloat(pct), bal, wr, pf, maxDD, trades };
}

(async () => {
  const start = Date.now() - LOOKBACK_MS;
  process.stdout.write("Fetching BTC... ");
  const btcCandles = await fetchKlines("BTCUSDT", start);
  console.log(`${btcCandles.length} candles\n`);

  console.log(`Z-Lag · 1m · 1 month · TP=${TP_PCT*100}% · SL=${SL_PCT*100}% · MAX_HOLD=${MAX_HOLD} · exit-at-price · $${ALLOCATION} compounding\n`);

  const results = [];
  for (const coin of COINS) {
    process.stdout.write(`  ${coin.replace("USDT","").padEnd(6)} `);
    try {
      const r = await runCoin(coin, btcCandles);
      results.push(r);
      const sign = r.pnl >= 0 ? "+" : "";
      console.log(`${sign}$${r.pnl.toFixed(2).padStart(7)} (${sign}${r.pct}%)  WR:${r.wr}%  PF:${r.pf}  DD:${r.maxDD.toFixed(1)}%  T:${r.trades}`);
    } catch (e) {
      console.log(`ERROR: ${e}`);
    }
  }

  results.sort((a, b) => b.pnl - a.pnl);
  console.log("\n  ── Ranked by PnL ──");
  results.forEach((r, i) => {
    const sign = r.pnl >= 0 ? "+" : "";
    console.log(`  ${i + 1}. ${r.symbol.replace("USDT","").padEnd(6)} ${sign}$${r.pnl.toFixed(2)} (${sign}${r.pct}%)`);
  });
})();
