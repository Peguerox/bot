/**
 * Fear & Greed Contrarian Backtest
 * Uses the Crypto Fear & Greed Index (Alternative.me) as a contrarian signal.
 *
 * Contrarian logic:
 *   Extreme Fear  (low value)  → everyone panicking → BUY BTC
 *   Extreme Greed (high value) → everyone euphoric  → SELL to USDT
 *
 * Also tests "follow the trend" (non-contrarian) for comparison.
 * Data: daily, up to 3 years of history, free, no key needed.
 *
 * Run: npx ts-node --transpile-only backtest/fear-greed.ts
 */

const SPOT_BASE   = "https://api.binance.us/api/v3";
const FNG_URL     = "https://api.alternative.me/fng/?limit=1100&format=json";
const BINANCE_KEY = process.env.BINANCE_API_KEY ?? "";
const ALLOCATION  = 1000; // starting USDT

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

interface FngPoint { date: string; value: number; classification: string }
interface PricePoint { time: number; close: number }

async function fetchFng(): Promise<FngPoint[]> {
  const res = await fetch(FNG_URL);
  if (!res.ok) throw new Error(`FNG API ${res.status}`);
  const json = await res.json() as { data: { value: string; value_classification: string; timestamp: string }[] };
  return json.data.map(d => ({
    date:           new Date(Number(d.timestamp) * 1000).toISOString().slice(0, 10),
    value:          parseInt(d.value),
    classification: d.value_classification,
  })).reverse(); // API returns newest first, reverse to chronological
}

async function fetchDailyPrices(startMs: number, endMs: number): Promise<PricePoint[]> {
  const candles: PricePoint[] = [];
  let from = startMs;
  while (from < endMs) {
    const url = `${SPOT_BASE}/klines?symbol=BTCUSDT&interval=1d` +
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

interface SimResult {
  finalUsd:  number;
  pnlPct:    number;
  switches:  number;
  timeInBtc: number;
}

function runSim(
  fng:        FngPoint[],
  priceMap:   Map<string, number>,
  buyBelow:   number,  // buy BTC when FNG < this
  sellAbove:  number,  // sell BTC when FNG > this
): SimResult {
  let holding: "BTC" | "USDT" = "USDT";
  let quantity  = ALLOCATION;
  let switches  = 0;
  let daysInBtc = 0;
  let total     = 0;

  for (const { date, value } of fng) {
    const price = priceMap.get(date);
    if (!price) continue;
    total++;

    const target: "BTC" | "USDT" = value < buyBelow ? "BTC" : value > sellAbove ? "USDT" : holding;

    if (target !== holding) {
      quantity = target === "BTC" ? quantity / price : quantity * price;
      holding  = target;
      switches++;
    }
    if (holding === "BTC") daysInBtc++;
  }

  const lastPrice = [...priceMap.values()].at(-1) ?? 1;
  const finalUsd  = holding === "BTC" ? quantity * lastPrice : quantity;
  return {
    finalUsd,
    pnlPct:    (finalUsd - ALLOCATION) / ALLOCATION * 100,
    switches,
    timeInBtc: total > 0 ? daysInBtc / total : 0,
  };
}

async function main() {
  console.log("\nFear & Greed Contrarian Backtest — BTCUSDT daily\n");

  process.stdout.write("Fetching Fear & Greed Index...");
  const fng = await fetchFng();
  process.stdout.write(` ${fng.length} days\n`);

  const startDate = fng[0].date;
  const endDate   = fng[fng.length - 1].date;
  const startMs   = new Date(startDate).getTime();
  const endMs     = new Date(endDate).getTime() + 86_400_000;
  const days      = Math.round((endMs - startMs) / 86_400_000);
  console.log(`Date range: ${startDate} → ${endDate} (${days} days)\n`);

  process.stdout.write("Fetching BTCUSDT daily prices...");
  const prices  = await fetchDailyPrices(startMs, endMs);
  process.stdout.write(` ${prices.length} candles\n\n`);

  // Build date-keyed price map
  const priceMap = new Map(prices.map(p => [new Date(p.time).toISOString().slice(0, 10), p.close]));

  // Baselines
  const firstPrice = prices[0].close;
  const lastPrice  = prices[prices.length - 1].close;
  const holdBtcUsd = ALLOCATION * (lastPrice / firstPrice);
  const holdBtcPct = (holdBtcUsd - ALLOCATION) / ALLOCATION * 100;
  console.log(`Baselines:`);
  console.log(`  Hold BTC  always: $${holdBtcUsd.toFixed(0).padStart(7)}  (${holdBtcPct >= 0 ? "+" : ""}${holdBtcPct.toFixed(1)}%)`);
  console.log(`  Hold USDT always: $${ALLOCATION.toFixed(0).padStart(7)}  (+0.0%)\n`);

  // FNG distribution
  const values = fng.map(f => f.value);
  const mean   = values.reduce((a, b) => a + b, 0) / values.length;
  const exFear  = values.filter(v => v < 25).length;
  const fear    = values.filter(v => v >= 25 && v < 45).length;
  const neutral = values.filter(v => v >= 45 && v < 55).length;
  const greed   = values.filter(v => v >= 55 && v < 75).length;
  const exGreed = values.filter(v => v >= 75).length;
  console.log(`FNG distribution (avg=${mean.toFixed(0)}):`);
  console.log(`  Extreme Fear (<25): ${exFear}d  Fear (25-44): ${fear}d  Neutral (45-54): ${neutral}d  Greed (55-74): ${greed}d  Extreme Greed (75+): ${exGreed}d\n`);

  // Grid: test combinations of buyBelow and sellAbove thresholds
  const buyThresholds  = [20, 25, 30, 35, 40];
  const sellThresholds = [60, 65, 70, 75, 80];

  console.log("── Grid: Buy when FNG < X, Sell when FNG > Y ──");
  console.log(`${"Buy<".padEnd(6)} ${"Sell>".padEnd(6)} ${"Final($)".padStart(10)} ${"PnL%".padStart(8)} ${"Switches".padStart(9)} ${"InBTC".padStart(7)}  vs Hold`);
  console.log("─".repeat(60));

  let bestPnl = -Infinity, bestBuy = 0, bestSell = 0;

  for (const buy of buyThresholds) {
    for (const sell of sellThresholds) {
      if (buy >= sell) continue;
      const r    = runSim(fng, priceMap, buy, sell);
      const diff = r.pnlPct - holdBtcPct;
      const flag = diff > 5 ? "✓✓ Beats BTC" : diff > 0 ? "✓ Beats BTC" : diff > -10 ? "~" : "✗";
      if (r.pnlPct > bestPnl) { bestPnl = r.pnlPct; bestBuy = buy; bestSell = sell; }
      console.log(
        `${`<${buy}`.padEnd(6)} ${`>${sell}`.padEnd(6)}` +
        ` ${`$${r.finalUsd.toFixed(0)}`.padStart(10)}` +
        ` ${`${r.pnlPct >= 0 ? "+" : ""}${r.pnlPct.toFixed(1)}%`.padStart(8)}` +
        ` ${String(r.switches).padStart(9)}` +
        ` ${`${(r.timeInBtc * 100).toFixed(0)}%`.padStart(7)}` +
        `  ${flag}`
      );
    }
  }

  console.log("─".repeat(60));
  console.log(`\n★ Best combo: buy < ${bestBuy}, sell > ${bestSell} → ${bestPnl >= 0 ? "+" : ""}${bestPnl.toFixed(1)}%`);

  // Non-contrarian (trend follow): buy when greed, sell when fear
  console.log("\n── Trend Follow (non-contrarian) for comparison ──");
  console.log(`${"Buy>".padEnd(6)} ${"Sell<".padEnd(6)} ${"Final($)".padStart(10)} ${"PnL%".padStart(8)} ${"Switches".padStart(9)} ${"InBTC".padStart(7)}`);
  console.log("─".repeat(50));

  for (const buy of sellThresholds) {
    const sell = 100 - buy + sellThresholds[0]; // symmetrical
    const r = runSim(fng, priceMap, 101, buy); // buy when FNG > buy threshold (never sell based on low)
    console.log(
      `${`>${buy}`.padEnd(6)} ${"—".padEnd(6)}` +
      ` ${`$${r.finalUsd.toFixed(0)}`.padStart(10)}` +
      ` ${`${r.pnlPct >= 0 ? "+" : ""}${r.pnlPct.toFixed(1)}%`.padStart(8)}` +
      ` ${String(r.switches).padStart(9)}` +
      ` ${`${(r.timeInBtc * 100).toFixed(0)}%`.padStart(7)}`
    );
  }

  // Best window analysis: what happens to BTC price after extreme readings?
  console.log("\n── What happens to BTC price 7/14/30 days after extreme FNG? ──");
  console.log(`${"Signal".padEnd(18)} ${"N".padStart(4)} ${"Avg+7d".padStart(8)} ${"Avg+14d".padStart(9)} ${"Avg+30d".padStart(9)} ${"% up 30d".padStart(10)}`);
  console.log("─".repeat(65));

  for (const [label, filter] of [
    ["Extreme Fear (<20)", (v: number) => v < 20],
    ["Fear (<30)",         (v: number) => v < 30],
    ["Neutral (45-55)",   (v: number) => v >= 45 && v <= 55],
    ["Greed (>70)",       (v: number) => v > 70],
    ["Extreme Greed(>80)",(v: number) => v > 80],
  ] as [string, (v: number) => boolean][]) {
    const fwd7: number[] = [], fwd14: number[] = [], fwd30: number[] = [];
    for (let i = 0; i < fng.length - 30; i++) {
      if (!filter(fng[i].value)) continue;
      const p0  = priceMap.get(fng[i].date);
      const p7  = priceMap.get(fng[i + 7]?.date);
      const p14 = priceMap.get(fng[i + 14]?.date);
      const p30 = priceMap.get(fng[i + 30]?.date);
      if (p0 && p7)  fwd7.push((p7  - p0) / p0 * 100);
      if (p0 && p14) fwd14.push((p14 - p0) / p0 * 100);
      if (p0 && p30) fwd30.push((p30 - p0) / p0 * 100);
    }
    const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const pctUp30 = fwd30.length ? fwd30.filter(v => v > 0).length / fwd30.length * 100 : 0;
    console.log(
      label.padEnd(18) +
      ` ${String(fwd30.length).padStart(4)}` +
      ` ${`${avg(fwd7) >= 0 ? "+" : ""}${avg(fwd7).toFixed(1)}%`.padStart(8)}` +
      ` ${`${avg(fwd14) >= 0 ? "+" : ""}${avg(fwd14).toFixed(1)}%`.padStart(9)}` +
      ` ${`${avg(fwd30) >= 0 ? "+" : ""}${avg(fwd30).toFixed(1)}%`.padStart(9)}` +
      ` ${`${pctUp30.toFixed(0)}%`.padStart(10)}`
    );
  }
}

main().catch(console.error);
