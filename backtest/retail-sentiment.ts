/**
 * Opposite Retail Signal Backtest
 * Uses Binance futures long/short ratio as a contrarian signal for spot trading.
 *
 * Signals tested:
 *   A) Global long/short ratio (retail traders) — fade them
 *   B) Top trader account ratio (smart money)  — follow them
 *
 * Strategy: hold BTC when bullish signal, hold USDT when bearish signal
 * Measures P&L in USD (not BTC accumulation)
 *
 * Data limit: Binance keeps ~500 data points of ratio history
 *   4h period → ~83 days | 1h period → ~21 days
 *
 * Run: npx ts-node --transpile-only backtest/retail-sentiment.ts
 */

const FAPI_BASE = "https://fapi.binance.com";   // futures API (ratio data, public)
const SPOT_BASE = "https://api.binance.us/api/v3"; // spot price
const BINANCE_KEY = process.env.BINANCE_API_KEY ?? "";
const ALLOCATION  = 1000; // starting USDT

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

interface RatioPoint { time: number; ratio: number }
interface PricePoint { time: number; close: number }

async function fetchLongShortRatio(endpoint: string, symbol: string, period: string): Promise<RatioPoint[]> {
  const url = `${FAPI_BASE}/futures/data/${endpoint}?symbol=${symbol}&period=${period}&limit=500`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FAPI ${endpoint} ${res.status}: ${await res.text()}`);
  const raw = await res.json() as { timestamp: number; longShortRatio: string }[];
  return raw.map(r => ({ time: r.timestamp, ratio: parseFloat(r.longShortRatio) }));
}

async function fetchKlines(symbol: string, interval: string, startMs: number, endMs: number): Promise<PricePoint[]> {
  const candles: PricePoint[] = [];
  let from = startMs;
  while (from < endMs) {
    const url = `${SPOT_BASE}/klines?symbol=${symbol}&interval=${interval}` +
                `&startTime=${from}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url, { headers: { "X-MBX-APIKEY": BINANCE_KEY } });
    if (res.status === 429) { await sleep(10_000); continue; }
    if (!res.ok) throw new Error(`Spot ${res.status}`);
    const raw = await res.json() as string[][];
    if (!raw.length) break;
    for (const c of raw) candles.push({ time: Number(c[0]), close: parseFloat(c[4]) });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(120);
  }
  return candles;
}

interface TradeResult {
  finalUsd: number;
  pnl: number;
  pnlPct: number;
  switches: number;
  timeInBtc: number; // fraction of time holding BTC
}

function runBacktest(
  ratios: RatioPoint[],
  prices: PricePoint[],
  buyBelowThresh: number,  // hold BTC when ratio < this
  sellAboveThresh: number, // hold USDT when ratio > this
  followSignal: boolean    // false = fade retail (contrarian), true = follow signal
): TradeResult {
  const priceMap = new Map(prices.map(p => [p.time, p.close]));

  let holding: "BTC" | "USDT" = "USDT";
  let quantity = ALLOCATION; // USDT
  let switches = 0;
  let candlesInBtc = 0;

  for (const { time, ratio } of ratios) {
    const price = priceMap.get(time);
    if (!price) continue;

    // Signal logic
    let wantBtc: boolean;
    if (followSignal) {
      // Follow top traders: high ratio (longs dominating) = bullish
      wantBtc = ratio > sellAboveThresh;
    } else {
      // Fade retail: high ratio = everyone long = contrarian sell
      // Low ratio = everyone short = contrarian buy
      wantBtc = ratio < buyBelowThresh;
    }

    const target = wantBtc ? "BTC" : "USDT";

    if (target !== holding) {
      if (target === "BTC") {
        quantity = quantity / price; // USDT → BTC
      } else {
        quantity = quantity * price; // BTC → USDT
      }
      holding = target;
      switches++;
    }

    if (holding === "BTC") candlesInBtc++;
  }

  // Final mark-to-market
  const lastPrice = prices[prices.length - 1].close;
  const finalUsd  = holding === "BTC" ? quantity * lastPrice : quantity;
  return {
    finalUsd,
    pnl:        finalUsd - ALLOCATION,
    pnlPct:     (finalUsd - ALLOCATION) / ALLOCATION * 100,
    switches,
    timeInBtc:  candlesInBtc / ratios.length,
  };
}

function printTable(
  label: string,
  ratios: RatioPoint[],
  prices: PricePoint[],
  thresholds: number[],
  followSignal: boolean
) {
  console.log(`\n── ${label} ──`);
  console.log(`${"Threshold".padEnd(12)} ${"Final($)".padStart(10)} ${"PnL%".padStart(8)} ${"Switches".padStart(9)} ${"Time in BTC".padStart(12)}`);
  console.log("─".repeat(55));

  for (const t of thresholds) {
    const r = runBacktest(ratios, prices, t, t, followSignal);
    const flag = r.pnlPct > 5 ? "✓" : r.pnlPct > 0 ? "~" : "✗";
    console.log(
      `ratio ${followSignal ? ">" : "<"} ${t.toFixed(2)}`.padEnd(12) +
      ` ${`$${r.finalUsd.toFixed(0)}`.padStart(10)}` +
      ` ${`${r.pnlPct >= 0 ? "+" : ""}${r.pnlPct.toFixed(1)}%`.padStart(8)}` +
      ` ${String(r.switches).padStart(9)}` +
      ` ${`${(r.timeInBtc * 100).toFixed(0)}%`.padStart(12)}` +
      `  ${flag}`
    );
  }
}

async function main() {
  console.log("\nOpposite Retail Signal Backtest — BTCUSDT");
  console.log("Contrarian: fade retail longs/shorts using Binance futures ratio\n");

  // Fetch ratio data (4h for max history ~83 days)
  process.stdout.write("Fetching global long/short ratio (4h)...");
  const globalRatio = await fetchLongShortRatio("globalLongShortAccountRatio", "BTCUSDT", "4h");
  process.stdout.write(` ${globalRatio.length} points\n`);

  process.stdout.write("Fetching top-trader account ratio (4h)...");
  const topAccRatio = await fetchLongShortRatio("topLongShortAccountRatio", "BTCUSDT", "4h");
  process.stdout.write(` ${topAccRatio.length} points\n`);

  process.stdout.write("Fetching top-trader position ratio (4h)...");
  const topPosRatio = await fetchLongShortRatio("topLongShortPositionRatio", "BTCUSDT", "4h");
  process.stdout.write(` ${topPosRatio.length} points\n`);

  // Date range
  const startMs = Math.min(...globalRatio.map(r => r.time));
  const endMs   = Math.max(...globalRatio.map(r => r.time));
  const days    = ((endMs - startMs) / 86_400_000).toFixed(0);
  console.log(`\nDate range: ${new Date(startMs).toISOString().slice(0,10)} → ${new Date(endMs).toISOString().slice(0,10)} (${days} days)\n`);

  // Fetch matching spot prices
  process.stdout.write("Fetching BTCUSDT spot price (4h)...");
  const prices = await fetchKlines("BTCUSDT", "4h", startMs, endMs + 3_600_000 * 4);
  process.stdout.write(` ${prices.length} candles\n`);

  // Buy-and-hold baseline
  const firstPrice = prices[0]?.close ?? 1;
  const lastPrice  = prices[prices.length - 1]?.close ?? 1;
  const holdBtcPct = (lastPrice - firstPrice) / firstPrice * 100;
  const holdBtcUsd = ALLOCATION * (lastPrice / firstPrice);
  console.log(`\nBaselines over ${days} days:`);
  console.log(`  Hold BTC:  $${holdBtcUsd.toFixed(0)}  (${holdBtcPct >= 0 ? "+" : ""}${holdBtcPct.toFixed(1)}%)`);
  console.log(`  Hold USDT: $${ALLOCATION}  (+0.0%)`);

  // Ratio stats
  const gRatios = globalRatio.map(r => r.ratio);
  const gMean   = gRatios.reduce((a, b) => a + b, 0) / gRatios.length;
  const gMin    = Math.min(...gRatios), gMax = Math.max(...gRatios);
  console.log(`\nGlobal L/S ratio stats: min=${gMin.toFixed(2)} mean=${gMean.toFixed(2)} max=${gMax.toFixed(2)}`);

  const tRatios = topAccRatio.map(r => r.ratio);
  const tMean   = tRatios.reduce((a, b) => a + b, 0) / tRatios.length;
  const tMin    = Math.min(...tRatios), tMax = Math.max(...tRatios);
  console.log(`Top-trader L/S ratio stats: min=${tMin.toFixed(2)} mean=${tMean.toFixed(2)} max=${tMax.toFixed(2)}`);

  const thresholds = [0.85, 0.90, 0.95, 1.00, 1.05, 1.10, 1.20];

  // Strategy A: Fade retail (global ratio)
  printTable("Strategy A: Fade Retail — hold BTC when global ratio is LOW (everyone short)", globalRatio, prices, thresholds, false);

  // Strategy B: Follow top traders (top account ratio)
  printTable("Strategy B: Follow Smart Money — hold BTC when top-trader ratio is HIGH (they're long)", topAccRatio, prices, thresholds, true);

  // Strategy C: Follow top position ratio
  printTable("Strategy C: Follow Top Position — hold BTC when top-position ratio is HIGH", topPosRatio, prices, thresholds, true);

  // Also test 1h data for finer resolution
  process.stdout.write("\nFetching global L/S ratio (1h) for finer resolution...");
  const globalRatio1h = await fetchLongShortRatio("globalLongShortAccountRatio", "BTCUSDT", "1h");
  process.stdout.write(` ${globalRatio1h.length} points\n`);
  const startMs1h = Math.min(...globalRatio1h.map(r => r.time));
  const endMs1h   = Math.max(...globalRatio1h.map(r => r.time));
  const prices1h  = await fetchKlines("BTCUSDT", "1h", startMs1h, endMs1h + 3_600_000);
  process.stdout.write(`Fetching BTCUSDT spot price (1h)... ${prices1h.length} candles\n`);

  printTable("Strategy A (1h resolution): Fade Retail", globalRatio1h, prices1h, thresholds, false);
}

main().catch(console.error);
