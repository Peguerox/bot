import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE        = "https://api.binance.com/api/v3";
const KEY         = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const THRESHOLD   = 0.005; // SOL >0.5% up
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
function pct(n: number, dp = 3) { return (n >= 0 ? "+" : "") + n.toFixed(dp) + "%" }

(async () => {
  const start = Date.now() - LOOKBACK_MS;

  process.stdout.write("Fetching SOL 5m... "); const sol = await fetchKlines("SOLUSDT", "5m", start); console.log(`${sol.length} candles`);
  process.stdout.write("Fetching BTC 5m... "); const btc = await fetchKlines("BTCUSDT", "5m", start); console.log(`${btc.length} candles`);

  const btcMap = new Map(btc.map(c => [c.time, c]));

  // For each signal event, collect the window of returns before it
  type Event = {
    // BTC returns: t-3, t-2, t-1, t (same candle)
    btc_t3: number; btc_t2: number; btc_t1: number; btc_t0: number;
    // SOL returns: t-3, t-2, t-1, t (the big move)
    sol_t3: number; sol_t2: number; sol_t1: number; sol_t0: number;
    // Cumulative BTC move in 3 candles before
    btc_cum3: number;
    // SOL vol ratio at signal
    volRatio: number;
    // Was BTC already up before SOL moved?
    btcLeadingSol: boolean;
  };

  const signals: Event[] = [];
  const baseline: Event[] = [];

  for (let i = VOL_WINDOW + 3; i < sol.length - 1; i++) {
    const btc0 = btcMap.get(sol[i].time);
    const btc1 = btcMap.get(sol[i-1].time);
    const btc2 = btcMap.get(sol[i-2].time);
    const btc3 = btcMap.get(sol[i-3].time);
    if (!btc0 || !btc1 || !btc2 || !btc3) continue;

    const volAvg = sol.slice(i - VOL_WINDOW, i).reduce((s, c) => s + c.volume, 0) / VOL_WINDOW;

    const e: Event = {
      btc_t3: ret(btc3), btc_t2: ret(btc2), btc_t1: ret(btc1), btc_t0: ret(btc0),
      sol_t3: ret(sol[i-3]), sol_t2: ret(sol[i-2]), sol_t1: ret(sol[i-1]), sol_t0: ret(sol[i]),
      btc_cum3: ret(btc3) + ret(btc2) + ret(btc1),
      volRatio: sol[i].volume / volAvg,
      btcLeadingSol: ret(btc1) > 0.1 && ret(sol[i-1]) < 0.1,
    };

    if (ret(sol[i]) >= THRESHOLD * 100) signals.push(e);
    else baseline.push(e);
  }

  function row(label: string, sVals: number[], bVals: number[]) {
    const s = avg(sVals);
    const b = avg(bVals);
    console.log(
      `  ${label.padEnd(32)}` +
      `signal=${pct(s).padStart(8)}   ` +
      `baseline=${pct(b).padStart(8)}   ` +
      `diff=${pct(s - b).padStart(8)}`
    );
  }

  console.log(`\nSOL >0.5% events: ${signals.length}  |  Baseline: ${baseline.length}\n`);

  console.log(`── BTC candles BEFORE the SOL move ─────────────────────────────────────────`);
  row("BTC  t-3 (3 candles before)", signals.map(e => e.btc_t3), baseline.map(e => e.btc_t3));
  row("BTC  t-2 (2 candles before)", signals.map(e => e.btc_t2), baseline.map(e => e.btc_t2));
  row("BTC  t-1 (1 candle before)",  signals.map(e => e.btc_t1), baseline.map(e => e.btc_t1));
  row("BTC  t-0 (same candle)",      signals.map(e => e.btc_t0), baseline.map(e => e.btc_t0));
  row("BTC  cumulative t-3 to t-1",  signals.map(e => e.btc_cum3), baseline.map(e => e.btc_cum3));

  console.log(`\n── SOL candles BEFORE the SOL move ─────────────────────────────────────────`);
  row("SOL  t-3 (3 candles before)", signals.map(e => e.sol_t3), baseline.map(e => e.sol_t3));
  row("SOL  t-2 (2 candles before)", signals.map(e => e.sol_t2), baseline.map(e => e.sol_t2));
  row("SOL  t-1 (1 candle before)",  signals.map(e => e.sol_t1), baseline.map(e => e.sol_t1));
  row("SOL  t-0 (the big move)",     signals.map(e => e.sol_t0), baseline.map(e => e.sol_t0));

  console.log(`\n── LAG DETECTION ───────────────────────────────────────────────────────────`);

  // How many signal events had BTC leading (BTC t-1 up >0.1% but SOL t-1 flat)
  const btcLed    = signals.filter(e => e.btcLeadingSol).length;
  const btcLedBase = baseline.filter(e => e.btcLeadingSol).length;
  console.log(`  BTC led SOL by 1 candle (BTC t-1 >0.1%, SOL t-1 <0.1%):`);
  console.log(`    Signal events:   ${btcLed}/${signals.length} (${(btcLed/signals.length*100).toFixed(1)}%)`);
  console.log(`    Baseline events: ${btcLedBase}/${baseline.length} (${(btcLedBase/baseline.length*100).toFixed(1)}%)`);

  // BTC cumulative 3 candles prior distribution
  const btcCumGt03 = signals.filter(e => e.btc_cum3 > 0.3).length;
  const btcCumGt01 = signals.filter(e => e.btc_cum3 > 0.1).length;
  console.log(`\n  BTC cumulative (t-3 to t-1) before SOL pumps:`);
  console.log(`    > 0.1% cumulative: ${btcCumGt01}/${signals.length} (${(btcCumGt01/signals.length*100).toFixed(1)}%)`);
  console.log(`    > 0.3% cumulative: ${btcCumGt03}/${signals.length} (${(btcCumGt03/signals.length*100).toFixed(1)}%)`);

  // Average lag: SOL vs BTC on same candle
  const avgBtcT0 = avg(signals.map(e => e.btc_t0));
  const avgSolT0 = avg(signals.map(e => e.sol_t0));
  console.log(`\n  On the signal candle itself:`);
  console.log(`    Avg BTC move: ${pct(avgBtcT0, 3)}`);
  console.log(`    Avg SOL move: ${pct(avgSolT0, 3)}`);
  console.log(`    SOL outpaces BTC by: ${pct(avgSolT0 - avgBtcT0, 3)}`);
})();
