// Adds a hard stop-loss to the basket rotation, checked continuously (not just at rebalance
// checkpoints) — if the current holding drops X% from when it was acquired, sell to USDT
// immediately, then resume normal rebalancing at the next checkpoint. Tests on the last 1yr
// specifically, since that's where the plain rotation has been losing. Read-only.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://api.binance.us/api/v3";
const ALLOCATION_USD = 50;
const FIVE_YEARS = 5 * 365 * 24 * 60 * 60 * 1000;
const FETCH_BUFFER = 60 * 86_400_000;

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

function runSim(btcUsd: C[], solUsd: C[], ethUsd: C[], simStartT: number, endT: number, lookbackDays: number, rebalanceDays: number, stopPct: number | null, label: string) {
  const assets = [{ name: "BTC", series: btcUsd }, { name: "SOL", series: solUsd }, { name: "ETH", series: ethUsd }];

  let holding: "BTC"|"SOL"|"ETH"|"USDT" = "BTC";
  let holdingQty = ALLOCATION_USD / priceAt(btcUsd, simStartT);
  const startBtcEquiv = holdingQty;
  let usdtBalance = 0;
  let entryPx = priceAt(btcUsd, simStartT);
  let lastRebalance = simStartT, switches = 0, stopHits = 0;
  let peak = ALLOCATION_USD, maxDD = 0;

  function seriesFor(name: string): C[] { return name === "BTC" ? btcUsd : name === "SOL" ? solUsd : ethUsd; }
  function valueUsd(t: number): number {
    if (holding === "USDT") return usdtBalance;
    return holdingQty * priceAt(seriesFor(holding), t);
  }

  let t = simStartT;
  while (t <= endT) {
    // continuous stop check (every 12h step) — only when holding a crypto (not USDT)
    if (stopPct !== null && holding !== "USDT") {
      const curPx = priceAt(seriesFor(holding), t);
      const curPct = (curPx - entryPx) / entryPx * 100;
      if (curPct <= stopPct) {
        usdtBalance = valueUsd(t);
        holding = "USDT";
        stopHits++;
      }
    }

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
        entryPx = priceAt(seriesFor(best), t);
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
  const ret = (finalBtcEquiv - startBtcEquiv) / startBtcEquiv * 100;
  console.log(`${label.padEnd(24)}${(ret>=0?"+":"")+ret.toFixed(1).padStart(8)}%   $${finalUsd.toFixed(2).padStart(8)}   switches=${switches}   stopHits=${stopHits}   maxDD=${maxDD.toFixed(1)}%`);
}

(async () => {
  const now = Date.now();
  const simStart = now - FIVE_YEARS;
  const fetchStart = simStart - FETCH_BUFFER;

  console.log(`Sim window: ${new Date(simStart).toISOString().slice(0,10)} -> ${new Date(now).toISOString().slice(0,10)} (5yr)\n`);
  process.stdout.write(`Fetching BTCUSDT 12h... `); const btcUsd = await fetchKlines("BTCUSDT", "12h", fetchStart, now); console.log(`${btcUsd.length}`);
  process.stdout.write(`Fetching SOLUSDT 12h... `); const solUsd = await fetchKlines("SOLUSDT", "12h", fetchStart, now); console.log(`${solUsd.length}`);
  process.stdout.write(`Fetching ETHUSDT 12h... `); const ethUsd = await fetchKlines("ETHUSDT", "12h", fetchStart, now); console.log(`${ethUsd.length}`);

  console.log(`\nBasket rotation + continuous hard stop — 5yr — same configs found on 1yr\n`);
  runSim(btcUsd, solUsd, ethUsd, simStart, now, 15, 7, null, `[REFERENCE] 15d/7d, no stop (best plain config)`);
  runSim(btcUsd, solUsd, ethUsd, simStart, now, 20, 10, null, `20d/10d, no stop`);
  runSim(btcUsd, solUsd, ethUsd, simStart, now, 20, 10, -8, `20d/10d, -8% stop`);
  runSim(btcUsd, solUsd, ethUsd, simStart, now, 20, 10, -9, `20d/10d, -9% stop`);
  runSim(btcUsd, solUsd, ethUsd, simStart, now, 20, 10, -10, `20d/10d, -10% stop`);
  runSim(btcUsd, solUsd, ethUsd, simStart, now, 20, 10, -12, `20d/10d, -12% stop`);
  runSim(btcUsd, solUsd, ethUsd, simStart, now, 15, 7, -10, `15d/7d, -10% stop`);
})();
