import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE        = "https://api.binance.us/api/v3";
const KEY         = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

const BTC_THRESH = 0.001;  // BTC ≥ 0.1%
const TP_PCT     = 0.008;
const SL_PCT     = 0.0015;
const MAX_HOLD   = 6;
const ALLOC      = 25;

// Tighter BNB filters — how much did BNB lag?
const COIN_MAXES = [0.0002, 0.0003, 0.0005, 0.001]; // 0.02%, 0.03%, 0.05%, 0.1%

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string, startMs: number) {
  const candles: { time: number; high: number; low: number; close: number }[] = [];
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
      high:  parseFloat(c[2]),
      low:   parseFloat(c[3]),
      close: parseFloat(c[4]),
    });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(150);
  }
  return candles;
}

function run(btc: { time: number; close: number }[], coin: { time: number; high: number; low: number; close: number }[], coinMax: number) {
  const btcMap  = new Map(btc.map(c => [c.time, c]));
  const aligned = coin.filter(c => btcMap.has(c.time));
  const btcAl   = aligned.map(c => btcMap.get(c.time)!);

  let bal = ALLOC, peak = ALLOC, maxDD = 0;
  let trades = 0, wins = 0, grossWin = 0, grossLoss = 0;
  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chasePrice: number };
  let pos: Pos | null = null;

  for (let i = 1; i < aligned.length; i++) {
    const { high, low, close } = aligned[i];

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

    const btcRet  = (btcAl[i].close - btcAl[i - 1].close) / btcAl[i - 1].close;
    const coinRet = (close - aligned[i - 1].close) / aligned[i - 1].close;
    if (btcRet >= BTC_THRESH && coinRet < coinMax) {
      pos = { entry: close, tp: close * (1 + TP_PCT), sl: close * (1 - SL_PCT), hold: 0, chasing: false, chasePrice: 0 };
    }
  }

  const pnl = bal - ALLOC;
  const pct = (pnl / ALLOC * 100).toFixed(1);
  const wr  = trades > 0 ? (wins / trades * 100).toFixed(1) : "0";
  const pf  = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
  return { pnl, pct: parseFloat(pct), trades, wr, pf, maxDD, bal };
}

(async () => {
  const start = Date.now() - LOOKBACK_MS;

  process.stdout.write("Fetching BTC... ");
  const btcRaw = await fetchKlines("BTCUSDT", start);
  console.log(`${btcRaw.length} candles`);

  process.stdout.write("Fetching BNB... ");
  const bnbRaw = await fetchKlines("BNBUSDT", start);
  console.log(`${bnbRaw.length} candles\n`);

  console.log(`Pure-Lag BNB · BTC≥0.1% · 1m · 1 month · Binance.US\n`);
  console.log(`${"BNB filter".padEnd(12)} ${"PnL".padStart(8)}  ${"Ret%".padStart(7)}  ${"Trades".padStart(6)}  ${"T/day".padStart(5)}  ${"WR%".padStart(6)}  ${"PF".padStart(5)}  ${"MaxDD".padStart(6)}`);
  console.log("─".repeat(72));

  for (const coinMax of COIN_MAXES) {
    const r = run(btcRaw, bnbRaw, coinMax);
    const sign = r.pnl >= 0 ? "+" : "";
    console.log(
      `BNB<${(coinMax*100).toFixed(2)}%`.padEnd(12) +
      ` ${(sign+"$"+r.pnl.toFixed(2)).padStart(8)}` +
      `  ${(sign+r.pct+"%").padStart(7)}` +
      `  ${String(r.trades).padStart(6)}` +
      `  ${(r.trades/30).toFixed(1).padStart(5)}` +
      `  ${(r.wr+"%").padStart(6)}` +
      `  ${String(r.pf).padStart(5)}` +
      `  ${(r.maxDD.toFixed(2)+"%").padStart(6)}`
    );
  }
})();
