/**
 * Bollinger Bands + RSI mean reversion — Binance.US 5m, 6 months
 * Signal: price closes at/below lower BB AND RSI ≤ 30
 * Entry:  same candle close
 * TP:     fixed % levels + middle band (MA20)
 * SL:     2%
 */

const BASE     = "https://api.binance.us/api/v3";
const BB_PER   = 20;
const BB_STD   = 2;
const RSI_PER  = 14;
const RSI_SIG  = 30;
const SL_PCT   = 0.02;
const MAX_HOLD = 200;
const ALLOC    = 50;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchCandles(symbol: string, startMs: number) {
  const out: { time: number; high: number; low: number; close: number; volume: number }[] = [];
  let from = startMs;
  const end = Date.now();
  while (from < end) {
    const res = await fetch(`${BASE}/klines?symbol=${symbol}&interval=5m&startTime=${from}&endTime=${end}&limit=1000`);
    if (res.status === 429) { await sleep(10000); continue; }
    const raw = await res.json() as string[][];
    if (!raw.length) break;
    for (const c of raw) out.push({
      time:   Number(c[0]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5]),
    });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(200);
  }
  return out;
}

function calcRSI(closes: number[], i: number): number {
  if (i < RSI_PER) return 50;
  let gains = 0, losses = 0;
  for (let j = i - RSI_PER + 1; j <= i; j++) {
    const diff = closes[j] - closes[j - 1];
    if (diff >= 0) gains  += diff;
    else           losses -= diff;
  }
  const avgGain = gains  / RSI_PER;
  const avgLoss = losses / RSI_PER;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcBB(closes: number[], i: number) {
  if (i < BB_PER - 1) return null;
  const slice = closes.slice(i - BB_PER + 1, i + 1);
  const mean  = slice.reduce((a, b) => a + b, 0) / BB_PER;
  const std   = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / BB_PER);
  return { upper: mean + BB_STD * std, middle: mean, lower: mean - BB_STD * std };
}

function run(closes: number[], TP_PCT: number | "middle") {
  let pnl = 0, wins = 0, losses = 0, gw = 0, gl = 0;
  let bal = ALLOC, peak = ALLOC, maxDD = 0;
  type Pos = { entry: number; tp: number | null; sl: number; hold: number };
  let pos: Pos | null = null;

  const close = (tradePnl: number) => {
    pnl += tradePnl; bal += tradePnl;
    if (tradePnl >= 0) { wins++; gw += tradePnl; }
    else               { losses++; gl += Math.abs(tradePnl); }
    if (bal > peak) peak = bal;
    const dd = (bal - peak) / peak * 100;
    if (dd < maxDD) maxDD = dd;
    pos = null;
  };

  for (let i = Math.max(BB_PER, RSI_PER); i < closes.length; i++) {
    const price = closes[i];
    const bb    = calcBB(closes, i);
    const rsi   = calcRSI(closes, i);
    if (!bb) continue;

    if (pos) {
      pos.hold++;
      const tp = pos.tp ?? bb.middle;
      if (price >= tp) {
        close((tp - pos.entry) / pos.entry * ALLOC);
      } else if (price <= pos.sl) {
        close((pos.sl - pos.entry) / pos.entry * ALLOC);
      } else if (pos.hold >= MAX_HOLD) {
        close((price - pos.entry) / pos.entry * ALLOC);
      }
      continue;
    }

    if (price <= bb.lower && rsi <= RSI_SIG) {
      const tp = TP_PCT === "middle" ? null : price * (1 + (TP_PCT as number));
      pos = { entry: price, tp, sl: price * (1 - SL_PCT), hold: 0 };
    }
  }

  const trades = wins + losses;
  const wr = trades > 0 ? (wins / trades * 100).toFixed(1) : "0";
  const pf = gl > 0 ? (gw / gl).toFixed(2) : "∞";
  return { pnl, trades, wr, pf, maxDD };
}

(async () => {
  const start = Date.now() - 180 * 24 * 60 * 60 * 1000;
  const TPS: (number | "middle")[] = [0.003, 0.005, 0.008, 0.010, 0.015, "middle"];

  for (const [label, symbol] of [["ZEC", "ZECUSDT"], ["XLM", "XLMUSDT"], ["BTC", "BTCUSDT"], ["SOL", "SOLUSDT"]]) {
    process.stdout.write(`Fetching ${label} 5m... `);
    const candles = await fetchCandles(symbol, start);
    console.log(`${candles.length} candles`);
    const closes = candles.map(c => c.close);

    console.log(`\n${label}/USDT · BB(${BB_PER},${BB_STD}) + RSI(${RSI_PER})≤${RSI_SIG} · SL ${SL_PCT*100}% · 5m · 6 months\n`);
    console.log(`  ${"TP".padEnd(10)} ${"PnL".padStart(9)} ${"Trades".padStart(7)} ${"WR".padStart(6)} ${"PF".padStart(6)} ${"MaxDD".padStart(8)}`);
    console.log("  " + "─".repeat(54));

    for (const tp of TPS) {
      const r = run(closes, tp);
      const tpLabel = tp === "middle" ? "Mid Band" : (tp * 100).toFixed(1) + "%";
      console.log(`  ${tpLabel.padEnd(10)} ${"$"+r.pnl.toFixed(2).padStart(8)} ${String(r.trades).padStart(7)} ${(r.wr+"%").padStart(6)} ${r.pf.padStart(6)} ${(r.maxDD.toFixed(1)+"%").padStart(8)}`);
    }
    console.log();
  }
})();
