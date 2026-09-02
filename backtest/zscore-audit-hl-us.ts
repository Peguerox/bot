// Audits the close-only vs high/low-aware execution assumption for the SOL z-score strategy.
// Close-only (what every prior test used) checks TP/SL against each candle's close price.
// HL-aware checks whether price touched TP or SL intra-candle (using high/low), which is what
// would actually happen live. Compares both on the same 6-month window to see how much the
// simplification matters. Read-only, does not touch live bots.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://data-api.binance.vision/api/v3";
const ALLOCATION_USD = 50;
const ZSCORE_WINDOW = 50;
const Z_ENTRY = -2.0;
const TP_PCT = 0.8;
const SL_PCT = 0.3;
const MAX_HOLD = 6;

type OHLC = { t: number; o: number; h: number; l: number; c: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
async function fetchKlines(symbol: string, interval: string, startMs: number, endMs: number): Promise<OHLC[]> {
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

function runSim(candles: OHLC[], useHL: boolean, label: string) {
  const closes = candles.map(c => c.c);
  const zscores: number[] = new Array(candles.length).fill(NaN);
  for (let i = ZSCORE_WINDOW; i < candles.length; i++) {
    const window = closes.slice(i - ZSCORE_WINDOW, i);
    const mean = window.reduce((s, v) => s + v, 0) / window.length;
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
    const std = Math.sqrt(variance);
    zscores[i] = std > 0 ? (closes[i] - mean) / std : 0;
  }

  let usd = ALLOCATION_USD, qty = 0, inTrade = false;
  let entryPrice = 0, entryIdx = 0, trades = 0, wins = 0;
  let peak = ALLOCATION_USD, maxDD = 0;
  let tpHits = 0, slHits = 0, holdHits = 0;

  for (let i = ZSCORE_WINDOW; i < candles.length; i++) {
    const closePrice = candles[i].c;
    if (!inTrade && zscores[i] <= Z_ENTRY) { entryPrice = closePrice; entryIdx = i; qty = usd / closePrice; usd = 0; inTrade = true; }

    if (inTrade) {
      const held = i - entryIdx;
      let exitPrice: number | null = null;
      let reason = "";

      if (useHL && held > 0) {
        // check intra-candle: did high touch TP, or low touch SL, first?
        const tpPrice = entryPrice * (1 + TP_PCT / 100);
        const slPrice = entryPrice * (1 - SL_PCT / 100);
        const hitTP = candles[i].h >= tpPrice;
        const hitSL = candles[i].l <= slPrice;
        if (hitTP && hitSL) {
          // ambiguous — assume SL hit first (conservative) since low reversal in a 5m candle
          exitPrice = slPrice; reason = "SL(both-ambig)";
        } else if (hitTP) { exitPrice = tpPrice; reason = "TP"; }
        else if (hitSL) { exitPrice = slPrice; reason = "SL"; }
      } else if (held > 0) {
        const curPct = (closePrice - entryPrice) / entryPrice * 100;
        if (curPct >= TP_PCT) { exitPrice = closePrice; reason = "TP"; }
        else if (curPct <= -SL_PCT) { exitPrice = closePrice; reason = "SL"; }
      }
      if (exitPrice === null && held >= MAX_HOLD) { exitPrice = closePrice; reason = "HOLD"; }

      if (exitPrice !== null) {
        usd = qty * exitPrice;
        trades++; if (usd > qty * entryPrice) wins++;
        if (reason.startsWith("TP")) tpHits++; else if (reason.startsWith("SL")) slHits++; else holdHits++;
        qty = 0; inTrade = false;
      }
    }
    const eq = inTrade ? qty * closePrice : usd;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  const finalVal = inTrade ? qty * closes[closes.length-1] : usd;
  const ret = (finalVal - ALLOCATION_USD) / ALLOCATION_USD * 100;
  const wr = trades ? (wins/trades*100).toFixed(1) : "-";
  console.log(`${label.padEnd(20)}${(ret>=0?"+":"")+ret.toFixed(1).padStart(8)}%   $${finalVal.toFixed(2).padStart(8)}   trades=${trades}   WR=${wr}%   maxDD=${maxDD.toFixed(1)}%   TP=${tpHits} SL=${slHits} HOLD=${holdHits}`);
}

(async () => {
  const now = Date.now();
  const start = now - 6 * 30 * 24 * 60 * 60 * 1000; // 6mo audit window
  process.stdout.write(`Fetching SOLUSDT 5m (OHLC, 6mo)... `);
  const candles = await fetchKlines("SOLUSDT", "5m", start, now);
  console.log(`${candles.length}`);

  console.log(`\nSOL z-score · close-only vs high/low-aware execution · 6mo\n`);
  runSim(candles, false, `Close-only (all prior tests)`);
  runSim(candles, true, `High/Low-aware (realistic)`);
})();
