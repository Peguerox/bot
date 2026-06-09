import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE        = "https://api.binance.com/api/v3";
const KEY         = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

const TP_PCT      = 0.008;
const SL_PCT      = 0.0015;
const MAX_HOLD    = 6;
const ALLOC       = 25;
const VOL_WINDOW  = 20;
const MULTIPLIERS = [2, 3, 5];

const COINS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT"];

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string, startMs: number) {
  const candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
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
      time:   Number(c[0]),
      open:   parseFloat(c[1]),
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

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
function run(candles: Candle[], mult: number) {
  let bal = ALLOC, peak = ALLOC, maxDD = 0;
  let trades = 0, wins = 0, grossWin = 0, grossLoss = 0;
  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chasePrice: number };
  let pos: Pos | null = null;

  for (let i = VOL_WINDOW; i < candles.length; i++) {
    const { open, high, low, close, volume } = candles[i];

    if (pos) {
      if (pos.chasing) {
        if (low <= pos.chasePrice) {
          const pnl = (pos.chasePrice - pos.entry) * (bal / pos.entry);
          bal += pnl; trades++;
          if (pnl >= 0) { wins++; grossWin += pnl; } else grossLoss += Math.abs(pnl);
          if (bal > peak) peak = bal;
          if ((bal - peak) / peak * 100 < maxDD) maxDD = (bal - peak) / peak * 100;
          pos = null;
        } else { pos.chasePrice = close; }
      } else {
        pos.hold++;
        if (low <= pos.sl) {
          const pnl = (pos.sl - pos.entry) * (bal / pos.entry);
          bal += pnl; trades++; grossLoss += Math.abs(pnl);
          if (bal > peak) peak = bal;
          if ((bal - peak) / peak * 100 < maxDD) maxDD = (bal - peak) / peak * 100;
          pos = null;
        } else if (high >= pos.tp) {
          const pnl = (pos.tp - pos.entry) * (bal / pos.entry);
          bal += pnl; trades++; wins++; grossWin += pnl;
          if (bal > peak) peak = bal;
          if ((bal - peak) / peak * 100 < maxDD) maxDD = (bal - peak) / peak * 100;
          pos = null;
        } else if (pos.hold >= MAX_HOLD) {
          pos.chasing = true; pos.chasePrice = close;
        }
      }
      continue;
    }

    // Signal: green candle + volume > N× 20-candle average
    const avgVol = candles.slice(i - VOL_WINDOW, i).reduce((s, c) => s + c.volume, 0) / VOL_WINDOW;
    if (close > open && volume > mult * avgVol) {
      pos = { entry: close, tp: close * (1 + TP_PCT), sl: close * (1 - SL_PCT), hold: 0, chasing: false, chasePrice: 0 };
    }
  }

  const pnl = bal - ALLOC;
  const pct = (pnl / ALLOC * 100).toFixed(1);
  const wr  = trades > 0 ? (wins / trades * 100).toFixed(1) : "0";
  const pf  = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
  return { pnl, pct: parseFloat(pct), trades, wr, pf, maxDD };
}

(async () => {
  const start = Date.now() - LOOKBACK_MS;
  console.log(`Volume Spike · TP=0.8% · SL=0.15% · 1m · 1 month · Binance global\n`);

  for (const mult of MULTIPLIERS) {
    console.log(`── Volume > ${mult}× average ─────────────────────────────────────────────`);
    console.log(`${"Coin".padEnd(10)} ${"PnL".padStart(8)}  ${"Ret%".padStart(7)}  ${"Trades".padStart(6)}  ${"T/day".padStart(5)}  ${"WR%".padStart(6)}  ${"PF".padStart(5)}  ${"MaxDD".padStart(6)}`);
    console.log("─".repeat(68));

    const results = [];
    for (const symbol of COINS) {
      process.stdout.write(`  ${symbol.replace("USDT","").padEnd(6)} `);
      try {
        const candles = await fetchKlines(symbol, start);
        const r = run(candles as any, mult);
        results.push({ symbol, ...r });
        const sign = r.pnl >= 0 ? "+" : "";
        console.log(
          `${symbol.replace("USDT","").padEnd(10)}` +
          ` ${(sign+"$"+r.pnl.toFixed(2)).padStart(8)}` +
          `  ${(sign+r.pct+"%").padStart(7)}` +
          `  ${String(r.trades).padStart(6)}` +
          `  ${(r.trades/30).toFixed(1).padStart(5)}` +
          `  ${(r.wr+"%").padStart(6)}` +
          `  ${String(r.pf).padStart(5)}` +
          `  ${(r.maxDD.toFixed(1)+"%").padStart(6)}`
        );
      } catch (e) { console.log(`ERROR: ${e}`); }
    }
    const best = results.sort((a,b) => b.pnl - a.pnl)[0];
    if (best) console.log(`  → Best: ${best.symbol.replace("USDT","")} ${best.pnl >= 0 ? "+" : ""}$${best.pnl.toFixed(2)}\n`);
  }
})();
