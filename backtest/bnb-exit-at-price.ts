import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE          = "https://api.binance.us/api/v3";
const KEY           = process.env.BINANCE_API_KEY!;
const BTC_THRESH    = 0.003;
const COIN_MAX      = 0.001;
const TP_PCT        = 0.008;
const SL_PCT        = 0.0015;
const MAX_HOLD      = 6;
const ALLOCATION    = 25;
const LOOKBACK_MS   = 180 * 24 * 60 * 60 * 1000;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string, startMs: number) {
  const candles: { time: number; open: number; high: number; low: number; close: number }[] = [];
  let from = startMs;
  const end = Date.now();
  while (from < end) {
    const res = await fetch(`${BASE}/klines?symbol=${symbol}&interval=1m&startTime=${from}&endTime=${end}&limit=1000`, { headers: { "X-MBX-APIKEY": KEY } });
    if (res.status === 429) { await sleep(10000); continue; }
    const raw = await res.json() as string[][];
    if (!raw.length) break;
    for (const c of raw) candles.push({ time: Number(c[0]), open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]) });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(150);
  }
  return candles;
}

function run(label: string, useExitAtPrice: boolean, btc: any[], coin: any[]) {
  let bal = ALLOCATION, peak = ALLOCATION, maxDD = 0;
  let tpCount = 0, slCount = 0, expireWins = 0, expireLosses = 0;
  let grossWin = 0, grossLoss = 0;
  const monthly: Record<string, { pnl: number; startBal: number }> = {};
  let currentMonth = "";
  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chase_floor: number };
  let pos: Pos | null = null;

  const closePos = (exitPrice: number) => {
    const qty = bal / pos!.entry;
    const pnl = (exitPrice - pos!.entry) * qty;
    bal += pnl;
    if (pnl >= 0) grossWin += pnl; else grossLoss += Math.abs(pnl);
    if (bal > peak) peak = bal;
    if ((bal - peak) / peak * 100 < maxDD) maxDD = (bal - peak) / peak * 100;
    pos = null;
    return pnl;
  };

  for (let i = 1; i < coin.length; i++) {
    const { high, low, close } = coin[i];
    const month = new Date(coin[i].time).toISOString().slice(0, 7);
    if (month !== currentMonth) {
      if (currentMonth) monthly[currentMonth].pnl = bal - monthly[currentMonth].startBal;
      monthly[month] = { pnl: 0, startBal: bal };
      currentMonth = month;
    }

    if (pos) {
      if (pos.chasing) {
        if (low < pos.chase_floor) {
          const exit = close >= pos.chase_floor * 0.998 ? pos.chase_floor : close;
          const p = closePos(exit);
          if (p >= 0) expireWins++; else expireLosses++;
        } else {
          const nf = close * (1 - 0.001);
          if (nf > pos.chase_floor) pos.chase_floor = nf;
        }
      } else {
        pos.hold++;
        if (low <= pos.sl)       { closePos(pos.sl); slCount++; }
        else if (high >= pos.tp) { closePos(pos.tp); tpCount++; }
        else if (pos.hold >= MAX_HOLD) {
          if (useExitAtPrice) {
            const p = closePos(close);
            if (p >= 0) expireWins++; else expireLosses++;
          } else {
            pos.chasing = true;
            pos.chase_floor = close * (1 - 0.001);
          }
        }
      }
      continue;
    }

    const btcRet = (btc[i].close - btc[i-1].close) / btc[i-1].close;
    const coinRet = (close - coin[i-1].close) / coin[i-1].close;
    if (btcRet >= BTC_THRESH && coinRet < COIN_MAX) {
      pos = { entry: close, tp: close*(1+TP_PCT), sl: close*(1-SL_PCT), hold: 0, chasing: false, chase_floor: 0 };
    }
  }

  if (currentMonth) monthly[currentMonth].pnl = bal - monthly[currentMonth].startBal;
  const trades = tpCount + slCount + expireWins + expireLosses;
  const wins = tpCount + expireWins;
  const pnl = bal - ALLOCATION;
  const wr = trades > 0 ? (wins/trades*100).toFixed(1) : "0";
  const pf = grossLoss > 0 ? (grossWin/grossLoss).toFixed(2) : "∞";

  console.log(`\n${label}`);
  console.log(`  PnL     : +$${pnl.toFixed(2)} (+${(pnl/ALLOCATION*100).toFixed(1)}%)`);
  console.log(`  Trades  : ${trades}  (${tpCount} TP / ${slCount} SL / ${expireWins} expire-win / ${expireLosses} expire-loss)`);
  console.log(`  Win rate: ${wr}%`);
  console.log(`  PF      : ${pf}`);
  console.log(`  Max DD  : ${maxDD.toFixed(1)}%`);
  console.log(`  Monthly:`);
  for (const [m, v] of Object.entries(monthly)) {
    const pct = (v.pnl/v.startBal*100).toFixed(1);
    console.log(`    ${m}  ${v.pnl >= 0 ? "+" : ""}$${v.pnl.toFixed(2)} (${v.pnl >= 0 ? "+" : ""}${pct}%)${v.pnl < 0 ? " ← NEG" : ""}`);
  }
}

(async () => {
  const start = Date.now() - LOOKBACK_MS;
  process.stdout.write("Fetching BTC... ");
  const btcRaw = await fetchKlines("BTCUSDT", start);
  console.log(`${btcRaw.length} candles`);
  process.stdout.write("Fetching BNB... ");
  const bnbRaw = await fetchKlines("BNBUSDT", start);
  console.log(`${bnbRaw.length} candles`);

  const btcMap = new Map(btcRaw.map(c => [c.time, c]));
  const aligned = bnbRaw.filter(c => btcMap.has(c.time));
  const btc = aligned.map(c => btcMap.get(c.time)!);

  run("BNB · TRAILING CHASE (current)", false, btc, aligned);
  run("BNB · EXIT AT PRICE (new)", true, btc, aligned);
})();
