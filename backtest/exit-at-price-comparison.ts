import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE         = "https://api.binance.us/api/v3";
const KEY          = process.env.BINANCE_API_KEY!;
const TP_PCT       = 0.008;
const SL_PCT       = 0.0015;
const MAX_HOLD     = 6;
const ALLOCATION   = 25;
const LOOKBACK_MS  = 365 * 24 * 60 * 60 * 1000;
const CORR_WINDOW  = 20;
const Z_THRESH     = 1.5;
const CHASE_OFFSET = 0.001;
const BTC_THRESH   = 0.003;
const COIN_MAX     = 0.001;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string, startMs: number) {
  const candles: { time: number; close: number; high: number; low: number }[] = [];
  let from = startMs;
  const end = Date.now();
  while (from < end) {
    const res = await fetch(`${BASE}/klines?symbol=${symbol}&interval=1m&startTime=${from}&endTime=${end}&limit=1000`, { headers: { "X-MBX-APIKEY": KEY } });
    if (res.status === 429) { await sleep(10000); continue; }
    const raw = await res.json() as string[][];
    if (!raw.length) break;
    for (const c of raw) candles.push({ time: Number(c[0]), close: parseFloat(c[4]), high: parseFloat(c[2]), low: parseFloat(c[3]) });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(150);
  }
  return candles;
}

function calcZScore(btc: number[], xlm: number[], i: number): number {
  if (i < CORR_WINDOW + 1) return 0;
  const spreads: number[] = [];
  for (let j = i - CORR_WINDOW; j <= i; j++) spreads.push(Math.log(xlm[j]/xlm[j-1]) - Math.log(btc[j]/btc[j-1]));
  const mean = spreads.reduce((a,b) => a+b,0) / spreads.length;
  const std  = Math.sqrt(spreads.reduce((a,b) => a+(b-mean)**2,0) / spreads.length);
  return std === 0 ? 0 : (spreads[spreads.length-1] - mean) / std;
}

function runBacktest(label: string, coin: any[], btc: any[], useExitAtPrice: boolean, useZScore: boolean) {
  let bal = ALLOCATION, peak = ALLOCATION, maxDD = 0;
  let tpCount = 0, slCount = 0, expireWins = 0, expireLosses = 0;
  let grossWin = 0, grossLoss = 0;
  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chase_floor: number };
  let pos: Pos | null = null;

  const btcClose = btc.map(c => c.close);
  const coinClose = coin.map(c => c.close);

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

    if (pos) {
      if (pos.chasing) {
        if (low < pos.chase_floor) {
          const exit = close >= pos.chase_floor * 0.998 ? pos.chase_floor : close;
          const p = closePos(exit);
          if (p >= 0) expireWins++; else expireLosses++;
        } else {
          const nf = close * (1 - CHASE_OFFSET);
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
            pos.chase_floor = close * (1 - CHASE_OFFSET);
          }
        }
      }
      continue;
    }

    let signal = false;
    if (useZScore) {
      signal = calcZScore(btcClose, coinClose, i) <= -Z_THRESH;
    } else {
      const btcRet  = (btc[i].close - btc[i-1].close) / btc[i-1].close;
      const coinRet = (close - coin[i-1].close) / coin[i-1].close;
      signal = btcRet >= BTC_THRESH && coinRet < COIN_MAX;
    }
    if (signal) pos = { entry: close, tp: close*(1+TP_PCT), sl: close*(1-SL_PCT), hold: 0, chasing: false, chase_floor: 0 };
  }

  const trades = tpCount + slCount + expireWins + expireLosses;
  const wins   = tpCount + expireWins;
  const pnl    = bal - ALLOCATION;
  const wr     = trades > 0 ? (wins/trades*100).toFixed(1) : "0";
  const pf     = grossLoss > 0 ? (grossWin/grossLoss).toFixed(2) : "∞";
  console.log(`  ${label.padEnd(36)} PnL: ${("+$"+pnl.toFixed(2)).padStart(8)} (${(pnl/ALLOCATION*100).toFixed(1).padStart(5)}%)  WR: ${wr.padStart(4)}%  PF: ${pf.padStart(5)}  DD: ${maxDD.toFixed(1).padStart(5)}%  T: ${trades}`);
}

(async () => {
  const start = Date.now() - LOOKBACK_MS;
  process.stdout.write("Fetching BTC... ");
  const btc = await fetchKlines("BTCUSDT", start);
  console.log(`${btc.length} candles`);
  process.stdout.write("Fetching XLM... ");
  const xlm = await fetchKlines("XLMUSDT", start);
  console.log(`${xlm.length} candles`);
  process.stdout.write("Fetching BNB... ");
  const bnb = await fetchKlines("BNBUSDT", start);
  console.log(`${bnb.length} candles`);

  const btcMapXlm = new Map(btc.map(c => [c.time, c]));
  const xlmAligned = xlm.filter(c => btcMapXlm.has(c.time));
  const btcForXlm  = xlmAligned.map(c => btcMapXlm.get(c.time)!);

  const btcMapBnb = new Map(btc.map(c => [c.time, c]));
  const bnbAligned = bnb.filter(c => btcMapBnb.has(c.time));
  const btcForBnb  = bnbAligned.map(c => btcMapBnb.get(c.time)!);

  console.log(`\n1 year · compounding · 0% fees · TP=0.8% · SL=0.15%\n`);
  runBacktest("XLM Z-lag  · trailing chase", xlmAligned, btcForXlm, false, true);
  runBacktest("XLM Z-lag  · exit at price ", xlmAligned, btcForXlm, true,  true);
  console.log();
  runBacktest("BNB pure-lag · trailing chase", bnbAligned, btcForBnb, false, false);
  runBacktest("BNB pure-lag · exit at price ", bnbAligned, btcForBnb, true,  false);
})();
