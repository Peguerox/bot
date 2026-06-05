/**
 * BTC Dominance Signal Backtest
 * Tests two dominance proxies as switching signals:
 *   A) ETHBTC ratio BB — industry standard "alt season" indicator
 *   B) Actual BTC dominance % from CoinGecko (daily, free API)
 *
 * Strategy: hold SOL when alts outperforming, hold BTC when BTC dominating
 * Measures profit in BTC (same as accumulator backtest)
 *
 * Run: npx ts-node --transpile-only backtest/btc-dominance.ts
 */

const BINANCE_BASE = "https://api.binance.us/api/v3";
const BINANCE_KEY  = process.env.BINANCE_API_KEY ?? "";
const COINGECKO    = "https://api.coingecko.com/api/v3";
const LOOKBACK_MS  = 365 * 24 * 60 * 60 * 1000; // 1 year
const START_BTC    = 0.013557;

const BB_PERIODS   = [5, 10, 20, 30, 50];

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

async function fetchBtcDominance(): Promise<{ time: number; dominance: number }[]> {
  // CoinGecko global market chart — returns BTC dominance % history
  const url = `${COINGECKO}/global/market_cap_chart?vs_currency=usd&days=365`;
  const res  = await fetch(url, { headers: { "accept": "application/json" } });
  if (!res.ok) {
    process.stdout.write(` [not available: ${res.status}]`);
    return [];
  }
  const json = await res.json() as { market_cap_percentage: { btc: [number, number][] } };
  const raw  = json?.market_cap_percentage?.btc;
  if (!raw) return [];
  return raw.map(([ts, pct]) => ({ time: ts, dominance: pct }));
}

// Accumulator simulation: signal series drives the switch
// signalAboveMeanHoldSol: if signal > MA → hold SOL (true for ETHBTC: rising ETH = alt season)
// if false: signal > MA → hold BTC (for dominance: rising dom = BTC season)
function runAccumulator(
  signalArr:   number[],
  solBtcArr:   number[],
  period:      number,
  aboveMeansHoldSol: boolean
): { finalBtc: number; gainPct: number; switches: number } {
  let holding: "BTC" | "SOL" = "BTC";
  let quantity = START_BTC;
  let switches = 0;

  for (let i = period; i < signalArr.length; i++) {
    const window = signalArr.slice(i - period + 1, i + 1);
    const mean   = window.reduce((a, b) => a + b, 0) / period;
    const above  = signalArr[i] > mean;
    const wantSol = above === aboveMeansHoldSol;
    const target: "BTC" | "SOL" = wantSol ? "SOL" : "BTC";

    if (target !== holding) {
      const sp = solBtcArr[i];
      quantity  = holding === "BTC" ? quantity / sp : quantity * sp;
      holding   = target;
      switches++;
    }
  }

  const lastSp  = solBtcArr[solBtcArr.length - 1];
  const finalBtc = holding === "BTC" ? quantity : quantity * lastSp;
  return { finalBtc, gainPct: (finalBtc - START_BTC) / START_BTC * 100, switches };
}

// Dominance threshold strategy: hold SOL when dominance < threshold, BTC when above
function runDomThreshold(
  domArr:    { time: number; dominance: number }[],
  solBtcMap: Map<number, number>,
  threshold: number
): { finalBtc: number; gainPct: number; switches: number } {
  // Find closest 5m candle for each daily dominance reading
  let holding: "BTC" | "SOL" = "BTC";
  let quantity = START_BTC;
  let switches = 0;

  for (const { time, dominance } of domArr) {
    // Find nearest SOLBTC 5m candle (within 5 min of dominance timestamp)
    const sp = solBtcMap.get(
      [...solBtcMap.keys()].reduce((a, b) => Math.abs(b - time) < Math.abs(a - time) ? b : a)
    );
    if (!sp) continue;

    const wantSol = dominance < threshold;
    const target: "BTC" | "SOL" = wantSol ? "SOL" : "BTC";

    if (target !== holding) {
      quantity = holding === "BTC" ? quantity / sp : quantity * sp;
      holding  = target;
      switches++;
    }
  }

  const lastSp  = [...solBtcMap.values()].at(-1) ?? 1;
  const finalBtc = holding === "BTC" ? quantity : quantity * lastSp;
  return { finalBtc, gainPct: (finalBtc - START_BTC) / START_BTC * 100, switches };
}

async function main() {
  const now = Date.now(), startMs = now - LOOKBACK_MS;

  console.log("\nBTC Dominance Signal Backtest\n");

  // Fetch data
  process.stdout.write("Fetching SOLBTC 5m (1 year)...");
  const solBtc = await fetchKlines("SOLBTC", "5m", startMs, now);
  process.stdout.write(` ${solBtc.length} candles\n`);

  process.stdout.write("Fetching ETHBTC 5m (1 year)...");
  const ethBtc = await fetchKlines("ETHBTC", "5m", startMs, now);
  process.stdout.write(` ${ethBtc.length} candles\n`);

  process.stdout.write("Fetching BTC dominance from CoinGecko...");
  const domData = await fetchBtcDominance();
  process.stdout.write(` ${domData.length} days\n\n`);

  // Align ETHBTC and SOLBTC by time
  const solMap   = new Map(solBtc.map(c => [c.time, c.close]));
  const ethArr:  number[] = [];
  const solArr:  number[] = [];

  for (const c of ethBtc) {
    const sp = solMap.get(c.time);
    if (sp !== undefined) { ethArr.push(c.close); solArr.push(sp); }
  }
  console.log(`Aligned: ${ethArr.length} candles\n`);

  // Baselines
  const startSolBtc = solBtc[0].close, endSolBtc = solBtc[solBtc.length - 1].close;
  const holdSolFinal = (START_BTC / startSolBtc) * endSolBtc;
  const holdSolGain  = (holdSolFinal - START_BTC) / START_BTC * 100;
  console.log(`Baselines (no switching):`);
  console.log(`  Hold BTC always: ${START_BTC.toFixed(6)} BTC  (+0.00%)`);
  console.log(`  Hold SOL always: ${holdSolFinal.toFixed(6)} BTC  (${holdSolGain >= 0 ? "+" : ""}${holdSolGain.toFixed(1)}%)`);

  // Reference: original accumulator (BB on BTCUSDT)
  process.stdout.write("\nFetching BTCUSDT 5m for reference comparison...");
  const btcUsd = await fetchKlines("BTCUSDT", "5m", startMs, now);
  process.stdout.write(` ${btcUsd.length} candles\n`);
  const btcMap = new Map(btcUsd.map(c => [c.time, c.close]));
  const btcArr: number[] = [], solArrBtc: number[] = [];
  for (const c of btcUsd) {
    const sp = solMap.get(c.time);
    if (sp !== undefined) { btcArr.push(c.close); solArrBtc.push(sp); }
  }
  const ref = runAccumulator(btcArr, solArrBtc, 10, true);
  console.log(`  Reference (BB10 on BTC/USD): ${ref.finalBtc.toFixed(6)} BTC  (+${ref.gainPct.toFixed(1)}%)  ${ref.switches} switches\n`);

  // ── Signal A: ETHBTC ratio BB ────────────────────────────────────────────
  console.log("── Signal A: BB on ETHBTC ratio (above MA = ETH outperforming = hold SOL) ──");
  console.log(`${"Period".padEnd(8)} ${"FinalBTC".padStart(10)} ${"Gain%".padStart(8)} ${"Switches".padStart(9)}  vs Ref`);
  console.log("─".repeat(50));

  for (const period of BB_PERIODS) {
    const r    = runAccumulator(ethArr, solArr, period, true);
    const diff = r.gainPct - ref.gainPct;
    const flag = diff > 100 ? "✓✓ Better" : diff > 0 ? "✓ Better" : diff > -500 ? "~ Close" : "✗ Worse";
    console.log(
      `BB(${period})`.padEnd(8) +
      ` ${r.finalBtc.toFixed(6).padStart(10)}` +
      ` ${`${r.gainPct >= 0 ? "+" : ""}${r.gainPct.toFixed(1)}%`.padStart(8)}` +
      ` ${String(r.switches).padStart(9)}  ${flag}`
    );
  }

  // ── Signal A inverted: ETHBTC falling = hold SOL (contrarian) ───────────
  console.log("\n── Signal A (inverted): BB on ETHBTC — below MA = ETH lagging = hold SOL ──");
  console.log(`${"Period".padEnd(8)} ${"FinalBTC".padStart(10)} ${"Gain%".padStart(8)} ${"Switches".padStart(9)}`);
  console.log("─".repeat(45));

  for (const period of BB_PERIODS) {
    const r = runAccumulator(ethArr, solArr, period, false);
    console.log(
      `BB(${period})`.padEnd(8) +
      ` ${r.finalBtc.toFixed(6).padStart(10)}` +
      ` ${`${r.gainPct >= 0 ? "+" : ""}${r.gainPct.toFixed(1)}%`.padStart(8)}` +
      ` ${String(r.switches).padStart(9)}`
    );
  }

  // ── Signal B: Actual BTC dominance threshold ─────────────────────────────
  if (domData.length > 0) {
    const domValues = domData.map(d => d.dominance);
    const domMin    = Math.min(...domValues), domMax = Math.max(...domValues);
    const domMean   = domValues.reduce((a, b) => a + b, 0) / domValues.length;
    console.log(`\n── Signal B: BTC Dominance % threshold (dom range: ${domMin.toFixed(1)}%–${domMax.toFixed(1)}%, avg ${domMean.toFixed(1)}%) ──`);
    console.log(`${"Threshold".padEnd(12)} ${"FinalBTC".padStart(10)} ${"Gain%".padStart(8)} ${"Switches".padStart(9)}  Meaning`);
    console.log("─".repeat(65));

    const solBtcMap = new Map(solBtc.map(c => [c.time, c.close]));
    const thresholds = [45, 50, 52, 54, 56, 58, 60, 62];

    for (const t of thresholds) {
      const r   = runDomThreshold(domData, solBtcMap, t);
      const meaning = t < domMean ? "mostly in BTC" : "mostly in SOL";
      console.log(
        `dom < ${t}%`.padEnd(12) +
        ` ${r.finalBtc.toFixed(6).padStart(10)}` +
        ` ${`${r.gainPct >= 0 ? "+" : ""}${r.gainPct.toFixed(1)}%`.padStart(8)}` +
        ` ${String(r.switches).padStart(9)}  ${meaning}`
      );
    }
  } else {
    console.log("\n[CoinGecko dominance data not available — skipping Signal B]");
  }

  // ── Forward return: what happens after dominance extremes? ───────────────
  if (domData.length > 0) {
    console.log("\n── What happens to SOL/BTC after BTC dominance extremes? ──");
    console.log(`${"Signal".padEnd(22)} ${"N".padStart(4)} ${"Avg+7d(SOLBTC)".padStart(16)} ${"Avg+30d(SOLBTC)".padStart(17)}`);
    console.log("─".repeat(62));

    const solBtcDailyMap = new Map<number, number>();
    for (const d of domData) {
      const sp = [...solMap.keys()].reduce((a, b) => Math.abs(b - d.time) < Math.abs(a - d.time) ? b : a);
      solBtcDailyMap.set(d.time, solMap.get(sp) ?? 0);
    }

    for (const [label, filter] of [
      ["High dom >60% (BTC season)", (v: number) => v > 60],
      ["High dom >55%",              (v: number) => v > 55],
      ["Low dom <50% (alt season)",  (v: number) => v < 50],
      ["Low dom <48%",               (v: number) => v < 48],
    ] as [string, (v: number) => boolean][]) {
      const fwd7: number[] = [], fwd30: number[] = [];
      for (let i = 0; i < domData.length - 30; i++) {
        if (!filter(domData[i].dominance)) continue;
        const p0  = solBtcDailyMap.get(domData[i].time);
        const p7  = solBtcDailyMap.get(domData[i + 7]?.time);
        const p30 = solBtcDailyMap.get(domData[i + 30]?.time);
        if (p0 && p7)  fwd7.push((p7  - p0) / p0 * 100);
        if (p0 && p30) fwd30.push((p30 - p0) / p0 * 100);
      }
      const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      console.log(
        label.padEnd(22) +
        ` ${String(fwd30.length).padStart(4)}` +
        ` ${`${avg(fwd7) >= 0 ? "+" : ""}${avg(fwd7).toFixed(2)}%`.padStart(16)}` +
        ` ${`${avg(fwd30) >= 0 ? "+" : ""}${avg(fwd30).toFixed(2)}%`.padStart(17)}`
      );
    }
  }
}

main().catch(console.error);
