/**
 * Liquidation Bounce Backtest
 * Detects likely liquidation cascades from BTC 5m spot data:
 *   - BTC drops > X% in one candle  (forced sells = market orders)
 *   - Volume spikes > N× rolling average  (all those liquidations hitting book)
 * Then buys the next candle and looks for the bounce.
 * Maker limit orders, 0% fee.
 *
 * Run: npx ts-node --transpile-only backtest/liq-bounce.ts
 */

const BINANCE_BASE = "https://api.binance.us/api/v3";
const BINANCE_KEY  = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS  = 365 * 24 * 60 * 60 * 1000; // 1 year
const ALLOCATION   = 1000;
const VOL_WINDOW   = 20; // rolling average volume window

// Grids to sweep
const DROP_THRESHOLDS = [0.003, 0.005, 0.008, 0.010]; // 0.3%, 0.5%, 0.8%, 1.0%
const VOL_MULTIPLIERS = [1.5, 2.0, 3.0];
const TP_PCT          = 0.005; // 0.5% — fixed for now
const SL_PCT          = 0.003; // 0.3%
const MAX_HOLD        = 6;     // candles (30 min at 5m)

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAllKlines(symbol: string, interval: string, startMs: number, endMs: number) {
  const candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  let from = startMs;
  while (from < endMs) {
    const url = `${BINANCE_BASE}/klines?symbol=${symbol}&interval=${interval}` +
                `&startTime=${from}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url, { headers: { "X-MBX-APIKEY": BINANCE_KEY } });
    if (res.status === 429) { await sleep(10_000); continue; }
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const raw = await res.json() as string[][];
    if (!raw.length) break;
    for (const c of raw) candles.push({
      time:   Number(c[0]),
      open:   parseFloat(c[1]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5]),
    });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(120);
  }
  return candles;
}

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

function runBacktest(candles: Candle[], dropThresh: number, volMult: number) {
  let pnl = 0, wins = 0, losses = 0, expires = 0;
  let grossWin = 0, grossLoss = 0;
  let peak = ALLOCATION, maxDD = 0, runBal = ALLOCATION;

  // rolling volume average
  const volBuf: number[] = [];
  let volSum = 0;

  let pos: { entry: number; tp: number; sl: number; hold: number } | null = null;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    // Update rolling volume
    volBuf.push(c.volume);
    volSum += c.volume;
    if (volBuf.length > VOL_WINDOW) volSum -= volBuf.shift()!;
    const volMean = volBuf.length === VOL_WINDOW ? volSum / VOL_WINDOW : null;

    // Manage open position (check high/low for TP/SL)
    if (pos) {
      pos.hold++;
      const hitTP  = c.high >= pos.tp;
      const hitSL  = c.low  <= pos.sl;
      const expired = pos.hold >= MAX_HOLD;

      if (hitTP || hitSL || expired) {
        const exitPrice = hitTP ? pos.tp : hitSL ? pos.sl : c.close;
        const tradePnl  = (exitPrice - pos.entry) / pos.entry * ALLOCATION;
        pnl    += tradePnl;
        runBal += tradePnl;

        if (hitTP)      { wins++;    grossWin  += tradePnl; }
        else if (hitSL) { losses++;  grossLoss += Math.abs(tradePnl); }
        else            { expires++; tradePnl > 0 ? grossWin += tradePnl : grossLoss += Math.abs(tradePnl); }

        if (runBal > peak) peak = runBal;
        const dd = (runBal - peak) / peak * 100;
        if (dd < maxDD) maxDD = dd;
        pos = null;
      }
    }

    // Look for cascade signal (only when flat, need next candle for entry)
    if (!pos && volMean !== null && i + 1 < candles.length) {
      const candleReturn = (c.close - c.open) / c.open; // negative = red candle
      const isDropped    = candleReturn <= -dropThresh;
      const isVolSpike   = c.volume >= volMult * volMean;

      if (isDropped && isVolSpike) {
        // Enter next candle open (maker limit at that price)
        const entry = candles[i + 1].open;
        pos = { entry, tp: entry * (1 + TP_PCT), sl: entry * (1 - SL_PCT), hold: 0 };
      }
    }
  }

  const trades = wins + losses + expires;
  const winRate = trades > 0 ? (wins / trades * 100).toFixed(1) : "0.0";
  const pf      = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : grossWin > 0 ? "∞" : "—";
  const tradesPerDay = (trades / 365).toFixed(1);

  return { pnl, trades, wins, losses, expires, winRate, pf, maxDD, tradesPerDay };
}

// After finding best combo, analyze what happens candle by candle after a cascade
function analyzePostCascade(candles: Candle[], dropThresh: number, volMult: number) {
  const volBuf: number[] = [];
  let volSum = 0;
  const returns: number[][] = []; // returns[N] = array of N-candle-forward returns

  for (let i = 0; i < candles.length - 7; i++) {
    const c = candles[i];
    volBuf.push(c.volume);
    volSum += c.volume;
    if (volBuf.length > VOL_WINDOW) volSum -= volBuf.shift()!;
    if (volBuf.length < VOL_WINDOW) continue;

    const volMean      = volSum / VOL_WINDOW;
    const candleReturn = (c.close - c.open) / c.open;

    if (candleReturn <= -dropThresh && c.volume >= volMult * volMean) {
      const entryPrice = candles[i + 1].open;
      const fwdReturns: number[] = [];
      for (let n = 1; n <= 6; n++) {
        if (i + 1 + n < candles.length) {
          fwdReturns.push((candles[i + 1 + n].close - entryPrice) / entryPrice * 100);
        }
      }
      returns.push(fwdReturns);
    }
  }

  console.log(`\n── What happens after the cascade? (${returns.length} events) ──`);
  console.log(`Candle  Avg Return  % Positive  Avg If Positive  Avg If Negative`);
  for (let n = 0; n < 6; n++) {
    const col  = returns.map(r => r[n]).filter(v => v !== undefined);
    if (!col.length) continue;
    const avg  = col.reduce((a, b) => a + b, 0) / col.length;
    const pos  = col.filter(v => v > 0);
    const neg  = col.filter(v => v <= 0);
    const posAvg = pos.length > 0 ? pos.reduce((a, b) => a + b, 0) / pos.length : 0;
    const negAvg = neg.length > 0 ? neg.reduce((a, b) => a + b, 0) / neg.length : 0;
    const posPct = (pos.length / col.length * 100).toFixed(0);
    console.log(
      `+${n + 1}      ${(avg >= 0 ? "+" : "") + avg.toFixed(3)}%     ${posPct}% up      ${posAvg >= 0 ? "+" : ""}${posAvg.toFixed(3)}%          ${negAvg.toFixed(3)}%`
    );
  }
}

async function main() {
  const now = Date.now(), startMs = now - LOOKBACK_MS;

  console.log("\nLiquidation Bounce Backtest — 1 year BTCUSDT 5m");
  console.log("Signal: BTC drops > X% on volume spike > N× avg → buy bounce\n");

  process.stdout.write("Fetching BTCUSDT 5m (1 year)...");
  const btcCandles = await fetchAllKlines("BTCUSDT", "5m", startMs, now);
  process.stdout.write(` ${btcCandles.length} candles\n\n`);

  // ── Grid sweep ──────────────────────────────────────────────────────────────
  console.log("╔══════════╦══════════╦════════╦════════╦══════════╦══════╦════════╦══════════╦══════════╗");
  console.log("║   Drop   ║  VolMult ║ Trades ║ /day   ║  Win Rate║  PF  ║ MaxDD% ║  PnL($)  ║ Verdict  ║");
  console.log("╠══════════╬══════════╬════════╬════════╬══════════╬══════╬════════╬══════════╬══════════╣");

  let best = { pnl: -Infinity, drop: 0, vol: 0 };

  for (const drop of DROP_THRESHOLDS) {
    for (const vol of VOL_MULTIPLIERS) {
      const r = runBacktest(btcCandles, drop, vol);
      if (r.pnl > best.pnl) best = { pnl: r.pnl, drop, vol };

      const verdict = r.pnl > 200 && parseFloat(r.pf) > 1.5 ? "✓ Edge"   :
                      r.pnl > 0                               ? "~ Marginal" : "✗ No edge";

      console.log(
        `║ ${`>${(drop*100).toFixed(1)}%`.padEnd(8)} ║ ${`${vol}×`.padEnd(8)} ║ ` +
        `${String(r.trades).padStart(6)} ║ ${r.tradesPerDay.padStart(6)} ║ ` +
        `${`${r.winRate}%`.padStart(8)} ║ ${r.pf.padStart(4)} ║ ` +
        `${`${r.maxDD.toFixed(1)}%`.padStart(6)} ║ ` +
        `${`${r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(0)}`.padStart(8)} ║ ${verdict.padEnd(8)} ║`
      );
    }
  }

  console.log("╚══════════╩══════════╩════════╩════════╩══════════╩══════╩════════╩══════════╩══════════╝");

  // ── Post-cascade analysis with best params ──────────────────────────────────
  console.log(`\n★  Best combo: drop>${(best.drop*100).toFixed(1)}%  vol>${best.vol}×avg`);
  analyzePostCascade(btcCandles, best.drop, best.vol);

  // ── Also check: is it better to trade BNB/ATOM on BTC cascade? ─────────────
  console.log("\n── Does the BTC cascade predict bounce on alts? ──");
  for (const sym of ["BNBUSDT", "ATOMUSDT"]) {
    process.stdout.write(`  Fetching ${sym} 5m...`);
    const altCandles = await fetchAllKlines(sym, "5m", startMs, now);
    process.stdout.write(` ${altCandles.length} candles\n`);

    // Build alt map by time
    const altMap = new Map(altCandles.map(c => [c.time, c]));

    // Find BTC cascade moments, check alt price forward
    const volBuf: number[] = [];
    let volSum = 0;
    let hits = 0, sumReturn1 = 0, sumReturn3 = 0;

    for (let i = VOL_WINDOW; i < btcCandles.length - 4; i++) {
      const c = btcCandles[i];
      volBuf.push(c.volume);
      volSum += c.volume;
      if (volBuf.length > VOL_WINDOW) volSum -= volBuf.shift()!;
      const volMean = volSum / VOL_WINDOW;

      const candleReturn = (c.close - c.open) / c.open;
      if (candleReturn <= -best.drop && c.volume >= best.vol * volMean) {
        const nextBtcTime = btcCandles[i + 1]?.time;
        const altEntry    = altMap.get(nextBtcTime);
        const alt3        = altMap.get(btcCandles[i + 3]?.time);
        const alt4        = altMap.get(btcCandles[i + 4]?.time);
        if (altEntry && alt3) {
          hits++;
          sumReturn1 += (altEntry.close - altEntry.open) / altEntry.open * 100;
          sumReturn3 += (alt3.close - altEntry.open) / altEntry.open * 100;
        }
      }
    }

    if (hits > 0) {
      console.log(`  ${sym}: ${hits} cascade events | avg +1 candle: ${(sumReturn1/hits).toFixed(3)}% | avg +3 candles: ${(sumReturn3/hits).toFixed(3)}%`);
    }
  }
}

main().catch(console.error);
