// Cross-sectional momentum: rotate among {BTC, SOL, ETH} — hold whichever had the best
// trailing return over a lookback window, rebalance periodically. Different mechanism than
// the fixed SOL/BTC pair rotation (the surfer) — a 3-way relative-strength contest instead
// of a 2-way mean-reversion dip-buy. BTC-denominated (since that's the account's real unit),
// continuous ~5yr. Read-only, does not touch live bots.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://api.binance.us/api/v3";
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
function priceAt(c: C[], t: number): number {
  let lo = 0, hi = c.length - 1, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (c[mid].t <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  return idx >= 0 ? c[idx].c : c[0].c;
}
function priceNDaysBefore(c: C[], t: number, days: number): number {
  return priceAt(c, t - days * 86_400_000);
}

function runSim(btcUsd: C[], solUsd: C[], ethUsd: C[], lookbackDays: number, rebalanceDays: number, label: string) {
  const assets: { name: "BTC"|"SOL"|"ETH"; series: C[] }[] = [
    { name: "BTC", series: btcUsd }, { name: "SOL", series: solUsd }, { name: "ETH", series: ethUsd },
  ];

  const startT = btcUsd[0].t;
  const endT = btcUsd[btcUsd.length - 1].t;
  const startBtcPx = priceAt(btcUsd, startT);
  let btcEquiv = ALLOCATION_USD / startBtcPx; // track everything in BTC terms
  let holding: "BTC"|"SOL"|"ETH" = "BTC";
  let holdingQty = btcEquiv; // qty of whichever asset we hold
  let switches = 0;
  let peak = ALLOCATION_USD, maxDD = 0;

  let t = startT + lookbackDays * 86_400_000;
  let lastRebalance = t;

  // helper: value of current holding in USD at time t
  function valueUsd(t: number): number {
    const px = priceAt(holding === "BTC" ? btcUsd : holding === "SOL" ? solUsd : ethUsd, t);
    return holdingQty * px;
  }

  while (t <= endT) {
    if (t - lastRebalance >= rebalanceDays * 86_400_000 || t === startT + lookbackDays * 86_400_000) {
      // rank assets by trailing return
      const rets = assets.map(a => {
        const now_ = priceAt(a.series, t);
        const then = priceNDaysBefore(a.series, t, lookbackDays);
        return { name: a.name, ret: (now_ - then) / then };
      });
      rets.sort((a, b) => b.ret - a.ret);
      const best = rets[0].name;

      if (best !== holding) {
        // sell current holding -> USD -> buy best (approximate, ignoring fees)
        const usdVal = valueUsd(t);
        const newPx = priceAt(best === "BTC" ? btcUsd : best === "SOL" ? solUsd : ethUsd, t);
        holding = best;
        holdingQty = usdVal / newPx;
        switches++;
      }
      lastRebalance = t;
    }

    const usdVal = valueUsd(t);
    const btcPx = priceAt(btcUsd, t);
    const btcEquivNow = usdVal / btcPx;
    if (usdVal > peak) peak = usdVal;
    const dd = (peak - usdVal) / peak * 100;
    if (dd > maxDD) maxDD = dd;

    t += 12 * 60 * 60 * 1000; // step 12h
  }

  const finalUsd = valueUsd(endT);
  const finalBtcEquiv = finalUsd / priceAt(btcUsd, endT);
  const btcRet = (finalBtcEquiv - btcEquiv) / btcEquiv * 100;
  console.log(`${label.padEnd(36)}${(btcRet>=0?"+":"")+btcRet.toFixed(1).padStart(8)}%   $${finalUsd.toFixed(2).padStart(8)}   switches=${switches}   maxDD=${maxDD.toFixed(1)}%   endHolding=${holding}`);
}

(async () => {
  const now = Date.now(), start = now - 5 * 365 * 24 * 60 * 60 * 1000 - 90 * 86_400_000; // extra buffer for lookback
  process.stdout.write(`Fetching BTCUSDT 12h... `); const btcUsd = await fetchKlines("BTCUSDT", "12h", start, now); console.log(`${btcUsd.length}`);
  process.stdout.write(`Fetching SOLUSDT 12h... `); const solUsd = await fetchKlines("SOLUSDT", "12h", start, now); console.log(`${solUsd.length}`);
  process.stdout.write(`Fetching ETHUSDT 12h... `); const ethUsd = await fetchKlines("ETHUSDT", "12h", start, now); console.log(`${ethUsd.length}`);

  console.log(`\nBasket rotation {BTC,SOL,ETH} · BTC-denominated · continuous ~5yr\n`);
  console.log(`[REFERENCE] current surfer SOLBTC (slope+trail)  +666.7%`);
  runSim(btcUsd, solUsd, ethUsd, 1, 1, `lookback=1d, rebalance=1d`);
  runSim(btcUsd, solUsd, ethUsd, 2, 1, `lookback=2d, rebalance=1d`);
  runSim(btcUsd, solUsd, ethUsd, 2, 2, `lookback=2d, rebalance=2d`);
  runSim(btcUsd, solUsd, ethUsd, 3, 2, `lookback=3d, rebalance=2d`);
  runSim(btcUsd, solUsd, ethUsd, 4, 2, `lookback=4d, rebalance=2d`);
  runSim(btcUsd, solUsd, ethUsd, 5, 3, `lookback=5d, rebalance=3d`);
  runSim(btcUsd, solUsd, ethUsd, 15, 7, `lookback=15d, rebalance=7d [prior best]`);
})();
