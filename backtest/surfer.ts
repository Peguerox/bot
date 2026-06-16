// The Surfer — MA(7/25) + RSI(14) rotation on ALTBTC pairs
// MA7 > MA25 = ALT winning | MA7 < MA25 = BTC winning
// Switch to ALT: RSI crosses up through 20 AND MA7 > MA25 at that moment
// Switch to BTC: RSI crosses down through 80 AND MA7 < MA25 at that moment
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_GL  = "https://data-api.binance.vision/api/v3";
const BASE_US  = "https://api.binance.us/api/v3";
const LOOKBACK = 365 * 24 * 60 * 60 * 1000;
const MA_FAST = 7, MA_SLOW = 25;
const RSI_LOW = 17, RSI_HIGH = 83;

type C = { t: number; o: number; h: number; l: number; c: number; v: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string, interval = "5m", startMs?: number, endMs?: number, base = BASE_GL): Promise<C[]> {
  const out: C[] = [];
  const until = endMs ?? Date.now();
  let from = startMs ?? until - LOOKBACK;
  while (from < until) {
    const res = await fetch(`${base}/klines?symbol=${symbol}&interval=${interval}&startTime=${from}&endTime=${until}&limit=1000`);
    if (res.status === 429) { await sleep(5000); continue; }
    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) out.push({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] });
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
    const diff = candles[i].c - candles[i-1].c;
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period; avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].c - candles[i-1].c;
    avgGain = (avgGain * 13 + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * 13 + (diff < 0 ? Math.abs(diff) : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function calcSMA(candles: C[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = new Array(candles.length).fill(NaN);
  out[period - 1] = candles.slice(0, period).reduce((a, c) => a + c.c, 0) / period;
  for (let i = period; i < candles.length; i++) out[i] = candles[i].c * k + out[i-1] * (1 - k);
  return out;
}

function calcBB(candles: C[], period = 20, mult = 2): { upper: number[]; lower: number[] } {
  const upper = new Array(candles.length).fill(NaN);
  const lower = new Array(candles.length).fill(NaN);
  for (let i = period - 1; i < candles.length; i++) {
    const slice = candles.slice(i - period + 1, i + 1).map(c => c.c);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const std  = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
    upper[i] = mean + mult * std;
    lower[i] = mean - mult * std;
  }
  return { upper, lower };
}

function calcMACD(candles: C[], fast = 12, slow = 26, signal = 9): { macd: number[]; sig: number[] } {
  const emaFast = calcSMA(candles, fast);
  const emaSlow = calcSMA(candles, slow);
  const macd = candles.map((_, i) => isNaN(emaFast[i]) || isNaN(emaSlow[i]) ? NaN : emaFast[i] - emaSlow[i]);
  const validStart = macd.findIndex(v => !isNaN(v));
  const sig = new Array(candles.length).fill(NaN);
  if (validStart < 0) return { macd, sig };
  const k = 2 / (signal + 1);
  sig[validStart + signal - 1] = macd.slice(validStart, validStart + signal).reduce((a, b) => a + b, 0) / signal;
  for (let i = validStart + signal; i < candles.length; i++) sig[i] = macd[i] * k + sig[i-1] * (1 - k);
  return { macd, sig };
}

function calcStoch(candles: C[], kPeriod = 14, dPeriod = 3): { k: number[]; d: number[] } {
  const k = new Array(candles.length).fill(NaN);
  for (let i = kPeriod - 1; i < candles.length; i++) {
    const slice = candles.slice(i - kPeriod + 1, i + 1);
    const high = Math.max(...slice.map(c => c.h));
    const low  = Math.min(...slice.map(c => c.l));
    k[i] = high === low ? 50 : (candles[i].c - low) / (high - low) * 100;
  }
  const d = new Array(candles.length).fill(NaN);
  for (let i = kPeriod + dPeriod - 2; i < candles.length; i++) {
    const vals = k.slice(i - dPeriod + 1, i + 1).filter(v => !isNaN(v));
    if (vals.length === dPeriod) d[i] = vals.reduce((a, b) => a + b, 0) / dPeriod;
  }
  return { k, d };
}

function calcADX(candles: C[], period = 14): number[] {
  const adx = new Array(candles.length).fill(NaN);
  if (candles.length < period * 2) return adx;
  let smoothTR = 0, smoothPDM = 0, smoothNDM = 0;
  for (let i = 1; i <= period; i++) {
    const tr   = Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i-1].c), Math.abs(candles[i].l - candles[i-1].c));
    const upMove = candles[i].h - candles[i-1].h;
    const dnMove = candles[i-1].l - candles[i].l;
    smoothTR   += tr;
    smoothPDM  += upMove > dnMove && upMove > 0 ? upMove : 0;
    smoothNDM  += dnMove > upMove && dnMove > 0 ? dnMove : 0;
  }
  const dx: number[] = new Array(candles.length).fill(NaN);
  for (let i = period + 1; i < candles.length; i++) {
    const tr   = Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i-1].c), Math.abs(candles[i].l - candles[i-1].c));
    const upMove = candles[i].h - candles[i-1].h;
    const dnMove = candles[i-1].l - candles[i].l;
    smoothTR  = smoothTR  - smoothTR  / period + tr;
    smoothPDM = smoothPDM - smoothPDM / period + (upMove > dnMove && upMove > 0 ? upMove : 0);
    smoothNDM = smoothNDM - smoothNDM / period + (dnMove > upMove && dnMove > 0 ? dnMove : 0);
    const pdi = smoothTR === 0 ? 0 : 100 * smoothPDM / smoothTR;
    const ndi = smoothTR === 0 ? 0 : 100 * smoothNDM / smoothTR;
    dx[i] = pdi + ndi === 0 ? 0 : 100 * Math.abs(pdi - ndi) / (pdi + ndi);
  }
  let adxVal = 0, count = 0;
  for (let i = period + 1; i < period * 2 + 1 && i < candles.length; i++) { if (!isNaN(dx[i])) { adxVal += dx[i]; count++; } }
  if (count < period) return adx;
  adxVal /= count;
  adx[period * 2] = adxVal;
  for (let i = period * 2 + 1; i < candles.length; i++) {
    adxVal = (adxVal * (period - 1) + dx[i]) / period;
    adx[i] = adxVal;
  }
  return adx;
}

// Returns a lookup: is market in "ranging" regime at time T?
// Ranging = ADX < 25 AND BB_width below its median AND volume below 1.5x its MA(20)
function buildRegimeLookup(c1h: C[]): (t: number) => boolean {
  const adx   = calcADX(c1h, 14);
  const bb    = calcBB(c1h, 20, 2);

  // BB width as % of midband
  const bbMid = c1h.map((c, i) => {
    const mid = (bb.upper[i] + bb.lower[i]) / 2;
    return isNaN(bb.upper[i]) ? NaN : (bb.upper[i] - bb.lower[i]) / mid * 100;
  });

  // adaptive median threshold for BB width
  const validBBW = bbMid.filter(v => !isNaN(v)).sort((a, b) => a - b);
  const bbwMedian = validBBW[Math.floor(validBBW.length * 0.4)] ?? 0; // 40th percentile = "tighter than average"

  // volume MA(20)
  const volMA = new Array(c1h.length).fill(NaN);
  for (let i = 19; i < c1h.length; i++) {
    volMA[i] = c1h.slice(i - 19, i + 1).reduce((a, c) => a + c.v, 0) / 20;
  }

  // build [timestamp, isRanging] array
  const regime: [number, boolean][] = c1h.map((c, i) => {
    const adxOk = !isNaN(adx[i]) && adx[i] < 25;
    const bbOk  = !isNaN(bbMid[i]) && bbMid[i] < bbwMedian;
    const volOk = !isNaN(volMA[i]) && c.v < volMA[i] * 1.5;
    return [c.t, adxOk && bbOk && volOk];
  });

  return (t: number) => {
    let lo = 0, hi = regime.length - 1, idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (regime[mid][0] <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    return idx >= 0 ? regime[idx][1] : false;
  };
}

function calcCCI(candles: C[], period = 20): number[] {
  const cci = new Array(candles.length).fill(NaN);
  for (let i = period - 1; i < candles.length; i++) {
    const slice = candles.slice(i - period + 1, i + 1);
    const tp    = slice.map(c => (c.h + c.l + c.c) / 3);
    const mean  = tp.reduce((a, b) => a + b, 0) / period;
    const mad   = tp.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
    cci[i] = mad === 0 ? 0 : (tp[tp.length - 1] - mean) / (0.015 * mad);
  }
  return cci;
}

(async () => {
  const now = Date.now();
  const periods = [
    { label: "2021-22", start: now - 5 * LOOKBACK, end: now - 4 * LOOKBACK },
    { label: "2022-23", start: now - 4 * LOOKBACK, end: now - 3 * LOOKBACK },
    { label: "2023-24", start: now - 3 * LOOKBACK, end: now - 2 * LOOKBACK },
    { label: "2024-25", start: now - 2 * LOOKBACK, end: now - LOOKBACK     },
    { label: "2025-26", start: now - LOOKBACK,     end: now                },
  ];

  const SYMBOLS = ["BNBBTC", "SOLBTC"];

  const PAUSE_MS = 48 * 60 * 60 * 1000;

  function runStrategy(c15: C[], opts: { use4h?: C[]; circuitBreaker?: boolean; useAdx?: C[]; useRegime?: C[]; useEma?: boolean; verbose?: boolean; rsiLow?: number; rsiHigh?: number; execCandles?: C[];
    nextCandle?: boolean;   // execute at next candle open instead of same candle close
    strict4h?: boolean;     // only use fully-closed 4h candles (shift lookup -4h) — too conservative
    liveMode4h?: boolean;   // forming 4h candle valued at current 15m price — most realistic
  } = {}): number {
    const fast   = calcSMA(c15, MA_FAST);
    const slow   = calcSMA(c15, MA_SLOW);
    const rsi    = calcRSI(c15);
    const rsiLow  = opts.rsiLow  ?? RSI_LOW;
    const rsiHigh = opts.rsiHigh ?? RSI_HIGH;

    // 4h trend lookup
    // liveMode4h=true (most realistic): forming 4h candle is valued at current 15m price
    //   adjustment: sma_rt = sma_final + (live_price - 4h_final_close) / period
    // strict4h=true (conservative): only use fully closed 4h candles (shift lookup -4h)
    let h4BullishAt: ((t: number, livePrice?: number) => boolean) = () => true;
    if (opts.use4h) {
      const c4h = opts.use4h;
      const f4 = calcSMA(c4h, MA_FAST);
      const s4 = calcSMA(c4h, MA_SLOW);
      const H4 = c4h.length >= 2 ? c4h[1].t - c4h[0].t : 4 * 60 * 60 * 1000;
      // store [openTime, fastSMA, slowSMA, finalClose] for real-time correction
      const trend4h: [number, number, number, number][] = c4h.map((c, i) => [c.t, f4[i], s4[i], c.c]);
      h4BullishAt = (t: number, livePrice?: number) => {
        const lookupT = opts.strict4h ? t - H4 : t;
        let lo = 0, hi = trend4h.length - 1, idx = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (trend4h[mid][0] <= lookupT) { idx = mid; lo = mid + 1; } else hi = mid - 1;
        }
        if (idx < 0) return false;
        const [, fv, sv, finalClose] = trend4h[idx];
        if (isNaN(fv) || isNaN(sv)) return false;
        if (livePrice != null && opts.liveMode4h) {
          // adjust SMA for forming candle using current live price instead of final close
          const delta = livePrice - finalClose;
          return (fv + delta / MA_FAST) > (sv + delta / MA_SLOW);
        }
        return fv > sv;
      };
    }

    // regime detection — only trade when market is ranging
    const regimeOkAt: ((t: number) => boolean) = opts.useRegime ? buildRegimeLookup(opts.useRegime) : () => true;

    // execution price lookup — use a separate candle array for trade prices (e.g. US prices)
    const execPriceAt = opts.execCandles
      ? (t: number, _fb: number) => {
          const ec = opts.execCandles!;
          let lo = 0, hi = ec.length - 1, idx = -1;
          while (lo <= hi) { const mid = (lo + hi) >> 1; if (ec[mid].t <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
          return idx >= 0 ? ec[idx].c : ec[0].c;
        }
      : (_t: number, fallback: number) => fallback;

    // ADX lookup on 1h candles — block all signals when ADX > 25
    let adxOkAt: ((t: number) => boolean) = () => true;
    if (opts.useAdx) {
      const c1h = opts.useAdx;
      const adx1h = calcADX(c1h, 14);
      const adxArr: [number, boolean][] = c1h.map((c, i) => [c.t, isNaN(adx1h[i]) || adx1h[i] < 25]);
      adxOkAt = (t: number) => {
        let lo = 0, hi = adxArr.length - 1, idx = -1;
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (adxArr[mid][0] <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
        return idx >= 0 ? adxArr[idx][1] : true;
      };
    }

    let mode: "BTC" | "ALT" = "BTC";
    let btcQty = 1.0, altQty = 0.0;
    let armedForAlt = false, armedForBtc = false;
    let entryBtc = 1.0;
    let consecLosses = 0;
    let pauseUntil = 0;
    let switchCount = 0;
    let armedForAltAt = 0, armedForBtcAt = 0;
    let armedRsiAlt = 0, armedRsiBtc = 0;

    for (let i = 1; i < c15.length; i++) {
      if (isNaN(fast[i]) || isNaN(fast[i-1]) || isNaN(slow[i]) || isNaN(slow[i-1])) continue;
      if (isNaN(rsi[i]) || isNaN(rsi[i-1])) continue;
      const rate = c15[i].c;
      const now  = c15[i].t;

      const onPause   = opts.circuitBreaker && now < pauseUntil;
      const adxOk    = adxOkAt(now);
      const regimeOk = regimeOkAt(now);

      if (!onPause && adxOk) {
        if (rsi[i-1] < rsiLow  && rsi[i] >= rsiLow  && mode === "BTC" && !armedForAlt) {
          armedForAlt = true; armedForAltAt = now; armedRsiAlt = rsi[i];
        }
      }
      if (adxOk) {
        if (rsi[i-1] > rsiHigh && rsi[i] <= rsiHigh && mode === "ALT" && !armedForBtc) {
          armedForBtc = true; armedForBtcAt = now; armedRsiBtc = rsi[i];
        }
      }

      const maCrossUp   = opts.useEma ? fast[i-1] <= slow[i-1] && fast[i] > slow[i] : true;
      const maCrossDown = opts.useEma ? fast[i-1] >= slow[i-1] && fast[i] < slow[i] : true;
      const h4Bullish   = h4BullishAt(now, rate);
      const trendEntry  = opts.use4h ? h4Bullish  : true;
      const trendExit   = opts.use4h ? !h4Bullish : true;

      const ts = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
      const candlesWaited = (from: number) => Math.round((now - from) / (15 * 60 * 1000));

      // nextCandle: defer execution to next candle open (more realistic)
      const execI = opts.nextCandle ? Math.min(i + 1, c15.length - 1) : i;
      const execRate0 = opts.nextCandle ? c15[execI].o : rate;

      if (armedForAlt && maCrossUp && mode === "BTC" && trendEntry && !onPause && adxOk && regimeOk) {
        const execRate = execPriceAt(c15[execI].t, execRate0);
        const btcBefore = btcQty;
        entryBtc = btcQty;
        altQty = btcQty / execRate; btcQty = 0; mode = "ALT"; armedForAlt = false; switchCount++;
        if (opts.verbose) {
          const waited = candlesWaited(armedForAltAt);
          const execLabel = opts.nextCandle ? `next open=${execRate.toFixed(6)}` : `close=${execRate.toFixed(6)}`;
          console.log(`  [${switchCount}] ${ts(now)}  BTC→ALT  armed@${ts(armedForAltAt)} RSI=${armedRsiAlt.toFixed(1)}  ${execLabel}  BTC=${btcBefore.toFixed(6)}`);
        }
      } else if (armedForBtc && maCrossDown && mode === "ALT" && trendExit && regimeOk) {
        const execRate = execPriceAt(c15[execI].t, execRate0);
        const btcAfter = altQty * execRate;
        const pnl = (btcAfter - entryBtc) / entryBtc * 100;
        switchCount++;
        if (opts.verbose) {
          const waited = candlesWaited(armedForBtcAt);
          const execLabel = opts.nextCandle ? `next open=${execRate.toFixed(6)}` : `close=${execRate.toFixed(6)}`;
          console.log(`  [${switchCount}] ${ts(now)}  ALT→BTC  armed@${ts(armedForBtcAt)} RSI=${armedRsiBtc.toFixed(1)}  ${execLabel}  trade=${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)}%  btcNow=${btcAfter.toFixed(6)}`);
        }
        btcQty = btcAfter; altQty = 0; mode = "BTC"; armedForBtc = false;
        if (opts.circuitBreaker) {
          if (btcQty < entryBtc) {
            consecLosses++;
            if (consecLosses >= 3) { pauseUntil = now + PAUSE_MS; consecLosses = 0; }
          } else {
            consecLosses = 0;
          }
        }
      }
    }

    const finalRate = execPriceAt(c15[c15.length-1].t, c15[c15.length-1].c);
    const finalBtc = mode === "BTC" ? btcQty : altQty * finalRate;
    return (finalBtc - 1.0) * 100;
  }

  const SYMS = ["DOGEBTC", "MATICBTC", "UNIBTC", "NEARBTC", "AAVEBTC", "TRXBTC", "XLMBTC", "ICPBTC", "APTBTC", "SUIBTC"];
  const INTERVALS = ["4h", "12h", "1d"];

  const years = periods.map(p => p.label);
  const col = (s: string) => s.padStart(10);

  const printRow = (name: string, rets: number[]) => {
    const valid = rets.filter(r => !isNaN(r));
    const compound = valid.reduce((a, r) => a * (1 + r / 100), 1.0);
    const total = (compound - 1) * 100;
    const worst = valid.length ? Math.min(...valid) : NaN;
    const flag = valid.every(r => r >= 0) ? " ✓" : "";
    const cols = rets.map(r => isNaN(r) ? "       n/a" : ((r >= 0 ? "+" : "") + r.toFixed(1) + "%").padStart(10));
    console.log(`  ${name.padEnd(18)}${cols.join("")}${((total >= 0 ? "+" : "") + total.toFixed(0) + "%").padStart(11)}${((worst >= 0 ? "+" : "") + worst.toFixed(1) + "%").padStart(9)}${flag}`);
  };

  for (const sym of SYMS) {
    console.log(`\n${"═".repeat(88)}`);
    console.log(`  THE SURFER | ${sym} | RSI 30/70 | 15m | Binance.US — MA interval sweep (live real-time)`);
    console.log(`${"═".repeat(88)}\n`);

    const c15s: C[][] = [];
    for (const p of periods) {
      process.stdout.write(`  Fetching ${p.label} 15m...`);
      const c15 = await fetchKlines(sym, "15m", p.start, p.end, BASE_US);
      console.log(` ${c15.length}`);
      c15s.push(c15);
      await sleep(200);
    }

    console.log(`\n  ${"MA interval".padEnd(18)} ${years.map(col).join("")}  ${"5yr total".padStart(11)}  ${"Worst yr".padStart(9)}`);
    console.log(`  ${"─".repeat(18 + years.length * 10 + 22)}`);
    printRow("Hold " + sym.replace("BTC",""), c15s.map(c15 => c15.length < 2 ? NaN : (c15[c15.length-1].c / c15[0].c - 1) * 100));
    printRow("Hold BTC", periods.map(() => 0));
    console.log(`  ${"─".repeat(18 + years.length * 10 + 22)}`);

    for (const interval of INTERVALS) {
      const trendData: C[][] = [];
      for (const p of periods) {
        process.stdout.write(`  [${interval}] ${p.label}...`);
        const ct = await fetchKlines(sym, interval, p.start, p.end, BASE_US);
        console.log(` ${ct.length}`);
        trendData.push(ct);
        await sleep(150);
      }
      const rets = c15s.map((c15, i) =>
        c15.length < 2 || trendData[i].length < 2 ? NaN :
        runStrategy(c15, { use4h: trendData[i], rsiLow: 30, rsiHigh: 70, liveMode4h: true })
      );
      printRow(`MA ${interval}`, rets);
    }
  }

  console.log();
})();
