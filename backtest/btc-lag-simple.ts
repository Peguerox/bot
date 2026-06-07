/**
 * Simple BTC-lag strategy — no Z-score
 * Signal: BTC 1m candle up >= BTC_THRESH, coin up < COIN_MAX (didn't follow)
 * Buy coin expecting snap-up. TP/SL/hold/chase same as live bot.
 * 1 month, compounding, 0% fees
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE         = "https://api.binance.us/api/v3";
const KEY          = process.env.BINANCE_API_KEY!;
const TP_PCT       = 0.008;
const SL_PCT       = 0.0015;
const MAX_HOLD     = 6;
const CHASE_OFFSET = 0.001;
const ALLOCATION   = 25;
const LOOKBACK_MS  = 30 * 24 * 60 * 60 * 1000;

// Grid
const BTC_THRESHOLDS = [0.002, 0.003, 0.004, 0.005]; // BTC must pump this much
const COIN_MAX_MOVES = [0.000, 0.001, 0.002];         // coin moved less than this

const COINS = [
  { symbol: "ETHUSDT",  name: "ETH"  },
  { symbol: "SOLUSDT",  name: "SOL"  },
  { symbol: "XRPUSDT",  name: "XRP"  },
  { symbol: "BNBUSDT",  name: "BNB"  },
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
    const raw = await res.json() as string[][];
    if (!raw.length) break;
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

function backtest(
  btc: { high: number; low: number; close: number }[],
  coin: { high: number; low: number; close: number }[],
  btcThresh: number,
  coinMax: number,
) {
  let bal = ALLOCATION, peak = ALLOCATION, maxDD = 0;
  let tpCount = 0, slCount = 0, chaseWins = 0, chaseLosses = 0;
  let grossWin = 0, grossLoss = 0;

  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chase_floor: number };
  let pos: Pos | null = null;

  const closePos = (exitPrice: number) => {
    const qty      = bal / pos!.entry;
    const tradePnl = (exitPrice - pos!.entry) * qty;
    bal += tradePnl;
    if (tradePnl >= 0) grossWin += tradePnl; else grossLoss += Math.abs(tradePnl);
    if (bal > peak) peak = bal;
    if ((bal - peak) / peak * 100 < maxDD) maxDD = (bal - peak) / peak * 100;
    pos = null;
    return tradePnl;
  };

  for (let i = 1; i < coin.length; i++) {
    const { high, low, close } = coin[i];

    if (pos) {
      if (pos.chasing) {
        if (low < pos.chase_floor) {
          const exit = close >= pos.chase_floor * 0.998 ? pos.chase_floor : close;
          const p = closePos(exit);
          if (p >= 0) chaseWins++; else chaseLosses++;
        } else {
          const nf = close * (1 - CHASE_OFFSET);
          if (nf > pos.chase_floor) pos.chase_floor = nf;
        }
      } else {
        pos.hold++;
        if (low <= pos.sl)       { closePos(pos.sl);  slCount++;  }
        else if (high >= pos.tp) { closePos(pos.tp);  tpCount++;  }
        else if (pos.hold >= MAX_HOLD) {
          pos.chasing = true;
          pos.chase_floor = close * (1 - CHASE_OFFSET);
        }
      }
      continue;
    }

    const btcRet  = (btc[i].close - btc[i - 1].close) / btc[i - 1].close;
    const coinRet = (close - coin[i - 1].close) / coin[i - 1].close;

    if (btcRet >= btcThresh && coinRet < coinMax) {
      pos = { entry: close, tp: close * (1 + TP_PCT), sl: close * (1 - SL_PCT), hold: 0, chasing: false, chase_floor: 0 };
    }
  }

  const trades = tpCount + slCount + chaseWins + chaseLosses;
  const pnl    = bal - ALLOCATION;
  const pct    = (pnl / ALLOCATION * 100).toFixed(1);
  const wr     = trades > 0 ? (((tpCount + chaseWins) / trades) * 100).toFixed(0) : "0";
  const pf     = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
  return { pnl, pct, trades, wr, pf, maxDD: maxDD.toFixed(1) };
}

(async () => {
  const start = Date.now() - LOOKBACK_MS;

  process.stdout.write("Fetching BTC... ");
  const btcRaw = await fetchKlines("BTCUSDT", start);
  console.log(`${btcRaw.length} candles`);

  for (const { symbol, name } of COINS) {
    process.stdout.write(`Fetching ${name}... `);
    const coinRaw = await fetchKlines(symbol, start);
    console.log(`${coinRaw.length} candles`);

    // Align
    const btcMap  = new Map(btcRaw.map(c => [c.time, c]));
    const aligned = coinRaw.filter(c => btcMap.has(c.time));
    const btc     = aligned.map(c => btcMap.get(c.time)!);

    console.log(`\n${name}/USDT · TP=${TP_PCT*100}% · SL=${SL_PCT*100}% · hold=${MAX_HOLD} · $${ALLOCATION} · 1m · 1 month`);
    console.log(`  ${"BTC≥".padEnd(8)} ${"Coin<".padEnd(8)} ${"PnL".padStart(10)} ${"Ret".padStart(7)} ${"Trades".padStart(7)} ${"WR".padStart(5)} ${"PF".padStart(6)} ${"MaxDD".padStart(7)}`);
    console.log("  " + "─".repeat(64));

    for (const btcThresh of BTC_THRESHOLDS) {
      for (const coinMax of COIN_MAX_MOVES) {
        const r = backtest(btc, aligned, btcThresh, coinMax);
        console.log(
          `  ${(btcThresh*100+"%").padEnd(8)} ${(coinMax*100+"%").padEnd(8)}` +
          ` ${"$"+r.pnl.toFixed(2).padStart(9)} ${(r.pct+"%").padStart(7)}` +
          ` ${String(r.trades).padStart(7)} ${(r.wr+"%").padStart(5)} ${r.pf.padStart(6)} ${(r.maxDD+"%").padStart(7)}`
        );
      }
    }
    console.log();
  }
})();
