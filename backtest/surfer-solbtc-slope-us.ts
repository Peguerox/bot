// Variant test on SOLBTC — adds SOLUSDT's "Filter #3" slope requirement to the BUY side only.
// Baseline logic is identical to surfer-solbtc-us.ts (mirrors the live bot); the ONLY change:
// buy now requires EMA7 sloping up (EMA7 > prev EMA7 on 12h, liveMode) in addition to EMA7 > EMA25.
// Sell side is unchanged (RSI arm cross down 70 + EMA bearish, no slope requirement — matches
// SOLUSDT, which also only applies the slope filter to entries, not exits).
// This is a backtest-only experiment. It does NOT modify trigger/live-bot-surfer-solbtc.ts.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE       = "https://api.binance.us/api/v3";
const LOOKBACK   = 365 * 24 * 60 * 60 * 1000;
const RSI_LOW    = 30;
const RSI_HIGH   = 70;
const MA_FAST    = 7;
const MA_SLOW    = 25;
const ALLOCATION_USD = 50;

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

function btcUsdAt(btcUsd: C[], t: number): number {
  let lo = 0, hi = btcUsd.length - 1, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (btcUsd[mid].t <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  return idx >= 0 ? btcUsd[idx].c : btcUsd[0].c;
}

function runSim(c15: C[], c12h: C[], btcUsd: C[], label: string, showMonthly = false) {
  const rsi = calcRSI(c15);
  const f12 = calcEMA(c12h, MA_FAST);
  const s12 = calcEMA(c12h, MA_SLOW);

  const trend12h: { t: number; fast: number; prevFast: number; slow: number; close: number }[] = c12h.map((c, i) => ({
    t: c.t, fast: f12[i], prevFast: i > 0 ? f12[i-1] : NaN, slow: s12[i], close: c.c,
  }));

  function getTrend(t: number, livePrice: number): { bullish: boolean; sloping: boolean } {
    let idx = -1;
    for (let i = trend12h.length - 1; i >= 0; i--) {
      if (trend12h[i].t <= t) { idx = i; break; }
    }
    if (idx < 0) return { bullish: false, sloping: false };
    const { fast, prevFast, slow, close } = trend12h[idx];
    if (isNaN(fast) || isNaN(slow)) return { bullish: false, sloping: false };
    const delta = livePrice - close;
    const liveFast = fast + delta / MA_FAST;
    const liveSlow = slow + delta / MA_SLOW;
    return { bullish: liveFast > liveSlow, sloping: !isNaN(prevFast) && liveFast > prevFast };
  }

  const startBtc = ALLOCATION_USD / btcUsdAt(btcUsd, c15[0].t);
  let btc = startBtc;
  let solQty = 0;
  let mode: "BTC" | "SOL" = "BTC";
  let armedForSol = false, armedForBtc = false;
  let entryBtc = 0;
  let trades = 0, wins = 0, totalPnlBtc = 0;
  let peakUsd = ALLOCATION_USD, maxDD = 0;
  const tradeLog: string[] = [];

  const monthlySnaps: { ym: string; startUsd: number; endUsd: number }[] = [];
  let curMonth = "", monthStartUsd = ALLOCATION_USD;

  for (let i = 1; i < c15.length; i++) {
    if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
    const price = c15[i].c;
    const t     = c15[i].t;
    const usdPx = btcUsdAt(btcUsd, t);
    const eqUsd = mode === "SOL" ? solQty * price * usdPx : btc * usdPx;
    const ym    = new Date(t).toISOString().slice(0, 7);
    if (showMonthly) {
      if (ym !== curMonth) {
        if (curMonth !== "") monthlySnaps.push({ ym: curMonth, startUsd: monthStartUsd, endUsd: eqUsd });
        curMonth = ym; monthStartUsd = eqUsd;
      }
    }

    if (rsi[i-1] < RSI_LOW && rsi[i] >= RSI_LOW && mode === "BTC" && !armedForSol) armedForSol = true;
    if (rsi[i-1] > RSI_HIGH && rsi[i] <= RSI_HIGH && mode === "SOL" && !armedForBtc) armedForBtc = true;

    const { bullish, sloping } = getTrend(t, price);

    // fire buy: armed + EMA bullish + EMA7 sloping up  ← the one change vs. live logic
    if (mode === "BTC" && armedForSol && bullish && sloping) {
      entryBtc = btc;
      solQty   = btc / price;
      btc      = 0;
      mode     = "SOL";
      armedForSol = false;
      const eq = solQty * price * usdPx;
      if (eq > peakUsd) peakUsd = eq;
    }

    // fire sell: armed + EMA bearish (unchanged, no slope requirement)
    if (mode === "SOL" && armedForBtc && !bullish) {
      btc = solQty * price;
      const pnlBtc = btc - entryBtc;
      const pct    = pnlBtc / entryBtc * 100;
      totalPnlBtc += pnlBtc;
      trades++;
      if (pnlBtc > 0) wins++;
      const eqUsd2 = btc * usdPx;
      if (eqUsd2 > peakUsd) peakUsd = eqUsd2;
      const dd = (peakUsd - eqUsd2) / peakUsd * 100;
      if (dd > maxDD) maxDD = dd;
      const dt = new Date(t).toISOString().slice(0, 16).replace("T", " ");
      tradeLog.push(`  ${dt}  SELL  pnl=${pnlBtc >= 0 ? "+" : ""}${(pnlBtc).toFixed(8)} BTC (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)  ~$${eqUsd2.toFixed(2)}`);
      solQty = 0;
      mode   = "BTC";
      armedForBtc = false;
    }

    if (mode === "SOL") {
      const eq = solQty * price * usdPx;
      if (eq > peakUsd) peakUsd = eq;
      const dd = (peakUsd - eq) / peakUsd * 100;
      if (dd > maxDD) maxDD = dd;
    }
  }

  const lastUsdPx = btcUsdAt(btcUsd, c15[c15.length-1].t);
  const finalBtc  = mode === "SOL" ? solQty * c15[c15.length-1].c : btc;
  const finalUsd  = finalBtc * lastUsdPx;
  const openPnlBtc = mode === "SOL" ? finalBtc - entryBtc : 0;
  const totalRet  = (finalUsd - ALLOCATION_USD) / ALLOCATION_USD * 100;
  const btcAccumRet = (finalBtc - startBtc) / startBtc * 100;
  const wr        = trades > 0 ? (wins / trades * 100).toFixed(1) : "—";

  const bhStart   = c15[0].c;
  const bhEnd     = c15[c15.length - 1].c;
  const bhRetBtc  = (bhEnd - bhStart) / bhStart * 100;

  console.log(`\n${"═".repeat(60)}`);
  console.log(` ${label}`);
  console.log(`${"═".repeat(60)}`);
  console.log(` Start:    $${ALLOCATION_USD} (${startBtc.toFixed(8)} BTC)  |  SOLBTC: ${bhStart.toFixed(7)} → ${bhEnd.toFixed(7)}`);
  console.log(` BTC accumulated: ${startBtc.toFixed(8)} → ${finalBtc.toFixed(8)}  (${btcAccumRet >= 0 ? "+" : ""}${btcAccumRet.toFixed(1)}% coin-denominated)`);
  console.log(` USD mark-to-market: $${finalUsd.toFixed(2)}  (${totalRet >= 0 ? "+" : ""}${totalRet.toFixed(1)}%)`);
  console.log(` Hold SOL instead (BTC-denominated): ${bhRetBtc >= 0 ? "+" : ""}${bhRetBtc.toFixed(1)}%`);
  console.log(` Trades:   ${trades}  |  Win rate: ${wr}%`);
  console.log(` PnL:      ${totalPnlBtc >= 0 ? "+" : ""}${totalPnlBtc.toFixed(8)} BTC closed  |  Open: ${openPnlBtc >= 0 ? "+" : ""}${openPnlBtc.toFixed(8)} BTC (in ${mode})`);
  console.log(` Max DD:   ${maxDD.toFixed(2)}% (USD terms)`);
  if (tradeLog.length) {
    console.log(` Trades:`);
    for (const l of tradeLog) console.log(l);
  }
  if (showMonthly && monthlySnaps.length) {
    console.log(` Monthly P&L (USD terms):`);
    for (const { ym, startUsd, endUsd } of monthlySnaps) {
      const ret = (endUsd - startUsd) / startUsd * 100;
      const bar = ret >= 0 ? "▲" : "▼";
      console.log(`  ${ym}  ${bar} ${ret >= 0 ? "+" : ""}${ret.toFixed(1).padStart(6)}%   $${startUsd.toFixed(2)} → $${endUsd.toFixed(2)}`);
    }
  }
}

(async () => {
  const now    = Date.now();
  const starts = [
    { s: now - LOOKBACK,     e: now },
    { s: now - 2 * LOOKBACK, e: now - LOOKBACK },
    { s: now - 3 * LOOKBACK, e: now - 2 * LOOKBACK },
    { s: now - 4 * LOOKBACK, e: now - 3 * LOOKBACK },
    { s: now - 5 * LOOKBACK, e: now - 4 * LOOKBACK },
  ];

  for (const period of starts) {
    const dLabel = `${new Date(period.s).toISOString().slice(0,10)} – ${new Date(period.e).toISOString().slice(0,10)}`;

    process.stdout.write(`Fetching SOLBTC 15m (${dLabel}) [Binance.US]... `);
    const c15  = await fetchKlines("SOLBTC", "15m", period.s, period.e);
    console.log(`${c15.length} candles`);

    process.stdout.write(`Fetching SOLBTC 12h (${dLabel}) [Binance.US]... `);
    const c12h = await fetchKlines("SOLBTC", "12h", period.s, period.e);
    console.log(`${c12h.length} candles`);

    process.stdout.write(`Fetching BTCUSDT 1h (${dLabel}) [Binance.US, USD context only]... `);
    const btcUsd = await fetchKlines("BTCUSDT", "1h", period.s, period.e);
    console.log(`${btcUsd.length} candles`);

    if (c15.length < 2 || c12h.length < 2 || btcUsd.length < 2) {
      console.log(`  (skipping ${dLabel} — insufficient data, likely pre-listing)`);
      continue;
    }
    runSim(c15, c12h, btcUsd, `SOLBTC · Surfer + SLOPE FILTER · ${dLabel} (Binance.US)`, true);
  }
})();
