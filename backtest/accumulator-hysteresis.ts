/**
 * Accumulator Hysteresis Backtest
 * Tests BB(10) on BTCUSDT with symmetric dead-zone thresholds
 *
 * Current bot: switch whenever close crosses the 10-period MA
 * With hysteresis: only switch when close moves k standard deviations
 *   beyond the MA — avoids whipsawing near the midpoint
 *
 * Switch TO SOL: close > mean + k*std
 * Switch TO BTC: close < mean - k*std
 * Dead zone:     |close - mean| < k*std → hold whatever you have
 *
 * Run: npx ts-node --transpile-only backtest/accumulator-hysteresis.ts
 */

const BINANCE_BASE = "https://api.binance.us/api/v3";
const BINANCE_KEY  = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS  = 365 * 24 * 60 * 60 * 1000;
const START_BTC    = 0.013557;
const BB_PERIOD    = 10;

const K_VALUES = [0, 0.1, 0.2, 0.3, 0.5, 0.75, 1.0, 1.5];

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAllKlines(symbol: string, interval: string, startMs: number, endMs: number) {
  const candles: { time: number; close: number }[] = [];
  let from = startMs;
  while (from < endMs) {
    const url = `${BINANCE_BASE}/klines?symbol=${symbol}&interval=${interval}` +
                `&startTime=${from}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url, { headers: { "X-MBX-APIKEY": BINANCE_KEY } });
    if (res.status === 429) { await sleep(10_000); continue; }
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const raw = await res.json() as string[][];
    if (!raw.length) break;
    for (const c of raw) candles.push({ time: Number(c[0]), close: parseFloat(c[4]) });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(120);
  }
  return candles;
}

function runWithHysteresis(
  btcCloses: number[],
  solBtcPrices: number[],
  k: number
): { finalBtc: number; gainPct: number; switches: number } {
  let holding: "BTC" | "SOL" = "BTC";
  let quantity = START_BTC;
  let switches = 0;

  for (let i = BB_PERIOD; i < btcCloses.length; i++) {
    const window = btcCloses.slice(i - BB_PERIOD + 1, i + 1);
    const mean   = window.reduce((a, b) => a + b, 0) / BB_PERIOD;
    const std    = Math.sqrt(window.reduce((a, b) => a + (b - mean) ** 2, 0) / BB_PERIOD);
    const close  = btcCloses[i];

    let target: "BTC" | "SOL" = holding; // default: hold current
    if (close > mean + k * std) target = "SOL";
    else if (close < mean - k * std) target = "BTC";

    if (target !== holding) {
      const solBtc = solBtcPrices[i];
      quantity = holding === "BTC"
        ? quantity / solBtc   // BTC → SOL
        : quantity * solBtc;  // SOL → BTC
      holding = target;
      switches++;
    }
  }

  const finalBtc = holding === "BTC"
    ? quantity
    : quantity * solBtcPrices[solBtcPrices.length - 1];

  return { finalBtc, gainPct: (finalBtc - START_BTC) / START_BTC * 100, switches };
}

async function main() {
  const now = Date.now(), startMs = now - LOOKBACK_MS;

  process.stdout.write("Fetching 5m data (1 year)...\n");
  const btcCandles    = await fetchAllKlines("BTCUSDT", "5m", startMs, now);
  process.stdout.write(`  BTCUSDT: ${btcCandles.length} candles\n`);
  const solBtcCandles = await fetchAllKlines("SOLBTC",  "5m", startMs, now);
  process.stdout.write(`  SOLBTC:  ${solBtcCandles.length} candles\n\n`);

  // Align by timestamp
  const solMap = new Map(solBtcCandles.map(c => [c.time, c.close]));
  const btcArr: number[] = [], solBtcArr: number[] = [];
  for (const c of btcCandles) {
    const sp = solMap.get(c.time);
    if (sp !== undefined) { btcArr.push(c.close); solBtcArr.push(sp); }
  }
  process.stdout.write(`  Aligned: ${btcArr.length} candles (~${(btcArr.length * 5 / 60 / 24).toFixed(0)} days)\n\n`);

  // Baselines
  const holdBtcFinal = START_BTC;
  const holdSolFinal = (START_BTC / solBtcArr[0]) * solBtcArr[solBtcArr.length - 1];
  const holdSolGain  = (holdSolFinal - START_BTC) / START_BTC * 100;

  console.log(`Baselines:`);
  console.log(`  Hold BTC:  ${holdBtcFinal.toFixed(6)} BTC  (+0.00%)`);
  console.log(`  Hold SOL:  ${holdSolFinal.toFixed(6)} BTC  (${holdSolGain >= 0 ? "+" : ""}${holdSolGain.toFixed(2)}%)\n`);

  console.log(
    `${"k".padEnd(6)} ${"Description".padEnd(24)} ${"FinalBTC".padStart(12)} ${"Gain%".padStart(9)} ${"Switches".padStart(10)} ${"Switches/day".padStart(13)}`
  );
  console.log("─".repeat(80));

  const days = btcArr.length * 5 / 60 / 24;

  for (const k of K_VALUES) {
    const { finalBtc, gainPct, switches } = runWithHysteresis(btcArr, solBtcArr, k);
    const switchesPerDay = switches / days;
    const desc = k === 0 ? "current (no buffer)" : `dead zone ±${k}σ`;

    console.log(
      `${String(k).padEnd(6)} ` +
      `${desc.padEnd(24)} ` +
      `${finalBtc.toFixed(6).padStart(12)} ` +
      `${`${gainPct >= 0 ? "+" : ""}${gainPct.toFixed(2)}%`.padStart(9)} ` +
      `${String(switches).padStart(10)} ` +
      `${switchesPerDay.toFixed(1).padStart(13)}`
    );
  }

  console.log("─".repeat(80));
  console.log(`\nBB period: ${BB_PERIOD} | Signal: BTCUSDT 5m | Dead zone: hold current when |close-mean| < k*std`);
}

main().catch(console.error);
