import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE        = "https://api.binance.com/api/v3";
const KEY         = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

// Z-lag params
const CORR_WINDOW = 20;
const Z_THRESH    = 1.5;

// Pure-lag params
const BTC_THRESH = 0.003;  // BTC ≥ 0.3%
const COIN_MAX   = 0.001;  // BNB < 0.1%

const TP_PCT   = 0.008;
const SL_PCT   = 0.0015;
const MAX_HOLD = 6;
const ALLOC    = 25;

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

function runZLag(btcClose: number[], altCandles: { high: number; low: number; close: number }[]) {
  const altClose = altCandles.map(c => c.close);
  let bal = ALLOC, peak = ALLOC, maxDD = 0;
  let trades = 0, wins = 0, grossWin = 0, grossLoss = 0;
  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chasePrice: number };
  let pos: Pos | null = null;

  for (let i = CORR_WINDOW + 1; i < altCandles.length; i++) {
    const { high, low, close } = altCandles[i];
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
    const z = calcZ(btcClose, altClose, i);
    if (z <= -Z_THRESH) {
      pos = { entry: close, tp: close * (1 + TP_PCT), sl: close * (1 - SL_PCT), hold: 0, chasing: false, chasePrice: 0 };
    }
  }

  const pnl = bal - ALLOC;
  const wr  = trades > 0 ? (wins / trades * 100).toFixed(1) : "0";
  const pf  = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
  return { trades, wr, pf, pnl, maxDD };
}

function runPureLag(btcCandles: { high: number; low: number; close: number }[], coinCandles: { high: number; low: number; close: number }[]) {
  let bal = ALLOC, peak = ALLOC, maxDD = 0;
  let trades = 0, wins = 0, grossWin = 0, grossLoss = 0;
  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chasePrice: number };
  let pos: Pos | null = null;

  for (let i = 1; i < coinCandles.length; i++) {
    const { high, low, close } = coinCandles[i];
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
    const btcRet  = (btcCandles[i].close - btcCandles[i - 1].close) / btcCandles[i - 1].close;
    const coinRet = (close - coinCandles[i - 1].close) / coinCandles[i - 1].close;
    if (btcRet >= BTC_THRESH && coinRet < COIN_MAX) {
      pos = { entry: close, tp: close * (1 + TP_PCT), sl: close * (1 - SL_PCT), hold: 0, chasing: false, chasePrice: 0 };
    }
  }

  const pnl = bal - ALLOC;
  const wr  = trades > 0 ? (wins / trades * 100).toFixed(1) : "0";
  const pf  = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
  return { trades, wr, pf, pnl, maxDD };
}

(async () => {
  const start = Date.now() - LOOKBACK_MS;

  process.stdout.write("Fetching BTC... ");
  const btcRaw = await fetchKlines("BTCUSDT", start);
  console.log(`${btcRaw.length} candles`);

  process.stdout.write("Fetching XLM... ");
  const xlmRaw = await fetchKlines("XLMUSDT", start);
  console.log(`${xlmRaw.length} candles`);

  process.stdout.write("Fetching BNB... ");
  const bnbRaw = await fetchKlines("BNBUSDT", start);
  console.log(`${bnbRaw.length} candles\n`);

  // Align XLM with BTC
  const btcMap   = new Map(btcRaw.map(c => [c.time, c]));
  const xlmAlign = xlmRaw.filter(c => btcMap.has(c.time));
  const btcForXlm = xlmAlign.map(c => btcMap.get(c.time)!.close);

  // Align BNB with BTC
  const bnbAlign  = bnbRaw.filter(c => btcMap.has(c.time));
  const btcForBnb = bnbAlign.map(c => btcMap.get(c.time)!);

  const zlm = runZLag(btcForXlm, xlmAlign);
  const bnb = runPureLag(btcForBnb, bnbAlign);

  const days = 30;

  console.log(`── 1 Month Comparison ─────────────────────────────────────`);
  console.log(`                    Z-Lag (XLM)      Pure-Lag (BNB)`);
  console.log(`Trades/month        ${String(zlm.trades).padEnd(16)} ${bnb.trades}`);
  console.log(`Trades/day (avg)    ${(zlm.trades / days).toFixed(1).padEnd(16)} ${(bnb.trades / days).toFixed(1)}`);
  console.log(`Win rate            ${(zlm.wr + "%").padEnd(16)} ${bnb.wr}%`);
  console.log(`Profit factor       ${String(zlm.pf).padEnd(16)} ${bnb.pf}`);
  console.log(`PnL                 +$${zlm.pnl.toFixed(2).padEnd(14)} +$${bnb.pnl.toFixed(2)}`);
  console.log(`Max DD              ${(zlm.maxDD.toFixed(2) + "%").padEnd(16)} ${bnb.maxDD.toFixed(2)}%`);
})();
