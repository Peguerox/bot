// Tests 3 candidate filters (found via pattern audit) against the slope-filter baseline,
// all on the SAME continuous 5-year SOLBTC dataset (single fetch, corrected no-window-reset
// methodology from the last audit). Does not touch live bots.
//
// Baseline: slope filter only (current best: buy requires RSI arm 30 + EMA bullish + EMA7 sloping up)
// Variant A: + macro filter    — block buy if 60-day SOLBTC trend is already > +20% (don't buy an extended move)
// Variant B: + slope threshold — require EMA7 slope strength > 0.7% (not just >0, a stronger momentum bar)
// Variant C: + cooldown        — require >= 5 days since the last trade closed before a new buy can fire
// Variant D: all three combined
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE       = "https://api.binance.us/api/v3";
const LOOKBACK   = 365 * 24 * 60 * 60 * 1000;
const RSI_LOW    = 30;
const RSI_HIGH   = 70;
const MA_FAST    = 7;
const MA_SLOW    = 25;
const ALLOCATION_USD = 50;
const MACRO_THRESH_PCT  = 20;   // Variant A
const SLOPE_THRESH_PCT  = 0.7;  // Variant B
const COOLDOWN_DAYS     = 5;    // Variant C

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

function priceNDaysBefore(c15: C[], idx: number, days: number): number | null {
  const targetT = c15[idx].t - days * 86_400_000;
  let lo = 0, hi = idx, found = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (c15[mid].t <= targetT) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  return found >= 0 ? c15[found].c : null;
}

type Opts = { useMacroFilter?: boolean; useSlopeThresh?: boolean; useCooldown?: boolean };

function runSim(c15: C[], c12h: C[], btcUsd: C[], label: string, opts: Opts = {}) {
  const rsi = calcRSI(c15);
  const f12 = calcEMA(c12h, MA_FAST);
  const s12 = calcEMA(c12h, MA_SLOW);

  const trend12h: { t: number; fast: number; prevFast: number; slow: number; close: number }[] = c12h.map((c, i) => ({
    t: c.t, fast: f12[i], prevFast: i > 0 ? f12[i-1] : NaN, slow: s12[i], close: c.c,
  }));

  function getTrend(t: number, livePrice: number): { bullish: boolean; sloping: boolean; slopeStrength: number } {
    let idx = -1;
    for (let i = trend12h.length - 1; i >= 0; i--) {
      if (trend12h[i].t <= t) { idx = i; break; }
    }
    if (idx < 0) return { bullish: false, sloping: false, slopeStrength: NaN };
    const { fast, prevFast, slow, close } = trend12h[idx];
    if (isNaN(fast) || isNaN(slow)) return { bullish: false, sloping: false, slopeStrength: NaN };
    const delta = livePrice - close;
    const liveFast = fast + delta / MA_FAST;
    const liveSlow = slow + delta / MA_SLOW;
    const slopeStrength = !isNaN(prevFast) ? (liveFast - prevFast) / prevFast * 100 : NaN;
    return { bullish: liveFast > liveSlow, sloping: !isNaN(prevFast) && liveFast > prevFast, slopeStrength };
  }

  const startBtc = ALLOCATION_USD / btcUsdAt(btcUsd, c15[0].t);
  let btc = startBtc;
  let solQty = 0;
  let mode: "BTC" | "SOL" = "BTC";
  let armedForSol = false, armedForBtc = false;
  let entryBtc = 0;
  let trades = 0, wins = 0, totalPnlBtc = 0;
  let peakUsd = ALLOCATION_USD, maxDD = 0;
  let lastCloseTime = 0;
  let blockedByMacro = 0, blockedBySlope = 0, blockedByCooldown = 0;

  for (let i = 1; i < c15.length; i++) {
    if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
    const price = c15[i].c;
    const t     = c15[i].t;
    const usdPx = btcUsdAt(btcUsd, t);

    if (rsi[i-1] < RSI_LOW && rsi[i] >= RSI_LOW && mode === "BTC" && !armedForSol) armedForSol = true;
    if (rsi[i-1] > RSI_HIGH && rsi[i] <= RSI_HIGH && mode === "SOL" && !armedForBtc) armedForBtc = true;

    const { bullish, sloping, slopeStrength } = getTrend(t, price);

    if (mode === "BTC" && armedForSol && bullish && sloping) {
      let blocked = false;

      if (opts.useMacroFilter) {
        const macro = priceNDaysBefore(c15, i, 60);
        const macroTrend = macro !== null ? (price - macro) / macro * 100 : null;
        if (macroTrend !== null && macroTrend > MACRO_THRESH_PCT) { blocked = true; blockedByMacro++; }
      }
      if (!blocked && opts.useSlopeThresh) {
        if (isNaN(slopeStrength) || slopeStrength < SLOPE_THRESH_PCT) { blocked = true; blockedBySlope++; }
      }
      if (!blocked && opts.useCooldown) {
        const daysSince = lastCloseTime > 0 ? (t - lastCloseTime) / 86_400_000 : Infinity;
        if (daysSince < COOLDOWN_DAYS) { blocked = true; blockedByCooldown++; }
      }

      if (!blocked) {
        entryBtc = btc;
        solQty   = btc / price;
        btc      = 0;
        mode     = "SOL";
        armedForSol = false;
        const eq = solQty * price * usdPx;
        if (eq > peakUsd) peakUsd = eq;
      }
      // if blocked, stay armed — will re-check next candle (matches "arm persists" live behavior)
    }

    if (mode === "SOL" && armedForBtc && !bullish) {
      btc = solQty * price;
      const pnlBtc = btc - entryBtc;
      totalPnlBtc += pnlBtc;
      trades++;
      if (pnlBtc > 0) wins++;
      const eqUsd2 = btc * usdPx;
      if (eqUsd2 > peakUsd) peakUsd = eqUsd2;
      const dd = (peakUsd - eqUsd2) / peakUsd * 100;
      if (dd > maxDD) maxDD = dd;
      solQty = 0;
      mode   = "BTC";
      armedForBtc = false;
      lastCloseTime = t;
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
  const btcAccumRet = (finalBtc - startBtc) / startBtc * 100;
  const wr = trades > 0 ? (wins / trades * 100).toFixed(1) : "—";

  console.log(`\n${label}`);
  console.log(`  BTC accumulated: ${startBtc.toFixed(8)} → ${finalBtc.toFixed(8)}  (${btcAccumRet >= 0 ? "+" : ""}${btcAccumRet.toFixed(1)}%)`);
  console.log(`  USD mark-to-market: $${finalUsd.toFixed(2)}  |  Trades: ${trades}  |  WR: ${wr}%  |  Max DD: ${maxDD.toFixed(2)}%`);
  if (opts.useMacroFilter)  console.log(`  Blocked by macro filter: ${blockedByMacro}`);
  if (opts.useSlopeThresh)  console.log(`  Blocked by slope threshold: ${blockedBySlope}`);
  if (opts.useCooldown)     console.log(`  Blocked by cooldown: ${blockedByCooldown}`);

  return { btcAccumRet, finalUsd, trades, wr, maxDD };
}

(async () => {
  const now   = Date.now();
  const start = now - 5 * LOOKBACK;
  const dLabel = `${new Date(start).toISOString().slice(0,10)} – ${new Date(now).toISOString().slice(0,10)}`;

  process.stdout.write(`Fetching SOLBTC 15m (${dLabel})... `);
  const c15 = await fetchKlines("SOLBTC", "15m", start, now);
  console.log(`${c15.length} candles`);

  process.stdout.write(`Fetching SOLBTC 12h (${dLabel})... `);
  const c12h = await fetchKlines("SOLBTC", "12h", start, now);
  console.log(`${c12h.length} candles`);

  process.stdout.write(`Fetching BTCUSDT 1h (${dLabel})... `);
  const btcUsd = await fetchKlines("BTCUSDT", "1h", start, now);
  console.log(`${btcUsd.length} candles`);

  console.log(`\n${"═".repeat(80)}`);
  console.log(` SOLBTC · continuous 5yr · ${dLabel} · Binance.US`);
  console.log(`${"═".repeat(80)}`);

  runSim(c15, c12h, btcUsd, `[BASELINE] Slope filter only (current best)`, {});
  runSim(c15, c12h, btcUsd, `[A] Slope + macro filter (block buy if 60d trend > +${MACRO_THRESH_PCT}%)`, { useMacroFilter: true });
  runSim(c15, c12h, btcUsd, `[B] Slope + slope-magnitude threshold (require slope > ${SLOPE_THRESH_PCT}%)`, { useSlopeThresh: true });
  runSim(c15, c12h, btcUsd, `[C] Slope + cooldown (>= ${COOLDOWN_DAYS}d since last close)`, { useCooldown: true });
  runSim(c15, c12h, btcUsd, `[D] All three combined`, { useMacroFilter: true, useSlopeThresh: true, useCooldown: true });
})();
