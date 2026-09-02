// DCA ladder triggered by PRICE, not by bar count. Armed (price < rolling VWAP(20) on 5m)
// starts a ladder — buy 1% of capital. Each subsequent tranche only fires when price drops
// another 1% below the LAST tranche's entry price (not the original, not the average) —
// so triggers are cumulative multiplicative drops, not time-based. TP tested at 1%/5%/10%
// above the ladder's weighted average entry, exits the whole position. No stop loss. Cap 100
// tranches ($1000 total). SOLFDUSD, 5-min, 1yr. Close-only execution (same simplification as
// the other DCA ladder scripts this session — no 1-min HL fetch).
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const TOTAL_CAPITAL = 1000;
const TRANCHE_PCT = 1.0;     // % of total capital per tranche
const TRANCHE_USD = TOTAL_CAPITAL * TRANCHE_PCT / 100;
const DROP_PCT = 2.0;        // price must fall this % below the LAST entry to trigger the next tranche
const PERIOD = 20;
const CANDLE_MS = 5 * 60 * 1000;

type C5 = { t: number; c: number; v: number };

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

function calcRollingVWAP(candles: C5[], period: number): number[] {
  const out: number[] = new Array(candles.length).fill(NaN);
  for (let i = period - 1; i < candles.length; i++) {
    let pv = 0, vol = 0;
    for (let k = i - period + 1; k <= i; k++) { pv += candles[k].c * candles[k].v; vol += candles[k].v; }
    out[i] = vol > 0 ? pv / vol : NaN;
  }
  return out;
}

function runSim(candles5: C5[], windowStartMs: number, favorable: boolean[], tpPct: number) {
  let inLadder = false;
  let totalInvested = 0, totalQty = 0, tranches = 0, lastEntryPrice = 0;
  let laddersCompleted = 0, laddersMaxedOut = 0;
  let realizedPnl = 0;
  let maxTranchesUsed = 0;
  let totalBarsInLadder = 0, curLadderBars = 0;
  const maxTranches = TOTAL_CAPITAL / TRANCHE_USD;

  let startIdx = candles5.findIndex(c => c.t >= windowStartMs);
  startIdx = Math.max(startIdx, PERIOD);

  let i = startIdx;
  while (i < candles5.length) {
    const price = candles5[i].c;

    if (!inLadder) {
      if (favorable[i]) {
        totalInvested = TRANCHE_USD;
        totalQty = TRANCHE_USD / price;
        tranches = 1;
        lastEntryPrice = price;
        inLadder = true;
        curLadderBars = 1;
      }
      i++;
      continue;
    }

    const avgEntry = totalInvested / totalQty;
    const tp = avgEntry * (1 + tpPct / 100);

    if (price >= tp) {
      const usdOut = totalQty * tp;
      realizedPnl += usdOut - totalInvested;
      laddersCompleted++;
      totalBarsInLadder += curLadderBars;
      if (tranches >= maxTranches) laddersMaxedOut++;
      maxTranchesUsed = Math.max(maxTranchesUsed, tranches);
      inLadder = false; totalInvested = 0; totalQty = 0; tranches = 0; curLadderBars = 0; lastEntryPrice = 0;
      i++;
      continue;
    }

    curLadderBars++;
    const dropTrigger = lastEntryPrice * (1 - DROP_PCT / 100);
    if (price <= dropTrigger && totalInvested + TRANCHE_USD <= TOTAL_CAPITAL) {
      totalInvested += TRANCHE_USD;
      totalQty += TRANCHE_USD / price;
      tranches++;
      lastEntryPrice = price;
    }
    i++;
  }

  const stillOpen = inLadder;
  const lastPrice = candles5.length ? candles5[candles5.length - 1].c : 0;
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
  const candleFetchStart = windowStart - (PERIOD + 5) * CANDLE_MS;

  const symbol = "SOLFDUSD";
  process.stdout.write(`Fetching ${symbol} 5m (1yr)... `);
  const raw5 = await fetchKlines(symbol, "5m", candleFetchStart, now);
  const c5: C5[] = raw5.map(c => ({ t: +c[0], c: +c[4], v: +c[5] }));
  console.log(`${c5.length}`);

  const closes = c5.map(c => c.c);
  const vwap = calcRollingVWAP(c5, PERIOD);
  const favorable = closes.map((c, i) => !isNaN(vwap[i]) && c < vwap[i]);

  console.log(`\nSOLFDUSD VWAP-armed, PRICE-drop DCA ladder · 1yr · $${TOTAL_CAPITAL} cap, ${TRANCHE_PCT}%/tranche ($${TRANCHE_USD}), drop trigger ${DROP_PCT}%, no SL, 5-min\n`);

  for (const tpPct of [1, 5, 10]) {
    const r = runSim(c5, windowStart, favorable, tpPct);
    console.log(`TP=${tpPct}%   ${(r.ret>=0?"+":"")+r.ret.toFixed(1)}%   $${TOTAL_CAPITAL}->$${r.finalVal.toFixed(2)}   ladders=${r.laddersCompleted}   maxedOut=${r.laddersMaxedOut}   maxTranchesUsed=${r.maxTranchesUsed}/${TOTAL_CAPITAL/TRANCHE_USD}   avgBars=${r.avgLadderBars.toFixed(1)} (~${(r.avgLadderBars*5/60).toFixed(1)}h)   ${r.stillOpen ? `STUCK: ${r.openTranches}tr $${r.openInvested} unrealized ${(r.openUnrealized>=0?"+":"")+r.openUnrealized.toFixed(2)}` : "clean at window end"}`);
  }
})();
