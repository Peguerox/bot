import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE        = "https://api.binance.com/api/v3";
const KEY         = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const THRESHOLD   = 0.005; // 0.5% up move
const VOL_WINDOW  = 20;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string, interval: string, startMs: number) {
  const candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  let from = startMs;
  const end = Date.now();
  while (from < end) {
    const res = await fetch(
      `${BASE}/klines?symbol=${symbol}&interval=${interval}&startTime=${from}&endTime=${end}&limit=1000`,
      { headers: { "X-MBX-APIKEY": KEY } }
    );
    if (res.status === 429) { await sleep(10000); continue; }
    const raw = await res.json() as any;
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) candles.push({
      time: Number(c[0]), open: parseFloat(c[1]), high: parseFloat(c[2]),
      low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5]),
    });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(150);
  }
  return candles;
}

function ret(c: { open: number; close: number }) { return (c.close - c.open) / c.open; }
function avg(arr: number[]) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function pct(n: number) { return (n * 100).toFixed(3) + "%"; }

(async () => {
  const start = Date.now() - LOOKBACK_MS;

  process.stdout.write("Fetching SOL 5m...  "); const sol = await fetchKlines("SOLUSDT", "5m", start); console.log(`${sol.length} candles`);
  process.stdout.write("Fetching BTC 5m...  "); const btc = await fetchKlines("BTCUSDT", "5m", start); console.log(`${btc.length} candles`);
  process.stdout.write("Fetching ETH 5m...  "); const eth = await fetchKlines("ETHUSDT", "5m", start); console.log(`${eth.length} candles`);
  process.stdout.write("Fetching BNB 5m...  "); const bnb = await fetchKlines("BNBUSDT", "5m", start); console.log(`${bnb.length} candles`);

  const btcMap = new Map(btc.map(c => [c.time, c]));
  const ethMap = new Map(eth.map(c => [c.time, c]));
  const bnbMap = new Map(bnb.map(c => [c.time, c]));

  // Collect metrics for signal candles vs all candles
  type Metrics = {
    // Intrinsic
    prevRet: number;         // SOL prev candle return
    volRatio: number;        // current vol / 20-avg vol
    prevVolRatio: number;    // prev candle vol ratio
    hour: number;            // hour of day (UTC)
    // Extrinsic
    btcRet: number;          // BTC same candle return
    ethRet: number;          // ETH same candle return
    bnbRet: number;          // BNB same candle return
    btcPrevRet: number;      // BTC prev candle return
    btcVolRatio: number;     // BTC vol ratio
  };

  const signalMetrics: Metrics[] = [];
  const baselineMetrics: Metrics[] = [];

  for (let i = VOL_WINDOW + 1; i < sol.length - 1; i++) {
    const c     = sol[i];
    const prev  = sol[i - 1];
    const btcC  = btcMap.get(c.time);
    const ethC  = ethMap.get(c.time);
    const bnbC  = bnbMap.get(c.time);
    const btcP  = btcMap.get(prev.time);
    if (!btcC || !ethC || !bnbC || !btcP) continue;

    const volAvg     = avg(sol.slice(i - VOL_WINDOW, i).map(x => x.volume));
    const btcVolAvg  = avg(btc.slice(i - VOL_WINDOW, i).filter(Boolean).map((x: any) => x.volume));

    const m: Metrics = {
      prevRet:      ret(prev),
      volRatio:     c.volume / volAvg,
      prevVolRatio: prev.volume / volAvg,
      hour:         new Date(c.time).getUTCHours(),
      btcRet:       ret(btcC),
      ethRet:       ret(ethC),
      bnbRet:       ret(bnbC),
      btcPrevRet:   ret(btcP),
      btcVolRatio:  btcC.volume / btcVolAvg,
    };

    const solRet = ret(c);
    if (solRet >= THRESHOLD) signalMetrics.push(m);
    else baselineMetrics.push(m);
  }

  function stats(label: string, signalVals: number[], baselineVals: number[], isRaw = false) {
    const sAvg = avg(signalVals);
    const bAvg = avg(baselineVals);
    const diff = sAvg - bAvg;
    const fmt  = (v: number) => isRaw ? v.toFixed(2) : (v * 100).toFixed(3) + "%";
    const arrow = diff > 0 ? "↑ " : "↓ ";
    console.log(
      `  ${label.padEnd(30)}` +
      `signal=${fmt(sAvg).padStart(9)}  ` +
      `baseline=${fmt(bAvg).padStart(9)}  ` +
      `edge=${arrow}${fmt(Math.abs(diff)).padStart(8)}`
    );
  }

  console.log(`\nSOL >0.5% up candles: ${signalMetrics.length}  |  All other candles: ${baselineMetrics.length}\n`);
  console.log(`─── INTRINSIC FACTORS ──────────────────────────────────────────────────────`);
  stats("Prev candle return (SOL)",   signalMetrics.map(m => m.prevRet),      baselineMetrics.map(m => m.prevRet));
  stats("Volume ratio (current)",     signalMetrics.map(m => m.volRatio),     baselineMetrics.map(m => m.volRatio), true);
  stats("Volume ratio (prev candle)", signalMetrics.map(m => m.prevVolRatio), baselineMetrics.map(m => m.prevVolRatio), true);

  // Hour of day distribution
  const hours: Record<number, number> = {};
  signalMetrics.forEach(m => hours[m.hour] = (hours[m.hour] ?? 0) + 1);
  const topHours = Object.entries(hours).sort((a,b) => +b[1] - +a[1]).slice(0,5).map(([h,c]) => `${h}:00 UTC (${c}x)`);
  console.log(`  ${"Top hours (UTC)".padEnd(30)}${topHours.join("  ")}`);

  console.log(`\n─── EXTRINSIC FACTORS ──────────────────────────────────────────────────────`);
  stats("BTC same candle return",     signalMetrics.map(m => m.btcRet),      baselineMetrics.map(m => m.btcRet));
  stats("BTC prev candle return",     signalMetrics.map(m => m.btcPrevRet),  baselineMetrics.map(m => m.btcPrevRet));
  stats("ETH same candle return",     signalMetrics.map(m => m.ethRet),      baselineMetrics.map(m => m.ethRet));
  stats("BNB same candle return",     signalMetrics.map(m => m.bnbRet),      baselineMetrics.map(m => m.bnbRet));
  stats("BTC volume ratio",           signalMetrics.map(m => m.btcVolRatio), baselineMetrics.map(m => m.btcVolRatio), true);

  // How often BTC was also up on signal candles
  const btcAlsoUp = signalMetrics.filter(m => m.btcRet > 0).length;
  const btcUpBase = baselineMetrics.filter(m => m.btcRet > 0).length;
  console.log(`\n  BTC also up on signal candles:   ${btcAlsoUp}/${signalMetrics.length} (${(btcAlsoUp/signalMetrics.length*100).toFixed(1)}%)`);
  console.log(`  BTC also up on baseline candles: ${btcUpBase}/${baselineMetrics.length} (${(btcUpBase/baselineMetrics.length*100).toFixed(1)}%)`);

  const btcLed = signalMetrics.filter(m => m.btcPrevRet > 0.001).length;
  console.log(`  BTC prev candle was up >0.1%:    ${btcLed}/${signalMetrics.length} (${(btcLed/signalMetrics.length*100).toFixed(1)}%)`);
})();
