/**
 * Accumulator Signal Comparison
 * Compares two signals for the BTC/SOL accumulator:
 *   A) BB(N) on BTCUSDT  — current bot logic
 *   B) BB(N) on SOLBTC   — direct ratio signal
 *
 * Signal A: if BTC/USD > N-period MA → uptrend → hold SOL
 * Signal B: if SOL/BTC > N-period MA → SOL outperforming → hold SOL
 *
 * Run: npx ts-node --transpile-only backtest/accumulator-signal-compare.ts
 */

const BINANCE_BASE = "https://api.binance.us/api/v3";
const BINANCE_KEY  = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS  = 365 * 24 * 60 * 60 * 1000; // 1 year
const START_BTC    = 0.013557;

const BB_PERIODS   = [5, 10, 20, 30];

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

function runAccumulator(
  signalCloses: number[],   // the series BB is applied to
  solBtcPrices: number[],   // SOL/BTC price at each aligned candle
  period: number,
  signalAboveMeanHoldSol: boolean // true for both A and B (above mean = hold SOL)
): { finalBtc: number; gainPct: number; switches: number } {
  let holding: "BTC" | "SOL" = "BTC";
  let quantity = START_BTC;
  let switches = 0;

  for (let i = period; i < signalCloses.length; i++) {
    const window = signalCloses.slice(i - period + 1, i + 1);
    const mean   = window.reduce((a, b) => a + b, 0) / period;
    const above  = signalCloses[i] > mean;
    const target: "BTC" | "SOL" = (above === signalAboveMeanHoldSol) ? "SOL" : "BTC";

    if (target !== holding) {
      const solBtc = solBtcPrices[i];
      if (holding === "BTC") {
        quantity = quantity / solBtc; // BTC → SOL
      } else {
        quantity = quantity * solBtc; // SOL → BTC
      }
      holding = target;
      switches++;
    }
  }

  const lastSolBtc = solBtcPrices[solBtcPrices.length - 1];
  const finalBtc   = holding === "BTC" ? quantity : quantity * lastSolBtc;
  return {
    finalBtc,
    gainPct: (finalBtc - START_BTC) / START_BTC * 100,
    switches,
  };
}

async function main() {
  const now = Date.now(), startMs = now - LOOKBACK_MS;

  process.stdout.write("Fetching 5m data (1 year)...\n");
  const btcCandles    = await fetchAllKlines("BTCUSDT", "5m", startMs, now);
  process.stdout.write(`  BTCUSDT: ${btcCandles.length} candles\n`);
  const solBtcCandles = await fetchAllKlines("SOLBTC",  "5m", startMs, now);
  process.stdout.write(`  SOLBTC:  ${solBtcCandles.length} candles\n\n`);

  // Align by time
  const solMap = new Map(solBtcCandles.map(c => [c.time, c.close]));
  const btcArr: number[] = [], solBtcArr: number[] = [];
  for (const c of btcCandles) {
    const sp = solMap.get(c.time);
    if (sp !== undefined) { btcArr.push(c.close); solBtcArr.push(sp); }
  }
  process.stdout.write(`  Aligned: ${btcArr.length} candles\n\n`);

  // Also build a "hold BTC always" and "hold SOL always" baseline
  const holdBtcFinal = START_BTC;
  const holdSolFinal = (START_BTC / solBtcArr[0]) * solBtcArr[solBtcArr.length - 1];
  const holdBtcGain  = 0;
  const holdSolGain  = (holdSolFinal - START_BTC) / START_BTC * 100;

  console.log(`Baselines (no switching):`);
  console.log(`  Hold BTC always: ${holdBtcFinal.toFixed(6)} BTC  (${holdBtcGain >= 0 ? "+" : ""}${holdBtcGain.toFixed(2)}%)`);
  console.log(`  Hold SOL always: ${holdSolFinal.toFixed(6)} BTC  (${holdSolGain >= 0 ? "+" : ""}${holdSolGain.toFixed(2)}%)\n`);

  // ── Grid: Signal A (BTCUSDT BB) vs Signal B (SOLBTC BB) ──────────────────
  const W = 10;
  const header = (label: string) => label.padEnd(W);

  console.log(
    `${"Period".padEnd(8)} ` +
    `${"── Signal A: BB on BTC/USD ──".padEnd(35)} ` +
    `${"── Signal B: BB on SOL/BTC ──".padEnd(35)}`
  );
  console.log(
    `${"".padEnd(8)} ` +
    `${"FinalBTC".padStart(10)} ${"Gain%".padStart(8)} ${"Switches".padStart(9)} ` +
    `${"".padStart(8)} ` +
    `${"FinalBTC".padStart(10)} ${"Gain%".padStart(8)} ${"Switches".padStart(9)}`
  );
  console.log("─".repeat(90));

  for (const period of BB_PERIODS) {
    const a = runAccumulator(btcArr,    solBtcArr, period, true);
    const b = runAccumulator(solBtcArr, solBtcArr, period, true);

    const winner = a.gainPct > b.gainPct ? "← A wins" : b.gainPct > a.gainPct ? "→ B wins" : "tie";

    console.log(
      `BB(${period})`.padEnd(8) +
      ` ${a.finalBtc.toFixed(6).padStart(10)} ${`${a.gainPct >= 0 ? "+" : ""}${a.gainPct.toFixed(1)}%`.padStart(8)} ${String(a.switches).padStart(9)}` +
      `    ` +
      `${b.finalBtc.toFixed(6).padStart(10)} ${`${b.gainPct >= 0 ? "+" : ""}${b.gainPct.toFixed(1)}%`.padStart(8)} ${String(b.switches).padStart(9)}` +
      `   ${winner}`
    );
  }

  console.log("─".repeat(90));
  console.log(`\nNote: Signal B "above mean" = SOL/BTC trending up = SOL outperforming BTC = hold SOL`);
  console.log(`      Signal A "above mean" = BTC/USD trending up = BTC bull market = hold SOL`);
}

main().catch(console.error);
