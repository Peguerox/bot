// Tweaks the slope filter's lookback: instead of comparing EMA7 to EMA7 one 12h candle back
// (the current live setting), compare it to N candles back (24h, 36h, 48h) — a smoother,
// slower-reacting slope test. Same continuous 5yr methodology as every other test in this
// investigation. Read-only, does not touch live bots.
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

function runSim(c15: C[], c12h: C[], btcUsd: C[], lookbackCandles: number, label: string) {
  const rsi = calcRSI(c15);
  const f12 = calcEMA(c12h, MA_FAST);
  const s12 = calcEMA(c12h, MA_SLOW);

  const trend12h: { t: number; fast: number; fastNBack: number; slow: number; close: number }[] = c12h.map((c, i) => ({
    t: c.t, fast: f12[i], fastNBack: i >= lookbackCandles ? f12[i - lookbackCandles] : NaN, slow: s12[i], close: c.c,
  }));

  function getTrend(t: number, livePrice: number) {
    let idx = -1;
    for (let i = trend12h.length - 1; i >= 0; i--) { if (trend12h[i].t <= t) { idx = i; break; } }
    if (idx < 0) return { bullish: false, sloping: false };
    const { fast, fastNBack, slow, close } = trend12h[idx];
    if (isNaN(fast) || isNaN(slow)) return { bullish: false, sloping: false };
    const delta = livePrice - close;
    const liveFast = fast + delta / MA_FAST;
    const liveSlow = slow + delta / MA_SLOW;
    return { bullish: liveFast > liveSlow, sloping: !isNaN(fastNBack) && liveFast > fastNBack };
  }

  const startBtc = ALLOCATION_USD / btcUsdAt(btcUsd, c15[0].t);
  let btc = startBtc;
  let solQty = 0;
  let mode: "BTC" | "SOL" = "BTC";
  let armedForSol = false, armedForBtc = false;
  let entryBtc = 0;
  let trades = 0, wins = 0;
  let peakUsd = ALLOCATION_USD, maxDD = 0;

  for (let i = 1; i < c15.length; i++) {
    if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
    const price = c15[i].c;
    const t     = c15[i].t;
    const usdPx = btcUsdAt(btcUsd, t);

    if (rsi[i-1] < RSI_LOW && rsi[i] >= RSI_LOW && mode === "BTC" && !armedForSol) armedForSol = true;
    if (rsi[i-1] > RSI_HIGH && rsi[i] <= RSI_HIGH && mode === "SOL" && !armedForBtc) armedForBtc = true;

    const { bullish, sloping } = getTrend(t, price);

    if (mode === "BTC" && armedForSol && bullish && sloping) {
      entryBtc = btc;
      solQty   = btc / price;
      btc      = 0;
      mode     = "SOL";
      armedForSol = false;
      const eq = solQty * price * usdPx;
      if (eq > peakUsd) peakUsd = eq;
    }

    if (mode === "SOL" && armedForBtc && !bullish) {
      btc = solQty * price;
      const pnlBtc = btc - entryBtc;
      trades++;
      if (pnlBtc > 0) wins++;
      const eqUsd2 = btc * usdPx;
      if (eqUsd2 > peakUsd) peakUsd = eqUsd2;
      const dd = (peakUsd - eqUsd2) / peakUsd * 100;
      if (dd > maxDD) maxDD = dd;
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
  const btcAccumRet = (finalBtc - startBtc) / startBtc * 100;
  const wr = trades > 0 ? (wins / trades * 100).toFixed(1) : "—";

  console.log(`${label.padEnd(38)}${(btcAccumRet>=0?"+":"")+btcAccumRet.toFixed(1).padStart(8)}%   $${finalUsd.toFixed(2).padStart(8)}   trades=${String(trades).padStart(3)}   WR=${wr.padStart(5)}%   maxDD=${maxDD.toFixed(1)}%`);
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

  console.log(`\nSOLBTC · continuous ~5yr · slope lookback sweep · Binance.US\n`);

  for (const n of [1, 2, 3, 4, 6]) {
    const hrs = n * 12;
    runSim(c15, c12h, btcUsd, n, `lookback=${n} candle(s) (${hrs}h)${n===1 ? " [current live]" : ""}`);
  }
})();
