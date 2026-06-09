import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE        = "https://api.binance.us/api/v3";
const KEY         = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string, startMs: number) {
  const candles: { time: number; close: number }[] = [];
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
    for (const c of raw) candles.push({ time: Number(c[0]), close: parseFloat(c[4]) });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(150);
  }
  return candles;
}

function pearson(x: number[], y: number[]): number {
  const n    = x.length;
  const mx   = x.reduce((a, b) => a + b, 0) / n;
  const my   = y.reduce((a, b) => a + b, 0) / n;
  const num  = x.reduce((s, xi, i) => s + (xi - mx) * (y[i] - my), 0);
  const denX = Math.sqrt(x.reduce((s, xi) => s + (xi - mx) ** 2, 0));
  const denY = Math.sqrt(y.reduce((s, yi) => s + (yi - my) ** 2, 0));
  return denX === 0 || denY === 0 ? 0 : num / (denX * denY);
}

(async () => {
  const start = Date.now() - LOOKBACK_MS;

  process.stdout.write("Fetching BTC... ");
  const btcRaw = await fetchKlines("BTCUSDT", start);
  console.log(`${btcRaw.length} candles`);

  process.stdout.write("Fetching BNB... ");
  const bnbRaw = await fetchKlines("BNBUSDT", start);
  console.log(`${bnbRaw.length} candles\n`);

  const btcMap  = new Map(btcRaw.map(c => [c.time, c.close]));
  const aligned = bnbRaw.filter(c => btcMap.has(c.time));
  const btcClose = aligned.map(c => btcMap.get(c.time)!);
  const bnbClose = aligned.map(c => c.close);

  // 1-minute log returns
  const btcRet: number[] = [];
  const bnbRet: number[] = [];
  for (let i = 1; i < aligned.length; i++) {
    btcRet.push(Math.log(btcClose[i] / btcClose[i - 1]));
    bnbRet.push(Math.log(bnbClose[i] / bnbClose[i - 1]));
  }

  // Same-candle correlation (BTC[t] vs BNB[t])
  const corrSame = pearson(btcRet, bnbRet);

  // Lag-1: BTC[t-1] vs BNB[t] — does BNB follow BTC with 1 candle delay?
  const corrLag1 = pearson(btcRet.slice(0, -1), bnbRet.slice(1));

  // Lag-2: BTC[t-2] vs BNB[t]
  const corrLag2 = pearson(btcRet.slice(0, -2), bnbRet.slice(2));

  // Lag-3
  const corrLag3 = pearson(btcRet.slice(0, -3), bnbRet.slice(3));

  console.log(`BTC/BNB 1-minute return correlation (1 month, ${btcRet.length} candles)`);
  console.log(`─────────────────────────────────────────────────`);
  console.log(`Same candle  (BTC[t] → BNB[t]):   ${corrSame.toFixed(4)}  ${corrSame > 0.7 ? "← strong" : corrSame > 0.4 ? "← moderate" : "← weak"}`);
  console.log(`Lag 1 candle (BTC[t-1] → BNB[t]): ${corrLag1.toFixed(4)}  ${Math.abs(corrLag1) > 0.05 ? "← lag signal exists" : "← no lag signal"}`);
  console.log(`Lag 2 candle (BTC[t-2] → BNB[t]): ${corrLag2.toFixed(4)}`);
  console.log(`Lag 3 candle (BTC[t-3] → BNB[t]): ${corrLag3.toFixed(4)}`);

  // When BTC pumps hard, does BNB follow in the NEXT candle?
  const BTC_THRESH = 0.002; // 0.2%
  let btcPumps = 0, bnbFollowed = 0, bnbLagged = 0;
  for (let i = 0; i < btcRet.length - 1; i++) {
    if (btcRet[i] >= BTC_THRESH) {
      btcPumps++;
      if (bnbRet[i + 1] > 0.001)  bnbFollowed++; // BNB up >0.1% next candle
      if (bnbRet[i] < 0.001)      bnbLagged++;    // BNB didn't move same candle
    }
  }

  console.log(`\nWhen BTC pumps ≥0.2% (${btcPumps} events):`);
  console.log(`  BNB also lags same candle (<0.1%): ${bnbLagged}  (${(bnbLagged/btcPumps*100).toFixed(1)}%)`);
  console.log(`  BNB follows next candle (>0.1%):   ${bnbFollowed}  (${(bnbFollowed/btcPumps*100).toFixed(1)}%)`);

  // Average BNB return in the candle AFTER a BTC pump
  const nextReturns = btcRet
    .map((r, i) => r >= BTC_THRESH ? bnbRet[i + 1] : null)
    .filter((r): r is number => r !== null);
  const avgNext = nextReturns.reduce((a, b) => a + b, 0) / nextReturns.length;
  console.log(`  Avg BNB return next candle:        ${(avgNext * 100).toFixed(4)}%`);

  // Avg BNB return on a random candle (baseline)
  const avgAll = bnbRet.reduce((a, b) => a + b, 0) / bnbRet.length;
  console.log(`  Avg BNB return any candle:         ${(avgAll * 100).toFixed(4)}%`);
  console.log(`  Edge (vs baseline):                ${((avgNext - avgAll) * 100).toFixed(4)}%`);
})();
