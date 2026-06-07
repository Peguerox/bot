/**
 * BNB BTC-lag focused backtest
 * Signal: BTC 1m candle up >= 0.3%, BNB up < 0.1% (didn't follow)
 * TP=0.8%, SL=0.15%, hold=6, chase=0.1%, $25 compounding, 0% fees, 1 month
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE          = "https://api.binance.us/api/v3";
const KEY           = process.env.BINANCE_API_KEY!;
const BTC_THRESH    = 0.003;
const COIN_MAX      = 0.001;
const TP_PCT        = 0.008;
const SL_PCT        = 0.0015;
const MAX_HOLD      = 6;
const CHASE_OFFSET  = 0.001;
const ALLOCATION    = 25;
const LOOKBACK_MS   = 180 * 24 * 60 * 60 * 1000;

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

(async () => {
  const start = Date.now() - LOOKBACK_MS;

  process.stdout.write("Fetching BTC... ");
  const btcRaw = await fetchKlines("BTCUSDT", start);
  console.log(`${btcRaw.length} candles`);

  process.stdout.write("Fetching BNB... ");
  const bnbRaw = await fetchKlines("BNBUSDT", start);
  console.log(`${bnbRaw.length} candles`);

  const btcMap  = new Map(btcRaw.map(c => [c.time, c]));
  const aligned = bnbRaw.filter(c => btcMap.has(c.time));
  const btc     = aligned.map(c => btcMap.get(c.time)!);

  let bal = ALLOCATION, peak = ALLOCATION, maxDD = 0;
  let tpCount = 0, slCount = 0, chaseWins = 0, chaseLosses = 0;
  let grossWin = 0, grossLoss = 0;
  const monthly: Record<string, { pnl: number; startBal: number; trades: number; wins: number }> = {};
  let currentMonth = "";

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

  for (let i = 1; i < aligned.length; i++) {
    const { high, low, close } = aligned[i];
    const month = new Date(aligned[i].time).toISOString().slice(0, 7);
    if (month !== currentMonth) {
      if (currentMonth) monthly[currentMonth].pnl = bal - monthly[currentMonth].startBal;
      monthly[month] = { pnl: 0, startBal: bal, trades: 0, wins: 0 };
      currentMonth = month;
    }

    if (pos) {
      if (pos.chasing) {
        if (low < pos.chase_floor) {
          const exit = close >= pos.chase_floor * 0.998 ? pos.chase_floor : close;
          const p = closePos(exit);
          monthly[month].trades++;
          if (p >= 0) { chaseWins++; monthly[month].wins++; } else chaseLosses++;
        } else {
          const nf = close * (1 - CHASE_OFFSET);
          if (nf > pos.chase_floor) pos.chase_floor = nf;
        }
      } else {
        pos.hold++;
        if (low <= pos.sl) {
          closePos(pos.sl); slCount++;
          monthly[month].trades++;
        } else if (high >= pos.tp) {
          closePos(pos.tp); tpCount++;
          monthly[month].trades++; monthly[month].wins++;
        } else if (pos.hold >= MAX_HOLD) {
          pos.chasing     = true;
          pos.chase_floor = close * (1 - CHASE_OFFSET);
        }
      }
      continue;
    }

    const btcRet  = (btc[i].close - btc[i - 1].close) / btc[i - 1].close;
    const coinRet = (close - aligned[i - 1].close) / aligned[i - 1].close;

    if (btcRet >= BTC_THRESH && coinRet < COIN_MAX) {
      pos = { entry: close, tp: close * (1 + TP_PCT), sl: close * (1 - SL_PCT), hold: 0, chasing: false, chase_floor: 0 };
    }
  }

  if (currentMonth) monthly[currentMonth].pnl = bal - monthly[currentMonth].startBal;

  const trades = tpCount + slCount + chaseWins + chaseLosses;
  const wins   = tpCount + chaseWins;
  const pnl    = bal - ALLOCATION;
  const pct    = (pnl / ALLOCATION * 100).toFixed(1);
  const wr     = trades > 0 ? (wins / trades * 100).toFixed(1) : "0";
  const pf     = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";

  console.log(`\nBNB/USDT · BTC≥0.3% · Coin<0.1% · TP=0.8% · SL=0.15% · hold=${MAX_HOLD} · chase=0.1% · 0% fees · $${ALLOCATION} start · COMPOUNDING · 1m · 6 months\n`);
  console.log(`  PnL          : +$${pnl.toFixed(2)} (+${pct}%)`);
  console.log(`  Final bal    : $${bal.toFixed(2)}`);
  console.log(`  Trades       : ${trades}  (${tpCount} TP / ${slCount} SL / ${chaseWins} chase-win / ${chaseLosses} chase-loss)`);
  console.log(`  Win rate     : ${wr}%  (${wins}W / ${trades - wins}L)`);
  console.log(`  Profit factor: ${pf}`);
  console.log(`  Max DD       : ${maxDD.toFixed(1)}%`);
  console.log(`\n  Weekly PnL (by ISO week approximation):`);
  for (const [m, v] of Object.entries(monthly)) {
    const mpct = (v.pnl / v.startBal * 100).toFixed(1);
    const flag = v.pnl < 0 ? " ← NEGATIVE" : "";
    console.log(`    ${m}  ${v.pnl >= 0 ? "+" : ""}$${v.pnl.toFixed(2)} (${v.pnl >= 0 ? "+" : ""}${mpct}%)  ${v.trades} trades${flag}`);
  }
})();
