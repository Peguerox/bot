// Adds a USDT safe-harbor option to the basket rotation: at each rebalance, if the BEST of
// {BTC, SOL, ETH} still has a negative trailing return (all three are down), hold USDT
// instead of being forced into the least-bad crypto. Otherwise hold whichever crypto ranks
// #1, same as before. Tracks value in USD, converts to BTC-equivalent at the end for the
// coin-accumulation framing. Continuous ~5yr. Read-only, does not touch live bots.
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

function runSim(btcUsd: C[], solUsd: C[], ethUsd: C[], lookbackDays: number, rebalanceDays: number, useUsdtSafe: boolean, label: string) {
  const assets = [{ name: "BTC", series: btcUsd }, { name: "SOL", series: solUsd }, { name: "ETH", series: ethUsd }];
  const startT = btcUsd[0].t + lookbackDays * 86_400_000;
  const endT = btcUsd[btcUsd.length - 1].t;

  let holding: "BTC"|"SOL"|"ETH"|"USDT" = "BTC";
  let holdingQty = ALLOCATION_USD / priceAt(btcUsd, startT);
  let usdtBalance = 0;
  let lastRebalance = startT;
  let switches = 0, usdtPeriods = 0;
  let peak = ALLOCATION_USD, maxDD = 0;

  function seriesFor(name: string): C[] { return name === "BTC" ? btcUsd : name === "SOL" ? solUsd : ethUsd; }
  function valueUsd(t: number): number {
    if (holding === "USDT") return usdtBalance;
    return holdingQty * priceAt(seriesFor(holding), t);
  }

  let t = startT;
  while (t <= endT) {
    if (t - lastRebalance >= rebalanceDays * 86_400_000 || t === startT) {
      const rets = assets.map(a => {
        const now_ = priceAt(a.series, t), then = priceAt(a.series, t - lookbackDays * 86_400_000);
        return { name: a.name, ret: (now_ - then) / then };
      });
      rets.sort((a, b) => b.ret - a.ret);
      const bestCrypto = rets[0];
      const target: "BTC"|"SOL"|"ETH"|"USDT" = (useUsdtSafe && bestCrypto.ret <= 0) ? "USDT" : (bestCrypto.name as "BTC"|"SOL"|"ETH");

      if (target !== holding) {
        const usdVal = valueUsd(t);
        if (target === "USDT") {
          usdtBalance = usdVal;
        } else {
          holdingQty = usdVal / priceAt(seriesFor(target), t);
        }
        holding = target;
        switches++;
      }
      if (holding === "USDT") usdtPeriods++;
      lastRebalance = t;
    }

    const eqUsd = valueUsd(t);
    if (eqUsd > peak) peak = eqUsd;
    const dd = (peak - eqUsd) / peak * 100;
    if (dd > maxDD) maxDD = dd;
    t += 12 * 60 * 60 * 1000;
  }

  const finalUsd = valueUsd(endT);
  const finalBtcPx = priceAt(btcUsd, endT);
  const startBtcEquiv = ALLOCATION_USD / priceAt(btcUsd, startT);
  const finalBtcEquiv = finalUsd / finalBtcPx;
  const btcRet = (finalBtcEquiv - startBtcEquiv) / startBtcEquiv * 100;
  const usdRet = (finalUsd - ALLOCATION_USD) / ALLOCATION_USD * 100;
  console.log(`${label.padEnd(34)}BTC-terms:${(btcRet>=0?"+":"")+btcRet.toFixed(1).padStart(8)}%   USD:${(usdRet>=0?"+":"")+usdRet.toFixed(1).padStart(8)}%   $${finalUsd.toFixed(2).padStart(8)}   switches=${switches}   maxDD=${maxDD.toFixed(1)}%   USDTperiods=${usdtPeriods}`);
}

(async () => {
  const now = Date.now(), start = now - 5 * 365 * 24 * 60 * 60 * 1000 - 30 * 86_400_000;
  process.stdout.write(`Fetching BTCUSDT 12h... `); const btcUsd = await fetchKlines("BTCUSDT", "12h", start, now); console.log(`${btcUsd.length}`);
  process.stdout.write(`Fetching SOLUSDT 12h... `); const solUsd = await fetchKlines("SOLUSDT", "12h", start, now); console.log(`${solUsd.length}`);
  process.stdout.write(`Fetching ETHUSDT 12h... `); const ethUsd = await fetchKlines("ETHUSDT", "12h", start, now); console.log(`${ethUsd.length}`);

  console.log(`\nBasket rotation + USDT safe harbor · continuous ~5yr\n`);
  runSim(btcUsd, solUsd, ethUsd, 15, 7, false, `[BASELINE] no USDT safe harbor, 15d/7d`);
  runSim(btcUsd, solUsd, ethUsd, 15, 7, true,  `+ USDT safe harbor, 15d/7d`);
  runSim(btcUsd, solUsd, ethUsd, 14, 7, false, `[BASELINE] no USDT safe harbor, 14d/7d`);
  runSim(btcUsd, solUsd, ethUsd, 14, 7, true,  `+ USDT safe harbor, 14d/7d`);
  runSim(btcUsd, solUsd, ethUsd, 14, 8, false, `[BASELINE] no USDT safe harbor, 14d/8d`);
  runSim(btcUsd, solUsd, ethUsd, 14, 8, true,  `+ USDT safe harbor, 14d/8d`);
})();
