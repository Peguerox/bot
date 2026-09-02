// Extends the basket rotation to 15 established (non-meme) coins: BTC, ETH, SOL, BNB, XRP,
// ADA, AVAX, DOT, LINK, LTC, BCH, ATOM, UNI, ETC, ALGO. Same mechanism as the 3-coin version:
// rank by trailing N-day return, hold 100% of whichever ranks #1, rebalance every M days.
// Assets without enough history yet are excluded from ranking until they have it.
// BTC-denominated, continuous ~5yr. Read-only, does not touch live bots.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://api.binance.us/api/v3";
const ALLOCATION_USD = 50;
const COINS = ["BTC","ETH","SOL","BNB","XRP","ADA","AVAX","DOT","LINK","LTC","BCH","ATOM","UNI","ETC","ALGO"];

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
function priceAt(c: C[], t: number): number | null {
  if (!c.length || t < c[0].t) return null;
  let lo = 0, hi = c.length - 1, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (c[mid].t <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  return idx >= 0 ? c[idx].c : null;
}

function runSim(series: Record<string, C[]>, lookbackDays: number, rebalanceDays: number, label: string) {
  const btcSeries = series["BTC"];
  const startT = Math.max(...COINS.map(c => series[c][0]?.t ?? Infinity).filter(t => t < Infinity)) + lookbackDays * 86_400_000;
  const endT = btcSeries[btcSeries.length - 1].t;

  const startBtcPx = priceAt(btcSeries, startT)!;
  const startAlloc = ALLOCATION_USD / startBtcPx; // in BTC terms
  let holding = "BTC";
  let holdingQty = startAlloc;
  let switches = 0;
  let peak = ALLOCATION_USD, maxDD = 0;
  let lastRebalance = startT;

  function valueUsd(t: number): number {
    const px = priceAt(series[holding], t);
    return px !== null ? holdingQty * px : NaN;
  }

  let t = startT;
  while (t <= endT) {
    if (t - lastRebalance >= rebalanceDays * 86_400_000 || t === startT) {
      const rets: { name: string; ret: number }[] = [];
      for (const name of COINS) {
        const now_ = priceAt(series[name], t);
        const then = priceAt(series[name], t - lookbackDays * 86_400_000);
        if (now_ !== null && then !== null && then > 0) rets.push({ name, ret: (now_ - then) / then });
      }
      if (rets.length) {
        rets.sort((a, b) => b.ret - a.ret);
        const best = rets[0].name;
        if (best !== holding) {
          const usdVal = valueUsd(t);
          const newPx = priceAt(series[best], t);
          if (!isNaN(usdVal) && newPx !== null) {
            holding = best;
            holdingQty = usdVal / newPx;
            switches++;
          }
        }
      }
      lastRebalance = t;
    }

    const usdVal = valueUsd(t);
    if (!isNaN(usdVal)) {
      if (usdVal > peak) peak = usdVal;
      const dd = (peak - usdVal) / peak * 100;
      if (dd > maxDD) maxDD = dd;
    }
    t += 12 * 60 * 60 * 1000;
  }

  const finalUsd = valueUsd(endT);
  const finalBtcPx = priceAt(btcSeries, endT)!;
  const finalBtcEquiv = finalUsd / finalBtcPx;
  const btcRet = (finalBtcEquiv - startAlloc) / startAlloc * 100;
  console.log(`${label.padEnd(30)}${(btcRet>=0?"+":"")+btcRet.toFixed(1).padStart(9)}%   $${finalUsd.toFixed(2).padStart(9)}   switches=${switches}   maxDD=${maxDD.toFixed(1)}%   endHolding=${holding}`);
}

(async () => {
  const now = Date.now(), start = now - 5 * 365 * 24 * 60 * 60 * 1000 - 30 * 86_400_000;

  const series: Record<string, C[]> = {};
  for (const coin of COINS) {
    process.stdout.write(`Fetching ${coin}USDT 12h... `);
    series[coin] = await fetchKlines(`${coin}USDT`, "12h", start, now);
    console.log(`${series[coin].length}`);
  }

  console.log(`\n15-coin basket rotation · BTC-denominated · continuous ~5yr\n`);
  console.log(`[REFERENCE] current surfer SOLBTC (slope+trail)  +666.7%`);
  console.log(`[REFERENCE] 3-coin basket (BTC/SOL/ETH) 14d/7d    +744.5%`);
  runSim(series, 14, 7, `15-coin, lookback=14d, rebal=7d`);
  runSim(series, 15, 7, `15-coin, lookback=15d, rebal=7d`);
  runSim(series, 10, 5, `15-coin, lookback=10d, rebal=5d`);
  runSim(series, 20, 10, `15-coin, lookback=20d, rebal=10d`);
  runSim(series, 30, 14, `15-coin, lookback=30d, rebal=14d`);
})();
