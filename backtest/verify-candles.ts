/**
 * Verify that Binance.US klines match candles built from raw tick data (aggTrades)
 * Checks the last 5 completed 1-minute candles for both BTC and ATOM
 *
 * Run: npx ts-node --transpile-only backtest/verify-candles.ts
 */

const BASE     = "https://api.binance.us/api/v3";
const API_KEY  = process.env.BINANCE_API_KEY ?? "";
const SYMBOLS  = ["BTCUSDT", "ATOMUSDT"];
const CANDLES  = 5; // how many completed candles to verify

async function fetchKlines(symbol: string, startMs: number, endMs: number) {
  const url = `${BASE}/klines?symbol=${symbol}&interval=1m&startTime=${startMs}&endTime=${endMs}&limit=${CANDLES}`;
  const res = await fetch(url, { headers: { "X-MBX-APIKEY": API_KEY } });
  if (!res.ok) throw new Error(`klines ${symbol}: ${res.status}`);
  const raw = await res.json() as string[][];
  return raw.map(c => ({
    openTime:  Number(c[0]),
    closeTime: Number(c[6]),
    open:      parseFloat(c[1]),
    high:      parseFloat(c[2]),
    low:       parseFloat(c[3]),
    close:     parseFloat(c[4]),
    volume:    parseFloat(c[5]),
  }));
}

async function fetchAggTrades(symbol: string, startMs: number, endMs: number) {
  const url = `${BASE}/aggTrades?symbol=${symbol}&startTime=${startMs}&endTime=${endMs}&limit=1000`;
  const res = await fetch(url, { headers: { "X-MBX-APIKEY": API_KEY } });
  if (!res.ok) throw new Error(`aggTrades ${symbol}: ${res.status}`);
  const raw = await res.json() as { T: number; p: string; q: string }[];
  return raw.map(t => ({
    time:  t.T,
    price: parseFloat(t.p),
    qty:   parseFloat(t.q),
  }));
}

function buildCandles(trades: { time: number; price: number; qty: number }[], startMs: number, count: number) {
  const candles = [];
  for (let i = 0; i < count; i++) {
    const open  = startMs + i * 60_000;
    const close = open + 59_999;
    const bucket = trades.filter(t => t.time >= open && t.time <= close);
    if (bucket.length === 0) continue;
    const prices = bucket.map(t => t.price);
    candles.push({
      openTime:  open,
      open:      bucket[0].price,
      high:      Math.max(...prices),
      low:       Math.min(...prices),
      close:     bucket[bucket.length - 1].price,
      volume:    bucket.reduce((s, t) => s + t.qty, 0),
    });
  }
  return candles;
}

function fmt(n: number, decimals = 4) { return n.toFixed(decimals); }
function diff(a: number, b: number)   { return Math.abs(a - b); }
function pct(a: number, b: number)    { return (Math.abs(a - b) / b * 100).toFixed(4); }

async function verify(symbol: string) {
  // Use candles from 10 minutes ago to ensure they're all completed
  const now      = Date.now();
  const endMs    = now - 2 * 60_000;                  // 2 min ago
  const startMs  = endMs - CANDLES * 60_000;          // 5 min before that

  console.log(`\n${"─".repeat(70)}`);
  console.log(`  ${symbol}  —  verifying ${CANDLES} candles`);
  console.log(`  Window: ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}`);
  console.log(`${"─".repeat(70)}`);

  const [klines, trades] = await Promise.all([
    fetchKlines(symbol, startMs, endMs),
    fetchAggTrades(symbol, startMs, endMs),
  ]);

  console.log(`  klines: ${klines.length} candles  |  aggTrades: ${trades.length} ticks`);

  const built = buildCandles(trades, startMs, CANDLES);

  if (klines.length === 0 || built.length === 0) {
    console.log("  ⚠ Not enough data to compare");
    return;
  }

  let allMatch = true;

  for (let i = 0; i < Math.min(klines.length, built.length); i++) {
    const k = klines[i];
    const b = built[i];
    const time = new Date(k.openTime).toISOString().slice(11, 19);

    const openDiff  = diff(k.open,  b.open);
    const highDiff  = diff(k.high,  b.high);
    const lowDiff   = diff(k.low,   b.low);
    const closeDiff = diff(k.close, b.close);

    const match = openDiff < 0.001 && highDiff < 0.001 && lowDiff < 0.001 && closeDiff < 0.001;
    if (!match) allMatch = false;

    const tag = match ? "✓" : "✗";
    console.log(`\n  [${time}] ${tag}`);
    console.log(`           Kline          Built-from-ticks    Diff`);
    console.log(`  open   ${fmt(k.open)}       ${fmt(b.open)}           ${pct(k.open,  b.open)}%`);
    console.log(`  high   ${fmt(k.high)}       ${fmt(b.high)}           ${pct(k.high,  b.high)}%`);
    console.log(`  low    ${fmt(k.low)}       ${fmt(b.low)}           ${pct(k.low,   b.low)}%`);
    console.log(`  close  ${fmt(k.close)}       ${fmt(b.close)}           ${pct(k.close, b.close)}%`);
    if (!match) console.log(`  *** MISMATCH DETECTED ***`);
  }

  console.log(`\n  Result: ${allMatch ? "ALL CANDLES MATCH ✓" : "MISMATCHES FOUND ✗"}`);
}

async function main() {
  console.log("\nVerifying Binance.US klines vs aggTrades-built candles...");
  for (const symbol of SYMBOLS) {
    await verify(symbol);
  }
  console.log("\nDone.\n");
}

main().catch(console.error);
