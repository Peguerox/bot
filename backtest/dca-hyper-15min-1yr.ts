// "Hyper" DCA ladder: no signal/arming at all. Always active — buy $5 on the first 1-min
// candle, then every subsequent 1-min candle either exit the WHOLE accumulated position if
// price >= 0.1% above the ladder's weighted average entry, or add another $5 tranche.
// Cap $1000 total invested (200 tranches); once fully allocated, wait for TP with no more
// buys. No stop loss. As soon as a ladder completes, the next candle immediately starts a
// new one (unconditional — matches the every-bar "always in" style, just with DCA mechanics).
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const TOTAL_CAPITAL = 5000;
const TRANCHE_USD = 10;
const TP_PCT = 0.1;
const CANDLE_MS = 15 * 60 * 1000;

type C1 = { t: number; h: number; l: number; c: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
async function fetchKlines(symbol: string, interval: string, startMs: number, endMs: number): Promise<any[]> {
  const out: any[] = []; let from = startMs;
  while (from < endMs) {
    const res = await fetch(`${BASE}/klines?symbol=${symbol}&interval=${interval}&startTime=${from}&endTime=${endMs}&limit=1000`);
    if (res.status === 429) { await sleep(6000); continue; }
    if (!res.ok) return out;
    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) out.push(c);
    from = +raw[raw.length - 1][0] + 1;
    await sleep(90);
  }
  return out;
}

function runSim(c1: C1[], windowStartMs: number) {
  let inLadder = false;
  let totalInvested = 0, totalQty = 0, tranches = 0;
  let laddersCompleted = 0, laddersMaxedOut = 0;
  let realizedPnl = 0;
  let maxTranchesUsed = 0;
  let totalBarsInLadder = 0, curLadderBars = 0;

  let startIdx = c1.findIndex(c => c.t >= windowStartMs);
  if (startIdx < 0) startIdx = 0;

  let i = startIdx;
  while (i < c1.length) {
    const price = c1[i].c;

    if (!inLadder) {
      totalInvested = TRANCHE_USD;
      totalQty = TRANCHE_USD / price;
      tranches = 1;
      inLadder = true;
      curLadderBars = 1;
      i++;
      continue;
    }

    const avgEntry = totalInvested / totalQty;
    const tp = avgEntry * (1 + TP_PCT / 100);

    if (c1[i].h >= tp) {
      const usdOut = totalQty * tp;
      realizedPnl += usdOut - totalInvested;
      laddersCompleted++;
      totalBarsInLadder += curLadderBars;
      if (tranches >= TOTAL_CAPITAL / TRANCHE_USD) laddersMaxedOut++;
      maxTranchesUsed = Math.max(maxTranchesUsed, tranches);
      inLadder = false; totalInvested = 0; totalQty = 0; tranches = 0; curLadderBars = 0;
      i++;
      continue;
    }

    curLadderBars++;
    if (totalInvested + TRANCHE_USD <= TOTAL_CAPITAL) {
      totalInvested += TRANCHE_USD;
      totalQty += TRANCHE_USD / price;
      tranches++;
    }
    i++;
  }

  const stillOpen = inLadder;
  const lastPrice = c1.length ? c1[c1.length - 1].c : 0;
  const openUnrealized = stillOpen ? (totalQty * lastPrice - totalInvested) : 0;
  const finalVal = TOTAL_CAPITAL + realizedPnl;
  const ret = realizedPnl / TOTAL_CAPITAL * 100;
  const avgLadderBars = laddersCompleted ? totalBarsInLadder / laddersCompleted : 0;

  return {
    ret, realizedPnl, finalVal, laddersCompleted, laddersMaxedOut, maxTranchesUsed,
    avgLadderBars, stillOpen, openUnrealized, openTranches: tranches, openInvested: totalInvested,
  };
}

(async () => {
  const now = Date.now();
  const windowStart = now - 365 * 24 * 60 * 60 * 1000; // 1yr
  const fetchStart = windowStart - 10 * CANDLE_MS;

  const symbol = "SOLFDUSD";
  process.stdout.write(`Fetching ${symbol} 15m (1yr, will take a while)... `);
  const raw1 = await fetchKlines(symbol, "15m", fetchStart, now);
  const c1: C1[] = raw1.map(c => ({ t: +c[0], h: +c[2], l: +c[3], c: +c[4] }));
  console.log(`${c1.length}`);

  const r = runSim(c1, windowStart);
  console.log(`\nSOLFDUSD hyper DCA ladder · 1yr · $${TOTAL_CAPITAL} cap, $${TRANCHE_USD}/tranche, TP=${TP_PCT}%, no SL, 15-min, no filter\n`);
  console.log(`Return: ${(r.ret>=0?"+":"")+r.ret.toFixed(1)}%   $${TOTAL_CAPITAL} -> $${r.finalVal.toFixed(2)} (realized)   ladders completed=${r.laddersCompleted}`);
  console.log(`Ladders that went fully all-in before hitting TP: ${r.laddersMaxedOut}   Max tranches used in any ladder: ${r.maxTranchesUsed}/${TOTAL_CAPITAL/TRANCHE_USD}`);
  console.log(`Avg bars (15m candles) per completed ladder: ${r.avgLadderBars.toFixed(1)} (~${(r.avgLadderBars*15/60).toFixed(1)}h)`);
  if (r.stillOpen) {
    console.log(`\nSTILL OPEN at window end: ${r.openTranches} tranches, $${r.openInvested} invested, unrealized PnL ${(r.openUnrealized>=0?"+":"")+r.openUnrealized.toFixed(2)}`);
  }
})();
