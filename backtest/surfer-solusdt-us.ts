// Same as surfer-solusdt.ts but pulls klines from Binance.US (api.binance.us)
// instead of Binance.com global (data-api.binance.vision) — the live bot
// (trigger/live-bot-surfer-solusdt.ts) actually trades on Binance.US, so this
// checks whether venue price/liquidity differences explain any live-vs-backtest gap.
// Strategy logic is byte-for-byte identical to surfer-solusdt.ts.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE       = "https://api.binance.us/api/v3";
const LOOKBACK   = 365 * 24 * 60 * 60 * 1000;
const ALLOCATION = 50;
const RSI_LOW    = 30;
const MA_FAST    = 7;
const MA_SLOW    = 25;

type C = { t: number; c: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string, interval: string, startMs: number, endMs: number): Promise<C[]> {
  const out: C[] = [];
  let from = startMs;
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

function calcRSI(candles: C[], period = 14): number[] {
  const rsi: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].c - candles[i-1].c;
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= period; avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].c - candles[i-1].c;
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function calcEMA(candles: C[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = new Array(candles.length).fill(NaN);
  out[period - 1] = candles.slice(0, period).reduce((a, c) => a + c.c, 0) / period;
  for (let i = period; i < candles.length; i++) out[i] = candles[i].c * k + out[i-1] * (1 - k);
  return out;
}

function runSim(c15: C[], c12h: C[], label: string, trailingStopPct: number | null = null, showMonthly = false) {
  const rsi  = calcRSI(c15);
  const f12  = calcEMA(c12h, MA_FAST);
  const s12  = calcEMA(c12h, MA_SLOW);

  const trend12h: { t: number; fast: number; prevFast: number; slow: number; close: number }[] = c12h.map((c, i) => ({
    t: c.t, fast: f12[i], prevFast: i > 0 ? f12[i-1] : NaN, slow: s12[i], close: c.c,
  }));

  function getTrend(t: number, livePrice: number): { bullish: boolean; slowEma: number; fastSloping: boolean } {
    let idx = -1;
    for (let i = trend12h.length - 1; i >= 0; i--) {
      if (trend12h[i].t <= t) { idx = i; break; }
    }
    if (idx < 0) return { bullish: false, slowEma: NaN, fastSloping: false };
    const { fast, prevFast, slow, close } = trend12h[idx];
    if (isNaN(fast) || isNaN(slow)) return { bullish: false, slowEma: NaN, fastSloping: false };
    const delta    = livePrice - close;
    const livefast = fast + delta / MA_FAST;
    const liveslow = slow + delta / MA_SLOW;
    return { bullish: livefast > liveslow, slowEma: liveslow, fastSloping: !isNaN(prevFast) && livefast > prevFast };
  }

  function isBullish(t: number, livePrice: number): boolean {
    return getTrend(t, livePrice).bullish;
  }

  let usdt = ALLOCATION, solQty = 0;
  let mode: "USDT" | "SOL" = "USDT";
  let armedBuy = false;
  let entryPrice = 0, entryUsdt = 0;
  let trades = 0, wins = 0, totalPnl = 0, trailingStopHits = 0;
  let peak = ALLOCATION, maxDD = 0;
  let tradePeak = 0;
  const tradeLog: string[] = [];

  const monthlySnaps: { ym: string; startEq: number; endEq: number }[] = [];
  let curMonth = "", monthStartEq = ALLOCATION;

  for (let i = 1; i < c15.length; i++) {
    if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
    const price = c15[i].c;
    const t     = c15[i].t;
    const eq    = mode === "SOL" ? solQty * price : usdt;
    const ym    = new Date(t).toISOString().slice(0, 7);
    if (showMonthly) {
      if (ym !== curMonth) {
        if (curMonth !== "") monthlySnaps.push({ ym: curMonth, startEq: monthStartEq, endEq: eq });
        curMonth = ym; monthStartEq = eq;
      }
    }

    if (rsi[i-1] < RSI_LOW && rsi[i] >= RSI_LOW && mode === "USDT") armedBuy = true;

    const { bullish, fastSloping } = getTrend(t, price);
    if (armedBuy && bullish && fastSloping) {
      entryPrice = price;
      entryUsdt  = usdt;
      solQty     = usdt / price;
      usdt       = 0;
      mode       = "SOL";
      armedBuy   = false;
      tradePeak  = entryUsdt;
      const eq   = solQty * price;
      if (eq > peak) peak = eq;
    }

    if (mode === "SOL" && !isBullish(t, price) && rsi[i] < 50) {
      usdt = solQty * price;
      const pnl = usdt - entryUsdt;
      const pct = pnl / entryUsdt * 100;
      totalPnl += pnl;
      trades++;
      if (pnl > 0) wins++;
      if (usdt > peak) peak = usdt;
      const dd = (peak - usdt) / peak * 100;
      if (dd > maxDD) maxDD = dd;
      const dt = new Date(t).toISOString().slice(0, 16).replace("T", " ");
      tradeLog.push(`  ${dt}  SELL  entry=$${entryPrice.toFixed(3)}  exit=$${price.toFixed(3)}  pnl=${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`);
      solQty = 0;
      mode   = "USDT";
    }

    if (mode === "SOL") {
      const eq = solQty * price;
      if (eq > peak) peak = eq;
      if (eq > tradePeak) tradePeak = eq;
      const dd = (peak - eq) / peak * 100;
      if (dd > maxDD) maxDD = dd;

      if (trailingStopPct !== null && tradePeak > 0) {
        const dropFromPeak = (tradePeak - eq) / tradePeak * 100;
        if (dropFromPeak >= trailingStopPct) {
          usdt = eq;
          const pnl = usdt - entryUsdt;
          const pct = pnl / entryUsdt * 100;
          totalPnl += pnl;
          trades++;
          trailingStopHits++;
          if (pnl > 0) wins++;
          if (usdt > peak) peak = usdt;
          const ddExit = (peak - usdt) / peak * 100;
          if (ddExit > maxDD) maxDD = ddExit;
          const dt = new Date(t).toISOString().slice(0, 16).replace("T", " ");
          tradeLog.push(`  ${dt}  STOP  entry=$${entryPrice.toFixed(3)}  exit=$${price.toFixed(3)}  pnl=${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)  [trailing stop]`);
          solQty = 0;
          mode   = "USDT";
          tradePeak = 0;
        }
      }
    }
  }

  const finalVal  = mode === "SOL" ? solQty * c15[c15.length-1].c : usdt;
  const openPnl   = mode === "SOL" ? finalVal - entryUsdt : 0;
  const totalVal  = finalVal;
  const totalRet  = (totalVal - ALLOCATION) / ALLOCATION * 100;
  const wr        = trades > 0 ? (wins / trades * 100).toFixed(1) : "—";

  const bhStart   = c15[0].c;
  const bhEnd     = c15[c15.length - 1].c;
  const bhRet     = (bhEnd - bhStart) / bhStart * 100;
  const bhVal     = ALLOCATION * (bhEnd / bhStart);

  console.log(`\n${"═".repeat(60)}`);
  console.log(` ${label}`);
  console.log(`${"═".repeat(60)}`);
  console.log(` Start:    $${ALLOCATION}  |  SOL: $${bhStart.toFixed(2)} → $${bhEnd.toFixed(2)}`);
  console.log(` Strategy: $${totalVal.toFixed(2)}  (${totalRet >= 0 ? "+" : ""}${totalRet.toFixed(1)}%)`);
  console.log(` B&H SOL:  $${bhVal.toFixed(2)}  (${bhRet >= 0 ? "+" : ""}${bhRet.toFixed(1)}%)`);
  console.log(` Edge:     ${(totalRet - bhRet) >= 0 ? "+" : ""}${(totalRet - bhRet).toFixed(1)}% vs hold`);
  console.log(` Trades:   ${trades}  |  Win rate: ${wr}%`);
  console.log(` PnL:      ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)} closed  |  Open: ${openPnl >= 0 ? "+" : ""}$${openPnl.toFixed(2)} (in ${mode})`);
  console.log(` Max DD:   ${maxDD.toFixed(2)}%`);
  if (trailingStopPct !== null) console.log(` Stops:    ${trailingStopHits} trailing stop exits`);
  if (tradeLog.length) {
    console.log(` Trades:`);
    for (const l of tradeLog) console.log(l);
  }
  if (showMonthly && monthlySnaps.length) {
    console.log(` Monthly P&L:`);
    for (const { ym, startEq, endEq } of monthlySnaps) {
      const ret = (endEq - startEq) / startEq * 100;
      const bar = ret >= 0 ? "▲" : "▼";
      console.log(`  ${ym}  ${bar} ${ret >= 0 ? "+" : ""}${ret.toFixed(1).padStart(6)}%   $${startEq.toFixed(2)} → $${endEq.toFixed(2)}`);
    }
  }
}

(async () => {
  const now    = Date.now();
  const starts = [
    { s: now - LOOKBACK,     e: now },
    { s: now - 2 * LOOKBACK, e: now - LOOKBACK },
  ];

  for (const period of starts) {
    const dLabel = `${new Date(period.s).toISOString().slice(0,10)} – ${new Date(period.e).toISOString().slice(0,10)}`;

    process.stdout.write(`Fetching SOLUSDT 15m (${dLabel}) [Binance.US]... `);
    const c15  = await fetchKlines("SOLUSDT", "15m", period.s, period.e);
    console.log(`${c15.length} candles`);

    process.stdout.write(`Fetching SOLUSDT 12h (${dLabel}) [Binance.US]... `);
    const c12h = await fetchKlines("SOLUSDT", "12h", period.s, period.e);
    console.log(`${c12h.length} candles`);

    runSim(c15, c12h, `SOLUSDT · Surfer · Filter #3 · ${dLabel} (Binance.US api.binance.us)`, null, true);
  }
})();
