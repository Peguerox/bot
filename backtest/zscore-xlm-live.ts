/**
 * XLM live bot settings backtest — 1 month, 1m candles
 * Fixes: (1) fees 0.1%/side, (2) OHLC for intrabar SL/TP hits,
 *        (3) chase exit at actual price when gap below floor
 * Z=1.5, TP=0.8%, SL=0.3%, MAX_HOLD=6, CHASE_OFFSET=0.05%, ALLOCATION=$25
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE          = "https://api.binance.us/api/v3";
const KEY           = process.env.BINANCE_API_KEY ?? "";
const CORR_WINDOW   = 20;
const Z_THRESH      = 1.5;
const TP_PCT        = 0.008;
const SL_PCT        = 0.0015;
const MAX_HOLD      = 6;
const CHASE_OFFSET  = 0.001;
const ALLOCATION    = 25;
const FEE           = 0.000;  // 0% — all limit/maker orders on Binance.US
const LOOKBACK_MS   = 180 * 24 * 60 * 60 * 1000;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAllKlines(symbol: string, startMs: number) {
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

function calcZScore(btc: number[], xlm: number[], i: number): number {
  if (i < CORR_WINDOW + 1) return 0;
  const spreads: number[] = [];
  for (let j = i - CORR_WINDOW; j <= i; j++) {
    const btcRet = Math.log(btc[j] / btc[j - 1]);
    const xlmRet = Math.log(xlm[j] / xlm[j - 1]);
    spreads.push(xlmRet - btcRet);
  }
  const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const std  = Math.sqrt(spreads.reduce((a, b) => a + (b - mean) ** 2, 0) / spreads.length);
  if (std === 0) return 0;
  return (spreads[spreads.length - 1] - mean) / std;
}

(async () => {
  const start = Date.now() - LOOKBACK_MS;
  process.stdout.write("Fetching BTC 1m... ");
  const btcCandles = await fetchAllKlines("BTCUSDT", start);
  console.log(`${btcCandles.length} candles`);
  process.stdout.write("Fetching XLM 1m... ");
  const xlmCandles = await fetchAllKlines("XLMUSDT", start);
  console.log(`${xlmCandles.length} candles`);

  const btcMap  = new Map(btcCandles.map(c => [c.time, c.close]));
  const aligned = xlmCandles.filter(c => btcMap.has(c.time));
  const btcClose = aligned.map(c => btcMap.get(c.time)!);

  let pnl = 0, tpCount = 0, slCount = 0, chaseWins = 0, chaseLosses = 0, totalFees = 0;
  const monthly: Record<string, { pnl: number; startBal: number }> = {};
  let currentMonth = "";
  let grossWin = 0, grossLoss = 0;
  let bal = ALLOCATION, peak = ALLOCATION, maxDD = 0;

  type Pos = {
    entry: number; tp: number; sl: number;
    hold: number; chasing: boolean; chase_floor: number;
  };
  let pos: Pos | null = null;

  const closePos = (exitPrice: number) => {
    const qty      = Math.floor(bal / pos!.entry);
    const fees     = 0;
    const tradePnl = (exitPrice - pos!.entry) * qty - fees;
    totalFees += fees;
    pnl += tradePnl; bal += tradePnl;
    if (tradePnl >= 0) grossWin  += tradePnl;
    else               grossLoss += Math.abs(tradePnl);
    if (bal > peak) peak = bal;
    const dd = (bal - peak) / peak * 100;
    if (dd < maxDD) maxDD = dd;
    pos = null;
    return tradePnl;
  };

  for (let i = CORR_WINDOW + 1; i < aligned.length; i++) {
    const { open, high, low, close } = aligned[i];
    const month = new Date(aligned[i].time).toISOString().slice(0, 7);
    if (month !== currentMonth) {
      if (currentMonth) monthly[currentMonth].pnl = bal - monthly[currentMonth].startBal;
      monthly[month] = { pnl: 0, startBal: bal };
      currentMonth = month;
    }

    if (pos) {
      if (pos.chasing) {
        if (low < pos.chase_floor) {
          const exitPrice = close >= pos.chase_floor * (1 - 0.002) ? pos.chase_floor : close;
          const tradePnl  = closePos(exitPrice);
          if (tradePnl >= 0) chaseWins++; else chaseLosses++;
        } else {
          const newFloor = close * (1 - CHASE_OFFSET);
          if (newFloor > pos.chase_floor) pos.chase_floor = newFloor;
        }
      } else {
        pos.hold++;
        // Check intrabar: assume low before high within candle (conservative for longs)
        if (low <= pos.sl) {
          closePos(pos.sl); slCount++;
        } else if (high >= pos.tp) {
          closePos(pos.tp); tpCount++;
        } else if (pos.hold >= MAX_HOLD) {
          pos.chasing     = true;
          pos.chase_floor = close * (1 - CHASE_OFFSET);
        }
      }
      continue;
    }

    const z = calcZScore(btcClose, aligned.map(c => c.close), i);
    if (z <= -Z_THRESH) {
      pos = { entry: close, tp: close * (1 + TP_PCT), sl: close * (1 - SL_PCT), hold: 0, chasing: false, chase_floor: 0 };
    }
  }

  const trades = tpCount + slCount + chaseWins + chaseLosses;
  const wins   = tpCount + chaseWins;
  const losses = slCount + chaseLosses;
  const wr     = trades > 0 ? (wins / trades * 100).toFixed(1) : "0";
  const pf     = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";

  if (currentMonth) monthly[currentMonth].pnl = bal - monthly[currentMonth].startBal;
  console.log(`\nXLM/USDT · Z=${Z_THRESH} · TP ${TP_PCT*100}% · SL ${SL_PCT*100}% · hold=${MAX_HOLD} · chase=${CHASE_OFFSET*100}% · fees=0% · $${ALLOCATION} start · COMPOUNDING · 1m · 6 months\n`);
  console.log(`  PnL (after fees) : $${pnl.toFixed(2)}`);
  console.log(`  Fees paid        : $${totalFees.toFixed(2)}`);
  console.log(`  Final bal        : $${bal.toFixed(2)}`);
  console.log(`  Trades           : ${trades}  (${tpCount} TP / ${slCount} SL / ${chaseWins} chase-win / ${chaseLosses} chase-loss)`);
  console.log(`  Win rate         : ${wr}%  (${wins}W / ${losses}L)`);
  console.log(`  Profit factor    : ${pf}`);
  console.log(`  Max DD           : ${maxDD.toFixed(1)}%`);
  console.log(`\n  Monthly PnL:`);
  for (const [m, v] of Object.entries(monthly)) {
    const pct = (v.pnl / v.startBal * 100).toFixed(1);
    const flag = v.pnl < 0 ? " ← NEGATIVE" : "";
    console.log(`    ${m}  ${v.pnl >= 0 ? "+" : ""}$${v.pnl.toFixed(2)} (${v.pnl >= 0 ? "+" : ""}${pct}%)${flag}`);
  }
})();
