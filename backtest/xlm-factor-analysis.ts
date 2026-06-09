import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE        = "https://api.binance.us/api/v3";
const KEY         = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const THRESHOLD   = 0.005; // 0.5%
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

function ret(c: { open: number; close: number }) { return (c.close - c.open) / c.open * 100; }
function avg(arr: number[]) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function pct(n: number, dp = 3) { return (n >= 0 ? "+" : "") + n.toFixed(dp) + "%"; }

(async () => {
  const start = Date.now() - LOOKBACK_MS;

  process.stdout.write("Fetching XLM 5m  (Binance.US)... "); const xlm = await fetchKlines("XLMUSDT", "5m", start); console.log(`${xlm.length} candles`);
  process.stdout.write("Fetching BTC 5m  (Binance.US)... "); const btc = await fetchKlines("BTCUSDT", "5m", start); console.log(`${btc.length} candles`);
  process.stdout.write("Fetching XRP 5m  (Binance.US)... "); const xrp = await fetchKlines("XRPUSDT", "5m", start); console.log(`${xrp.length} candles`);
  process.stdout.write("Fetching ETH 5m  (Binance.US)... "); const eth = await fetchKlines("ETHUSDT", "5m", start); console.log(`${eth.length} candles`);

  // Frequency
  let over05 = 0, over1 = 0, over2 = 0;
  for (let i = 1; i < xlm.length; i++) {
    const r = ret(xlm[i]);
    if (r > 0.5) over05++;
    if (r > 1.0) over1++;
    if (r > 2.0) over2++;
  }
  console.log(`\nXLM · 5m candles moving UP · 1 month · Binance.US`);
  console.log(`──────────────────────────────────────────────────────`);
  console.log(`> 0.5%   ${over05} times  (${(over05/30).toFixed(1)}/day)`);
  console.log(`> 1.0%   ${over1} times  (${(over1/30).toFixed(1)}/day)`);
  console.log(`> 2.0%   ${over2} times  (${(over2/30).toFixed(1)}/day)`);

  const btcMap = new Map(btc.map(c => [c.time, c]));
  const xrpMap = new Map(xrp.map(c => [c.time, c]));
  const ethMap = new Map(eth.map(c => [c.time, c]));

  type Event = {
    btc_t3: number; btc_t2: number; btc_t1: number; btc_t0: number;
    xrp_t1: number; xrp_t0: number;
    eth_t0: number;
    xlm_t3: number; xlm_t2: number; xlm_t1: number;
    volRatio: number;
    btcLed: boolean;
    xrpLed: boolean;
  };

  const signals: Event[] = [];
  const baseline: Event[] = [];

  for (let i = VOL_WINDOW + 3; i < xlm.length - 1; i++) {
    const b0 = btcMap.get(xlm[i].time);
    const b1 = btcMap.get(xlm[i-1].time);
    const b2 = btcMap.get(xlm[i-2].time);
    const b3 = btcMap.get(xlm[i-3].time);
    const r0 = xrpMap.get(xlm[i].time);
    const r1 = xrpMap.get(xlm[i-1].time);
    const e0 = ethMap.get(xlm[i].time);
    if (!b0||!b1||!b2||!b3||!r0||!r1||!e0) continue;

    const volAvg = xlm.slice(i - VOL_WINDOW, i).reduce((s, c) => s + c.volume, 0) / VOL_WINDOW;

    const e: Event = {
      btc_t3: ret(b3), btc_t2: ret(b2), btc_t1: ret(b1), btc_t0: ret(b0),
      xrp_t1: ret(r1), xrp_t0: ret(r0),
      eth_t0: ret(e0),
      xlm_t3: ret(xlm[i-3]), xlm_t2: ret(xlm[i-2]), xlm_t1: ret(xlm[i-1]),
      volRatio: xlm[i].volume / volAvg,
      btcLed: ret(b1) > 0.1 && ret(xlm[i-1]) < 0.05,
      xrpLed: ret(r1) > 0.1 && ret(xlm[i-1]) < 0.05,
    };

    if (ret(xlm[i]) >= THRESHOLD * 100) signals.push(e);
    else baseline.push(e);
  }

  function row(label: string, sVals: number[], bVals: number[]) {
    const s = avg(sVals), b = avg(bVals);
    console.log(`  ${label.padEnd(36)} signal=${pct(s).padStart(8)}   baseline=${pct(b).padStart(8)}   diff=${pct(s-b).padStart(8)}`);
  }

  console.log(`\nXLM >0.5% events: ${signals.length}  |  Baseline: ${baseline.length}\n`);

  console.log(`── INTRINSIC (XLM itself) ───────────────────────────────────────────────────`);
  row("XLM  t-3", signals.map(e=>e.xlm_t3), baseline.map(e=>e.xlm_t3));
  row("XLM  t-2", signals.map(e=>e.xlm_t2), baseline.map(e=>e.xlm_t2));
  row("XLM  t-1", signals.map(e=>e.xlm_t1), baseline.map(e=>e.xlm_t1));
  row("Volume ratio (current candle)", signals.map(e=>e.volRatio), baseline.map(e=>e.volRatio));

  console.log(`\n── EXTRINSIC (other coins) ─────────────────────────────────────────────────`);
  row("BTC  t-3 (3 candles before)", signals.map(e=>e.btc_t3), baseline.map(e=>e.btc_t3));
  row("BTC  t-2 (2 candles before)", signals.map(e=>e.btc_t2), baseline.map(e=>e.btc_t2));
  row("BTC  t-1 (1 candle before)",  signals.map(e=>e.btc_t1), baseline.map(e=>e.btc_t1));
  row("BTC  t-0 (same candle)",      signals.map(e=>e.btc_t0), baseline.map(e=>e.btc_t0));
  row("XRP  t-1 (1 candle before)",  signals.map(e=>e.xrp_t1), baseline.map(e=>e.xrp_t1));
  row("XRP  t-0 (same candle)",      signals.map(e=>e.xrp_t0), baseline.map(e=>e.xrp_t0));
  row("ETH  t-0 (same candle)",      signals.map(e=>e.eth_t0), baseline.map(e=>e.eth_t0));

  console.log(`\n── LAG DETECTION ───────────────────────────────────────────────────────────`);
  const btcUpSame  = signals.filter(e=>e.btc_t0 > 0).length;
  const xrpUpSame  = signals.filter(e=>e.xrp_t0 > 0).length;
  const btcLed     = signals.filter(e=>e.btcLed).length;
  const xrpLed     = signals.filter(e=>e.xrpLed).length;
  console.log(`  BTC  also up same candle:         ${btcUpSame}/${signals.length} (${(btcUpSame/signals.length*100).toFixed(1)}%)`);
  console.log(`  XRP  also up same candle:         ${xrpUpSame}/${signals.length} (${(xrpUpSame/signals.length*100).toFixed(1)}%)`);
  console.log(`  BTC  led XLM by 1 candle:         ${btcLed}/${signals.length} (${(btcLed/signals.length*100).toFixed(1)}%)`);
  console.log(`  XRP  led XLM by 1 candle:         ${xrpLed}/${signals.length} (${(xrpLed/signals.length*100).toFixed(1)}%)`);

  const avgBtcT0 = avg(signals.map(e=>e.btc_t0));
  const avgXlmT0 = avg(signals.map(e => ret(xlm[xlm.findIndex(c => c.time === xlm[VOL_WINDOW + 3].time) + signals.indexOf(e)] ?? xlm[0])));
  console.log(`\n  On the signal candle:`);
  console.log(`    Avg BTC move: ${pct(avgBtcT0)}`);
  console.log(`    Avg XRP t-1:  ${pct(avg(signals.map(e=>e.xrp_t1)))}`);

  const cumGt01 = signals.filter(e=>e.btc_t3+e.btc_t2+e.btc_t1 > 0.1).length;
  const cumGt03 = signals.filter(e=>e.btc_t3+e.btc_t2+e.btc_t1 > 0.3).length;
  console.log(`\n  BTC cumulative t-3 to t-1 before XLM pumps:`);
  console.log(`    > 0.1% cumulative: ${cumGt01}/${signals.length} (${(cumGt01/signals.length*100).toFixed(1)}%)`);
  console.log(`    > 0.3% cumulative: ${cumGt03}/${signals.length} (${(cumGt03/signals.length*100).toFixed(1)}%)`);
})();
