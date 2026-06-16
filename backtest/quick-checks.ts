// Quick checks: (1) funding-rate APY for cash-and-carry, (2) dead-pair spread snapshot on Binance.US
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

(async () => {
  // ── 1) Funding rates (try fapi; may be geo-blocked for US IPs) ──
  console.log("\n── CASH-AND-CARRY: BTC perp funding, last 1000 periods (8h each ≈ 333 days) ──");
  try {
    const res = await fetch("https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1000");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json() as any;
    if (!Array.isArray(raw)) throw new Error(JSON.stringify(raw).slice(0, 200));
    const rates = raw.map((r: any) => parseFloat(r.fundingRate));
    const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
    const pos = rates.filter(r => r > 0).length;
    const apy = avg * 3 * 365 * 100;
    console.log(`  Periods: ${rates.length} | avg ${ (avg * 100).toFixed(4)}%/8h | positive ${ (pos / rates.length * 100).toFixed(1)}% of periods`);
    console.log(`  Implied cash-and-carry APY (spot long + perp short): ${apy.toFixed(1)}%`);
  } catch (e: any) {
    console.log(`  BLOCKED/FAILED: ${e.message}`);
  }

  // ── 2) Spread snapshot on all Binance.US pairs ──
  console.log("\n── DEAD-PAIR MM: widest bid/ask spreads on Binance.US right now ──");
  const res2 = await fetch("https://api.binance.us/api/v3/ticker/bookTicker");
  const book = await res2.json() as any[];
  const rows = book
    .map(b => ({
      symbol: b.symbol,
      bid: parseFloat(b.bidPrice), ask: parseFloat(b.askPrice),
      bidQty: parseFloat(b.bidQty), askQty: parseFloat(b.askQty),
    }))
    .filter(b => b.bid > 0 && b.ask > 0 && (b.symbol.endsWith("USDT") || b.symbol.endsWith("USD")))
    .map(b => ({ ...b, spreadPct: (b.ask - b.bid) / b.bid * 100 }))
    .sort((a, b) => b.spreadPct - a.spreadPct);

  console.log("  Symbol          Bid          Ask        Spread%   BidQty       AskQty");
  console.log("  " + "─".repeat(76));
  for (const r of rows.slice(0, 20)) {
    console.log(
      `  ${r.symbol}`.padEnd(14) +
      `${r.bid}`.padStart(12) +
      `${r.ask}`.padStart(13) +
      `${r.spreadPct.toFixed(2)}%`.padStart(10) +
      `${r.bidQty}`.padStart(13) +
      `${r.askQty}`.padStart(13)
    );
  }
  console.log(`\n  Pairs with spread > 0.5%: ${rows.filter(r => r.spreadPct > 0.5).length} of ${rows.length}`);
  console.log(`  Median spread: ${rows[Math.floor(rows.length / 2)].spreadPct.toFixed(3)}%\n`);
})();
