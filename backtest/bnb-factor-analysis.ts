import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE        = "https://api.binance.us/api/v3";
const BASE_GLOBAL = "https://api.binance.com/api/v3";
const KEY         = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const THRESHOLD   = 0.005; // 0.5%
const VOL_WINDOW  = 20;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(base: string, symbol: string, interval: string, startMs: number) {
  const candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  let from = startMs;
  const end = Date.now();
  while (from < end) {
    const res = await fetch(
      `${base}/klines?symbol=${symbol}&interval=${interval}&startTime=${from}&endTime=${end}&limit=1000`,
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

function ret(c: { open: number; close: number }) { return (c.close - c.open) / c.open * 100; }
function avg(arr: number[]) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function pct(n: number) { return (n >= 0 ? "+" : "") + n.toFixed(3) + "%" }

(async () => {
  const start = Date.now() - LOOKBACK_MS;

  process.stdout.write("Fetching BNB 5m  (Binance.US)...     "); const bnb = await fetchKlines(BASE,        "BNBUSDT", "5m", start); console.log(`${bnb.length} candles`);
  process.stdout.write("Fetching BTC 5m  (Binance.US)...     "); const btcUS = await fetchKlines(BASE,       "BTCUSDT", "5m", start); console.log(`${btcUS.length} candles`);
  process.stdout.write("Fetching BTC 5m  (Binance global)... "); const btcGL = await fetchKlines(BASE_GLOBAL, "BTCUSDT", "5m", start); console.log(`${btcGL.length} candles`);
  process.stdout.write("Fetching ETH 5m  (Binance.US)...     "); const eth = await fetchKlines(BASE,        "ETHUSDT", "5m", start); console.log(`${eth.length} candles`);

  // Frequency count first
  let over05 = 0, over1 = 0, over2 = 0;
  for (let i = 1; i < bnb.length; i++) {
    const r = ret(bnb[i]);
    if (r > 0.5) over05++;
    if (r > 1.0) over1++;
    if (r > 2.0) over2++;
  }
  console.log(`\nBNB · 5m candles moving UP · 1 month · Binance.US`);
  console.log(`──────────────────────────────────────────────────`);
  console.log(`> 0.5%   ${over05} times  (${(over05/30).toFixed(1)}/day)`);
  console.log(`> 1.0%   ${over1} times  (${(over1/30).toFixed(1)}/day)`);
  console.log(`> 2.0%   ${over2} times  (${(over2/30).toFixed(1)}/day)`);

  const btcUSMap = new Map(btcUS.map(c => [c.time, c]));
  const btcGLMap = new Map(btcGL.map(c => [c.time, c]));
  const ethMap   = new Map(eth.map(c => [c.time, c]));

  type Event = {
    // BTC.US before
    btcUS_t3: number; btcUS_t2: number; btcUS_t1: number; btcUS_t0: number;
    // BTC global before (price discovery leader)
    btcGL_t1: number; btcGL_t0: number;
    // ETH
    eth_t0: number;
    // BNB before
    bnb_t3: number; bnb_t2: number; bnb_t1: number;
    // Vol
    volRatio: number;
    // Lag flags
    btcUSLed: boolean;  // BTC.US t-1 up >0.1%, BNB t-1 flat
    btcGLLed: boolean;  // BTC global t-1 up >0.1%, BNB t-1 flat
  };

  const signals: Event[] = [];
  const baseline: Event[] = [];

  for (let i = VOL_WINDOW + 3; i < bnb.length - 1; i++) {
    const b0 = btcUSMap.get(bnb[i].time);
    const b1 = btcUSMap.get(bnb[i-1].time);
    const b2 = btcUSMap.get(bnb[i-2].time);
    const b3 = btcUSMap.get(bnb[i-3].time);
    const g0 = btcGLMap.get(bnb[i].time);
    const g1 = btcGLMap.get(bnb[i-1].time);
    const e0 = ethMap.get(bnb[i].time);
    if (!b0||!b1||!b2||!b3||!g0||!g1||!e0) continue;

    const volAvg = bnb.slice(i - VOL_WINDOW, i).reduce((s, c) => s + c.volume, 0) / VOL_WINDOW;

    const e: Event = {
      btcUS_t3: ret(b3), btcUS_t2: ret(b2), btcUS_t1: ret(b1), btcUS_t0: ret(b0),
      btcGL_t1: ret(g1), btcGL_t0: ret(g0),
      eth_t0:   ret(e0),
      bnb_t3:   ret(bnb[i-3]), bnb_t2: ret(bnb[i-2]), bnb_t1: ret(bnb[i-1]),
      volRatio: bnb[i].volume / volAvg,
      btcUSLed: ret(b1) > 0.1 && ret(bnb[i-1]) < 0.05,
      btcGLLed: ret(g1) > 0.1 && ret(bnb[i-1]) < 0.05,
    };

    if (ret(bnb[i]) >= THRESHOLD * 100) signals.push(e);
    else baseline.push(e);
  }

  function row(label: string, sVals: number[], bVals: number[]) {
    const s = avg(sVals), b = avg(bVals);
    console.log(`  ${label.padEnd(36)} signal=${pct(s).padStart(8)}   baseline=${pct(b).padStart(8)}   diff=${pct(s-b).padStart(8)}`);
  }

  console.log(`\nBNB >0.5% events: ${signals.length}  |  Baseline: ${baseline.length}\n`);

  console.log(`── INTRINSIC (BNB itself) ───────────────────────────────────────────────────`);
  row("BNB  t-3", signals.map(e=>e.bnb_t3), baseline.map(e=>e.bnb_t3));
  row("BNB  t-2", signals.map(e=>e.bnb_t2), baseline.map(e=>e.bnb_t2));
  row("BNB  t-1", signals.map(e=>e.bnb_t1), baseline.map(e=>e.bnb_t1));
  row("Volume ratio (current candle)", signals.map(e=>e.volRatio), baseline.map(e=>e.volRatio));

  console.log(`\n── EXTRINSIC (other coins) ─────────────────────────────────────────────────`);
  row("BTC.US   t-3", signals.map(e=>e.btcUS_t3), baseline.map(e=>e.btcUS_t3));
  row("BTC.US   t-2", signals.map(e=>e.btcUS_t2), baseline.map(e=>e.btcUS_t2));
  row("BTC.US   t-1 (1 candle before)", signals.map(e=>e.btcUS_t1), baseline.map(e=>e.btcUS_t1));
  row("BTC.US   t-0 (same candle)",     signals.map(e=>e.btcUS_t0), baseline.map(e=>e.btcUS_t0));
  row("BTC global t-1 (1 candle before)", signals.map(e=>e.btcGL_t1), baseline.map(e=>e.btcGL_t1));
  row("BTC global t-0 (same candle)",     signals.map(e=>e.btcGL_t0), baseline.map(e=>e.btcGL_t0));
  row("ETH      t-0 (same candle)",     signals.map(e=>e.eth_t0), baseline.map(e=>e.eth_t0));

  console.log(`\n── LAG DETECTION ───────────────────────────────────────────────────────────`);
  const btcUSLed  = signals.filter(e=>e.btcUSLed).length;
  const btcGLLed  = signals.filter(e=>e.btcGLLed).length;
  const btcUpSame = signals.filter(e=>e.btcUS_t0 > 0).length;
  console.log(`  BTC.US    also up same candle:        ${btcUpSame}/${signals.length} (${(btcUpSame/signals.length*100).toFixed(1)}%)`);
  console.log(`  BTC.US    led BNB by 1 candle:        ${btcUSLed}/${signals.length} (${(btcUSLed/signals.length*100).toFixed(1)}%)`);
  console.log(`  BTC global led BNB by 1 candle:       ${btcGLLed}/${signals.length} (${(btcGLLed/signals.length*100).toFixed(1)}%)`);

  const avgBtc = avg(signals.map(e=>e.btcUS_t0));
  console.log(`\n  On the signal candle:`);
  console.log(`    Avg BTC.US move: ${pct(avgBtc)}`);
  console.log(`\n  BTC.US cumulative t-3 to t-1 before BNB pumps:`);
  const cumGt01 = signals.filter(e=>e.btcUS_t3+e.btcUS_t2+e.btcUS_t1 > 0.1).length;
  const cumGt03 = signals.filter(e=>e.btcUS_t3+e.btcUS_t2+e.btcUS_t1 > 0.3).length;
  console.log(`    > 0.1% cumulative: ${cumGt01}/${signals.length} (${(cumGt01/signals.length*100).toFixed(1)}%)`);
  console.log(`    > 0.3% cumulative: ${cumGt03}/${signals.length} (${(cumGt03/signals.length*100).toFixed(1)}%)`);
})();
