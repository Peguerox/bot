// Tests candlestick pattern confirmation for SOLBTC — bullish engulfing on the 12h trend
// candle as an extra entry filter (current candle's body fully engulfs and closes above the
// previous candle's body), and bearish engulfing as an extra exit filter. Different signal
// type than anything tried so far (price action vs indicators). Layered on top of
// arm@6%/trail@7.5pp. BTC-denominated, continuous ~5yr. Read-only, does not touch live bots.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE       = "https://api.binance.us/api/v3";
const LOOKBACK   = 365 * 24 * 60 * 60 * 1000;
const RSI_LOW    = 30;
const RSI_HIGH   = 70;
const MA_FAST    = 7;
const MA_SLOW    = 25;
const ALLOCATION_USD = 50;
const TRAIL_ARM_PCT  = 6;
const TRAIL_PP       = 7.5;

type OHLC = { t: number; o: number; h: number; l: number; c: number };
type C = { t: number; c: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
async function fetchOHLC(symbol: string, interval: string, startMs: number, endMs: number): Promise<OHLC[]> {
  const out: OHLC[] = []; let from = startMs;
  while (from < endMs) {
    const res = await fetch(`${BASE}/klines?symbol=${symbol}&interval=${interval}&startTime=${from}&endTime=${endMs}&limit=1000`);
    if (res.status === 429) { await sleep(5000); continue; }
    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) out.push({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4] });
    from = +raw[raw.length - 1][0] + 1;
    await sleep(80);
  }
  return out;
}
function calcRSI(candles: C[], period = 14): number[] {
  const rsi: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) { const d = candles[i].c - candles[i-1].c; if (d > 0) avgGain += d; else avgLoss += Math.abs(d); }
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

// bullish engulfing: current body fully engulfs prev body AND current closes green above prev open
function bullishEngulfingAt(ohlc: OHLC[], idx: number): boolean {
  if (idx < 1) return false;
  const cur = ohlc[idx], prev = ohlc[idx - 1];
  const curBullish = cur.c > cur.o;
  const prevBearish = prev.c < prev.o;
  return curBullish && prevBearish && cur.c >= prev.o && cur.o <= prev.c;
}
function bearishEngulfingAt(ohlc: OHLC[], idx: number): boolean {
  if (idx < 1) return false;
  const cur = ohlc[idx], prev = ohlc[idx - 1];
  const curBearish = cur.c < cur.o;
  const prevBullish = prev.c > prev.o;
  return curBearish && prevBullish && cur.c <= prev.o && cur.o >= prev.c;
}

function runSim(c15raw: OHLC[], c12hraw: OHLC[], btcUsd: C[], useEngulfEntry: boolean, useEngulfExit: boolean, label: string) {
  const c15: C[] = c15raw.map(c => ({ t: c.t, c: c.c }));
  const c12h: C[] = c12hraw.map(c => ({ t: c.t, c: c.c }));
  const rsi = calcRSI(c15);
  const f12 = calcEMA(c12h, MA_FAST);
  const s12 = calcEMA(c12h, MA_SLOW);
  const trend12h = c12h.map((c, i) => ({ t: c.t, fast: f12[i], prevFast: i > 0 ? f12[i-1] : NaN, slow: s12[i], close: c.c }));

  function findIdx12h(t: number): number {
    let idx = -1;
    for (let i = trend12h.length - 1; i >= 0; i--) { if (trend12h[i].t <= t) { idx = i; break; } }
    return idx;
  }
  function getTrend(t: number, livePrice: number) {
    const idx = findIdx12h(t);
    if (idx < 0) return { bullish: false, sloping: false };
    const { fast, prevFast, slow, close } = trend12h[idx];
    if (isNaN(fast) || isNaN(slow)) return { bullish: false, sloping: false };
    const delta = livePrice - close;
    const liveFast = fast + delta / MA_FAST;
    const liveSlow = slow + delta / MA_SLOW;
    return { bullish: liveFast > liveSlow, sloping: !isNaN(prevFast) && liveFast > prevFast };
  }

  const startBtc = ALLOCATION_USD / btcUsdAt(btcUsd, c15[0].t);
  let btc = startBtc, solQty = 0;
  let mode: "BTC" | "SOL" = "BTC";
  let armedForSol = false, armedForBtc = false;
  let entryPrice = 0, bestPct = 0;
  let trades = 0, wins = 0;
  let peakUsd = ALLOCATION_USD, maxDD = 0;

  for (let i = 1; i < c15.length; i++) {
    if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
    const price = c15[i].c, t = c15[i].t;
    const usdPx = btcUsdAt(btcUsd, t);

    if (rsi[i-1] < RSI_LOW && rsi[i] >= RSI_LOW && mode === "BTC" && !armedForSol) armedForSol = true;
    if (rsi[i-1] > RSI_HIGH && rsi[i] <= RSI_HIGH && mode === "SOL" && !armedForBtc) armedForBtc = true;

    const { bullish, sloping } = getTrend(t, price);
    const idx12h = findIdx12h(t);
    const engulfBull = useEngulfEntry && idx12h >= 1 && bullishEngulfingAt(c12hraw, idx12h);
    const engulfBear = useEngulfExit && idx12h >= 1 && bearishEngulfingAt(c12hraw, idx12h);

    const entryOk = bullish && sloping && (!useEngulfEntry || engulfBull);

    if (mode === "BTC" && armedForSol && entryOk) {
      entryPrice = price; bestPct = 0;
      solQty = btc / price; btc = 0; mode = "SOL"; armedForSol = false;
      const eq = solQty * price * usdPx;
      if (eq > peakUsd) peakUsd = eq;
    }

    let closeNow = false;
    if (mode === "SOL") {
      const curPct = (price - entryPrice) / entryPrice * 100;
      if (curPct > bestPct) bestPct = curPct;
      if (bestPct >= TRAIL_ARM_PCT && (bestPct - curPct) >= TRAIL_PP) closeNow = true;
      else if (armedForBtc && !bullish && (!useEngulfExit || engulfBear)) closeNow = true;
    }
    if (closeNow) {
      btc = solQty * price;
      trades++;
      if (btc > (solQty * entryPrice)) wins++;
      const eqUsd2 = btc * usdPx;
      if (eqUsd2 > peakUsd) peakUsd = eqUsd2;
      const dd = (peakUsd - eqUsd2) / peakUsd * 100;
      if (dd > maxDD) maxDD = dd;
      solQty = 0; mode = "BTC"; armedForBtc = false;
    }
    if (mode === "SOL") {
      const eq = solQty * price * usdPx;
      if (eq > peakUsd) peakUsd = eq;
      const dd = (peakUsd - eq) / peakUsd * 100;
      if (dd > maxDD) maxDD = dd;
    }
  }

  const lastUsdPx = btcUsdAt(btcUsd, c15[c15.length-1].t);
  const finalBtc = mode === "SOL" ? solQty * c15[c15.length-1].c : btc;
  const finalUsd = finalBtc * lastUsdPx;
  const btcAccumRet = (finalBtc - startBtc) / startBtc * 100;
  const wr = trades > 0 ? (wins/trades*100).toFixed(1) : "-";

  console.log(`${label.padEnd(36)}${(btcAccumRet>=0?"+":"")+btcAccumRet.toFixed(1).padStart(8)}%   $${finalUsd.toFixed(2).padStart(8)}   trades=${trades}   WR=${wr}%   maxDD=${maxDD.toFixed(1)}%`);
}

(async () => {
  const now = Date.now(), start = now - 5 * LOOKBACK;
  process.stdout.write(`Fetching SOLBTC 15m... `); const c15 = await fetchOHLC("SOLBTC", "15m", start, now); console.log(`${c15.length}`);
  process.stdout.write(`Fetching SOLBTC 12h... `); const c12h = await fetchOHLC("SOLBTC", "12h", start, now); console.log(`${c12h.length}`);
  process.stdout.write(`Fetching BTCUSDT 1h... `); const btcUsdRaw = await fetchOHLC("BTCUSDT", "1h", start, now); console.log(`${btcUsdRaw.length}`);
  const btcUsd: C[] = btcUsdRaw.map(c => ({ t: c.t, c: c.c }));

  console.log(`\nSOLBTC · continuous ~5yr · candlestick engulfing confirmation test\n`);

  runSim(c15, c12h, btcUsd, false, false, `[BASELINE] no engulfing check`);
  runSim(c15, c12h, btcUsd, true, false, `+ require bullish engulfing on entry`);
  runSim(c15, c12h, btcUsd, false, true, `+ require bearish engulfing on exit`);
  runSim(c15, c12h, btcUsd, true, true, `+ require both`);
})();
