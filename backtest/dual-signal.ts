/**
 * Dual Signal Accumulator
 * Requires BOTH BTC/USD BB AND ETHBTC BB to agree before switching.
 * When signals disagree → stay in current position (no switch).
 *
 * Also tests OR logic (either signal triggers) for comparison.
 *
 * Run: npx ts-node --transpile-only backtest/dual-signal.ts
 */

const BINANCE_BASE = "https://api.binance.us/api/v3";
const BINANCE_KEY  = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS  = 365 * 24 * 60 * 60 * 1000;
const START_BTC    = 0.013557;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string, interval: string, startMs: number, endMs: number) {
  const candles: { time: number; close: number }[] = [];
  let from = startMs;
  while (from < endMs) {
    const url = `${BINANCE_BASE}/klines?symbol=${symbol}&interval=${interval}` +
                `&startTime=${from}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url, { headers: { "X-MBX-APIKEY": BINANCE_KEY } });
    if (res.status === 429) { await sleep(10_000); continue; }
    if (!res.ok) throw new Error(`Binance ${res.status}: ${symbol}`);
    const raw = await res.json() as string[][];
    if (!raw.length) break;
    for (const c of raw) candles.push({ time: Number(c[0]), close: parseFloat(c[4]) });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(120);
  }
  return candles;
}

function maAbove(arr: number[], i: number, period: number): boolean {
  if (i < period) return false;
  const window = arr.slice(i - period + 1, i + 1);
  const mean   = window.reduce((a, b) => a + b, 0) / period;
  return arr[i] > mean;
}

type Logic = "AND" | "OR";

function runDual(
  btcArr:    number[],
  ethBtcArr: number[],
  solBtcArr: number[],
  btcPeriod: number,
  ethPeriod: number,
  logic:     Logic
): { finalBtc: number; gainPct: number; switches: number; timeInSol: number } {
  let holding: "BTC" | "SOL" = "BTC";
  let quantity  = START_BTC;
  let switches  = 0;
  let candlesInSol = 0;
  const warmup = Math.max(btcPeriod, ethPeriod);

  for (let i = warmup; i < btcArr.length; i++) {
    const btcUp  = maAbove(btcArr,    i, btcPeriod);
    const ethUp  = maAbove(ethBtcArr, i, ethPeriod);

    let wantSol: boolean;
    if (logic === "AND") {
      wantSol = btcUp && ethUp;   // both bullish → hold SOL
    } else {
      wantSol = btcUp || ethUp;   // either bullish → hold SOL
    }

    const target: "BTC" | "SOL" = wantSol ? "SOL" : "BTC";

    if (target !== holding) {
      const sp  = solBtcArr[i];
      quantity  = holding === "BTC" ? quantity / sp : quantity * sp;
      holding   = target;
      switches++;
    }
    if (holding === "SOL") candlesInSol++;
  }

  const total    = btcArr.length - warmup;
  const lastSp   = solBtcArr[solBtcArr.length - 1];
  const finalBtc = holding === "BTC" ? quantity : quantity * lastSp;
  return {
    finalBtc,
    gainPct:    (finalBtc - START_BTC) / START_BTC * 100,
    switches,
    timeInSol:  total > 0 ? candlesInSol / total : 0,
  };
}

async function main() {
  const now = Date.now(), startMs = now - LOOKBACK_MS;

  console.log("\nDual Signal Accumulator — AND / OR logic\n");

  process.stdout.write("Fetching BTCUSDT 5m...");
  const btc = await fetchKlines("BTCUSDT", "5m", startMs, now);
  process.stdout.write(` ${btc.length} candles\n`);

  process.stdout.write("Fetching ETHBTC 5m...");
  const eth = await fetchKlines("ETHBTC", "5m", startMs, now);
  process.stdout.write(` ${eth.length} candles\n`);

  process.stdout.write("Fetching SOLBTC 5m...");
  const sol = await fetchKlines("SOLBTC", "5m", startMs, now);
  process.stdout.write(` ${sol.length} candles\n\n`);

  // Align all three by time
  const ethMap = new Map(eth.map(c => [c.time, c.close]));
  const solMap = new Map(sol.map(c => [c.time, c.close]));
  const btcArr: number[] = [], ethArr: number[] = [], solArr: number[] = [];

  for (const c of btc) {
    const ep = ethMap.get(c.time), sp = solMap.get(c.time);
    if (ep !== undefined && sp !== undefined) {
      btcArr.push(c.close); ethArr.push(ep); solArr.push(sp);
    }
  }
  console.log(`Aligned: ${btcArr.length} candles\n`);

  // Reference: single BTC/USD BB(10)
  const ref = runDual(btcArr, ethArr, solArr, 10, 10, "OR");
  // With OR and ethPeriod irrelevant when btcUp dominates — compute true single signal reference
  function runSingle(arr: number[], solArr2: number[], period: number) {
    let holding: "BTC" | "SOL" = "BTC";
    let quantity = START_BTC, switches = 0;
    for (let i = period; i < arr.length; i++) {
      const above  = maAbove(arr, i, period);
      const target: "BTC" | "SOL" = above ? "SOL" : "BTC";
      if (target !== holding) {
        quantity = holding === "BTC" ? quantity / solArr2[i] : quantity * solArr2[i];
        holding  = target;
        switches++;
      }
    }
    const finalBtc = holding === "BTC" ? quantity : quantity * solArr2[solArr2.length - 1];
    return { finalBtc, gainPct: (finalBtc - START_BTC) / START_BTC * 100, switches };
  }

  const refBtc  = runSingle(btcArr, solArr, 10);
  const refEth  = runSingle(ethArr, solArr, 10);
  console.log(`References (single signal):`);
  console.log(`  BB(10) on BTC/USD: ${refBtc.finalBtc.toFixed(6)} BTC  (+${refBtc.gainPct.toFixed(1)}%)  ${refBtc.switches} switches`);
  console.log(`  BB(10) on ETHBTC:  ${refEth.finalBtc.toFixed(6)} BTC  (+${refEth.gainPct.toFixed(1)}%)  ${refEth.switches} switches\n`);

  // ── AND logic grid ───────────────────────────────────────────────────────
  const periods = [5, 10, 20, 30];
  console.log("── AND logic: switch only when BOTH signals agree ──");
  console.log(`${"BTC period".padEnd(12)} ${"ETH period".padEnd(12)} ${"FinalBTC".padStart(10)} ${"Gain%".padStart(8)} ${"Switches".padStart(9)} ${"In SOL".padStart(8)}  vs BTC/USD ref`);
  console.log("─".repeat(78));

  let bestAnd = { gainPct: -Infinity, btcP: 0, ethP: 0 };

  for (const btcP of periods) {
    for (const ethP of periods) {
      const r    = runDual(btcArr, ethArr, solArr, btcP, ethP, "AND");
      const diff = r.gainPct - refBtc.gainPct;
      const flag = diff > 100 ? "✓✓ Better" : diff > 0 ? "✓ Better" : "✗ Worse";
      if (r.gainPct > bestAnd.gainPct) bestAnd = { gainPct: r.gainPct, btcP, ethP };
      console.log(
        `BB(${btcP})`.padEnd(12) +
        `BB(${ethP})`.padEnd(12) +
        ` ${r.finalBtc.toFixed(6).padStart(10)}` +
        ` ${`${r.gainPct >= 0 ? "+" : ""}${r.gainPct.toFixed(1)}%`.padStart(8)}` +
        ` ${String(r.switches).padStart(9)}` +
        ` ${`${(r.timeInSol * 100).toFixed(0)}%`.padStart(8)}  ${flag}`
      );
    }
  }

  console.log(`\n★ Best AND combo: BTC BB(${bestAnd.btcP}) + ETH BB(${bestAnd.ethP}) → +${bestAnd.gainPct.toFixed(1)}%`);

  // ── OR logic grid ────────────────────────────────────────────────────────
  console.log("\n── OR logic: switch when EITHER signal triggers ──");
  console.log(`${"BTC period".padEnd(12)} ${"ETH period".padEnd(12)} ${"FinalBTC".padStart(10)} ${"Gain%".padStart(8)} ${"Switches".padStart(9)} ${"In SOL".padStart(8)}  vs BTC/USD ref`);
  console.log("─".repeat(78));

  let bestOr = { gainPct: -Infinity, btcP: 0, ethP: 0 };

  for (const btcP of periods) {
    for (const ethP of periods) {
      const r    = runDual(btcArr, ethArr, solArr, btcP, ethP, "OR");
      const diff = r.gainPct - refBtc.gainPct;
      const flag = diff > 100 ? "✓✓ Better" : diff > 0 ? "✓ Better" : "~ Close";
      if (r.gainPct > bestOr.gainPct) bestOr = { gainPct: r.gainPct, btcP, ethP };
      console.log(
        `BB(${btcP})`.padEnd(12) +
        `BB(${ethP})`.padEnd(12) +
        ` ${r.finalBtc.toFixed(6).padStart(10)}` +
        ` ${`${r.gainPct >= 0 ? "+" : ""}${r.gainPct.toFixed(1)}%`.padStart(8)}` +
        ` ${String(r.switches).padStart(9)}` +
        ` ${`${(r.timeInSol * 100).toFixed(0)}%`.padStart(8)}  ${flag}`
      );
    }
  }

  console.log(`\n★ Best OR combo: BTC BB(${bestOr.btcP}) + ETH BB(${bestOr.ethP}) → +${bestOr.gainPct.toFixed(1)}%`);

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n── Summary ──");
  console.log(`  Single BTC/USD BB(10):         +${refBtc.gainPct.toFixed(1)}%  (${refBtc.switches} switches)`);
  console.log(`  Best AND dual signal:           +${bestAnd.gainPct.toFixed(1)}%  (BTC BB${bestAnd.btcP} + ETH BB${bestAnd.ethP})`);
  console.log(`  Best OR  dual signal:           +${bestOr.gainPct.toFixed(1)}%  (BTC BB${bestOr.btcP} + ETH BB${bestOr.ethP})`);
}

main().catch(console.error);
