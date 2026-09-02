// Clean, consistent basket rotation test — fixes the buffer/anchor bug from the prior two
// scripts. Simulation always starts exactly at (now - 5yr), using extra fetched history
// purely as lookback context (never as tradeable simulation time). Read-only.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://api.binance.us/api/v3";
const ALLOCATION_USD = 50;
const ONE_YEAR = 1 * 365 * 24 * 60 * 60 * 1000;
const FETCH_BUFFER = 30 * 86_400_000; // extra history fetched so lookback works from day 1 of the sim

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

function runSim(btcUsd: C[], solUsd: C[], ethUsd: C[], simStartT: number, endT: number, lookbackDays: number, rebalanceDays: number, label: string) {
  const assets = [{ name: "BTC", series: btcUsd }, { name: "SOL", series: solUsd }, { name: "ETH", series: ethUsd }];

  let holding: "BTC"|"SOL"|"ETH" = "BTC";
  let holdingQty = ALLOCATION_USD / priceAt(btcUsd, simStartT);
  const startBtcEquiv = holdingQty;
  let lastRebalance = simStartT, switches = 0;
  let peak = ALLOCATION_USD, maxDD = 0;

  function seriesFor(name: string): C[] { return name === "BTC" ? btcUsd : name === "SOL" ? solUsd : ethUsd; }
  function valueUsd(t: number): number { return holdingQty * priceAt(seriesFor(holding), t); }

  let t = simStartT;
  while (t <= endT) {
    if (t - lastRebalance >= rebalanceDays * 86_400_000 || t === simStartT) {
      const rets = assets.map(a => {
        const now_ = priceAt(a.series, t), then = priceAt(a.series, t - lookbackDays * 86_400_000);
        return { name: a.name, ret: (now_ - then) / then };
      });
      rets.sort((a, b) => b.ret - a.ret);
      const best = rets[0].name as "BTC"|"SOL"|"ETH";
      if (best !== holding) {
        const usdVal = valueUsd(t);
        holding = best;
        holdingQty = usdVal / priceAt(seriesFor(best), t);
        switches++;
      }
      lastRebalance = t;
    }
    const eqUsd = valueUsd(t);
    if (eqUsd > peak) peak = eqUsd;
    const dd = (peak - eqUsd) / peak * 100;
    if (dd > maxDD) maxDD = dd;
    t += 12 * 60 * 60 * 1000;
  }

  const finalUsd = valueUsd(endT);
  const finalBtcEquiv = finalUsd / priceAt(btcUsd, endT);
  const btcRet = (finalBtcEquiv - startBtcEquiv) / startBtcEquiv * 100;
  console.log(`${label.padEnd(20)}${(btcRet>=0?"+":"")+btcRet.toFixed(1).padStart(9)}%   $${finalUsd.toFixed(2).padStart(9)}   switches=${switches}   maxDD=${maxDD.toFixed(1)}%`);
}

(async () => {
  const now = Date.now();
  const simStart = now - ONE_YEAR;
  const fetchStart = simStart - FETCH_BUFFER;

  console.log(`Sim window: ${new Date(simStart).toISOString().slice(0,10)} -> ${new Date(now).toISOString().slice(0,10)} (exactly 1yr)\n`);

  process.stdout.write(`Fetching BTCUSDT 12h... `); const btcUsd = await fetchKlines("BTCUSDT", "12h", fetchStart, now); console.log(`${btcUsd.length}`);
  process.stdout.write(`Fetching SOLUSDT 12h... `); const solUsd = await fetchKlines("SOLUSDT", "12h", fetchStart, now); console.log(`${solUsd.length}`);
  process.stdout.write(`Fetching ETHUSDT 12h... `); const ethUsd = await fetchKlines("ETHUSDT", "12h", fetchStart, now); console.log(`${ethUsd.length}`);

  console.log(`\nBasket rotation {BTC,SOL,ETH} — 1yr parameter sweep\n`);
  for (const lb of [5, 7, 10, 14, 16, 20, 25, 30, 40, 50, 60]) {
    for (const rb of [lb <= 10 ? Math.max(2, Math.round(lb/2)) : Math.round(lb/2)]) {
      runSim(btcUsd, solUsd, ethUsd, simStart, now, lb, rb, `${lb}d / ${rb}d`);
    }
  }
})();
