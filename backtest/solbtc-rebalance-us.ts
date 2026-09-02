// New strategy family for SOLBTC: mean-reversion rebalancing instead of RSI/EMA momentum.
// Tracks a rolling SMA of the SOLBTC ratio on 12h candles. Buy SOL when price drops X% below
// the SMA (band), sell back to BTC when price rises X% above the SMA. No direction
// prediction — mechanically captures ratio volatility to grow coin count either way.
// BTC-denominated, continuous ~5yr. Read-only, does not touch live bots.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE       = "https://api.binance.us/api/v3";
const LOOKBACK   = 365 * 24 * 60 * 60 * 1000;
const ALLOCATION_USD = 50;

type C = { t: number; c: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
async function fetchKlines(symbol: string, interval: string, startMs: number, endMs: number): Promise<C[]> {
  const out: C[] = []; let from = startMs;
  while (from < endMs) {
    const res = await fetch(`${BASE}/klines?symbol=${symbol}&interval=${interval}&startTime=${from}&endTime=${endMs}&limit=1000`);
    if (res.status === 429) { await sleep(5000); continue; }
    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) out.push({ t: +c[0], c: +c[4] });
    from = +raw[raw.length - 1][0] + 1;
    await sleep(80);
  }
  return out;
}
function calcSMA(candles: C[], period: number): number[] {
  const out: number[] = new Array(candles.length).fill(NaN);
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0; for (let j = i - period + 1; j <= i; j++) sum += candles[j].c;
    out[i] = sum / period;
  }
  return out;
}
function btcUsdAt(btcUsd: C[], t: number): number {
  let lo = 0, hi = btcUsd.length - 1, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (btcUsd[mid].t <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  return idx >= 0 ? btcUsd[idx].c : btcUsd[0].c;
}

function runSim(c12h: C[], btcUsd: C[], smaPeriod: number, bandPct: number, label: string) {
  const sma = calcSMA(c12h, smaPeriod);

  const startBtc = ALLOCATION_USD / btcUsdAt(btcUsd, c12h[0].t);
  let btc = startBtc, solQty = 0;
  let mode: "BTC" | "SOL" = "BTC";
  let entryPrice = 0;
  let trades = 0, wins = 0;
  let peakUsd = ALLOCATION_USD, maxDD = 0;

  for (let i = 0; i < c12h.length; i++) {
    if (isNaN(sma[i])) continue;
    const price = c12h[i].c, t = c12h[i].t;
    const usdPx = btcUsdAt(btcUsd, t);
    const lowerBand = sma[i] * (1 - bandPct / 100);
    const upperBand = sma[i] * (1 + bandPct / 100);

    if (mode === "BTC" && price <= lowerBand) {
      entryPrice = price;
      solQty = btc / price; btc = 0; mode = "SOL";
    } else if (mode === "SOL" && price >= upperBand) {
      btc = solQty * price;
      trades++;
      if (price > entryPrice) wins++;
      solQty = 0; mode = "BTC";
    }

    const eq = mode === "SOL" ? solQty * price * usdPx : btc * usdPx;
    if (eq > peakUsd) peakUsd = eq;
    const dd = (peakUsd - eq) / peakUsd * 100;
    if (dd > maxDD) maxDD = dd;
  }

  const lastUsdPx = btcUsdAt(btcUsd, c12h[c12h.length-1].t);
  const finalBtc = mode === "SOL" ? solQty * c12h[c12h.length-1].c : btc;
  const finalUsd = finalBtc * lastUsdPx;
  const btcAccumRet = (finalBtc - startBtc) / startBtc * 100;
  const wr = trades > 0 ? (wins/trades*100).toFixed(1) : "-";

  console.log(`${label.padEnd(30)}${(btcAccumRet>=0?"+":"")+btcAccumRet.toFixed(1).padStart(8)}%   $${finalUsd.toFixed(2).padStart(8)}   trades=${String(trades).padStart(3)}   WR=${wr}%   maxDD=${maxDD.toFixed(1)}%`);
}

(async () => {
  const now = Date.now(), start = now - 5 * LOOKBACK;
  process.stdout.write(`Fetching SOLBTC 12h... `); const c12h = await fetchKlines("SOLBTC", "12h", start, now); console.log(`${c12h.length}`);
  process.stdout.write(`Fetching BTCUSDT 1h... `); const btcUsd = await fetchKlines("BTCUSDT", "1h", start, now); console.log(`${btcUsd.length}`);

  console.log(`\nSOLBTC · continuous ~5yr · mean-reversion rebalancing (BTC-denominated)\n`);

  runSim(c12h, btcUsd, 20, 10, `SMA20, band 10%`);
  runSim(c12h, btcUsd, 20, 15, `SMA20, band 15%`);
  runSim(c12h, btcUsd, 20, 20, `SMA20, band 20%`);
  runSim(c12h, btcUsd, 40, 10, `SMA40, band 10%`);
  runSim(c12h, btcUsd, 40, 15, `SMA40, band 15%`);
  runSim(c12h, btcUsd, 40, 20, `SMA40, band 20%`);
  runSim(c12h, btcUsd, 60, 15, `SMA60, band 15%`);
  runSim(c12h, btcUsd, 60, 20, `SMA60, band 20%`);
})();
