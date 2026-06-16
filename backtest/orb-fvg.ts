// Opening Range Breakout + Fair Value Gap (ICT strategy)
// 1. Mark high/low of first 5m candle at 9:30am ET (13:30 UTC)
// 2. On 1m chart, wait for break of range + Fair Value Gap (3-candle displacement)
// 3. Entry at close of 3rd FVG candle | SL at base of displacement candle | TP 2:1 RR
// One trade per day max | search window 9:35am–11:30am ET (13:35–15:30 UTC)
// Binance global 1m | 2 weeks | BTC, XRP, SOL
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_GL  = "https://data-api.binance.vision/api/v3";
const LOOKBACK = 14 * 24 * 60 * 60 * 1000;
const ALLOC    = 25;
const COINS    = ["BTCUSDT","XRPUSDT","SOLUSDT"];

type C = { t: number; o: number; h: number; l: number; c: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string): Promise<C[]> {
  const out: C[] = [];
  let from = Date.now() - LOOKBACK;
  while (from < Date.now()) {
    const res = await fetch(`${BASE_GL}/klines?symbol=${symbol}&interval=1m&startTime=${from}&limit=1000`);
    if (res.status === 429) { await sleep(5000); continue; }
    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) out.push({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4] });
    from = +raw[raw.length - 1][0] + 1;
    await sleep(80);
  }
  return out;
}

type Trade = { date: string; dir: string; entry: number; sl: number; tp: number; result: string; pnl: number; holdMin: number };

function sim(candles: C[]): Trade[] {
  const trades: Trade[] = [];
  // group by day
  const byDay = new Map<string, C[]>();
  for (const c of candles) {
    const d = new Date(c.t);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
    const arr = byDay.get(key) ?? [];
    arr.push(c);
    byDay.set(key, arr);
  }

  for (const [date, day] of byDay) {
    // 9:30am ET = 13:30 UTC. First 5m candle = candles at 13:30–13:34
    const orCandles = day.filter(c => {
      const h = new Date(c.t).getUTCHours(), m = new Date(c.t).getUTCMinutes();
      return h === 13 && m >= 30 && m <= 34;
    });
    if (orCandles.length < 3) continue;
    const orHigh = Math.max(...orCandles.map(c => c.h));
    const orLow  = Math.min(...orCandles.map(c => c.l));

    // search window: 13:35–15:30 UTC (9:35–11:30am ET)
    const window = day.filter(c => {
      const h = new Date(c.t).getUTCHours(), m = new Date(c.t).getUTCMinutes();
      return (h === 13 && m >= 35) || (h === 14) || (h === 15 && m <= 30);
    });

    let traded = false;
    for (let i = 1; i < window.length - 3 && !traded; i++) {
      const prev = window[i-1], cur = window[i], next = window[i+1];
      if (!next) continue;

      // BULLISH: displacement candle closes above OR high + FVG (prev.high < next.low)
      if (cur.c > orHigh && prev.h < next.l) {
        const entry = next.c;                  // enter at close of 3rd candle
        const sl    = cur.l;                   // SL at low of displacement candle
        const risk  = entry - sl;
        if (risk <= 0) continue;
        const tp = entry + 2 * risk;           // 2:1 RR
        const qty = ALLOC / entry;
        let result = "EXPIRE", exitPx = entry, holdMin = 0;
        for (let j = i+2; j < window.length; j++) {
          holdMin = (window[j].t - next.t) / 60000;
          if (window[j].l <= sl) { result = "SL"; exitPx = sl; break; }
          if (window[j].h >= tp) { result = "TP"; exitPx = tp; break; }
          if (holdMin >= 60) { result = "EXPIRE"; exitPx = window[j].c; break; }
        }
        trades.push({ date, dir: "LONG", entry, sl, tp, result, pnl: (exitPx - entry) * qty, holdMin: Math.round(holdMin) });
        traded = true;
      }
      // BEARISH: displacement candle closes below OR low + FVG (prev.l > next.h)
      else if (cur.c < orLow && prev.l > next.h) {
        const entry = next.c;
        const sl    = cur.h;                   // SL at high of displacement candle
        const risk  = sl - entry;
        if (risk <= 0) continue;
        const tp = entry - 2 * risk;           // 2:1 RR
        const qty = ALLOC / entry;
        let result = "EXPIRE", exitPx = entry, holdMin = 0;
        for (let j = i+2; j < window.length; j++) {
          holdMin = (window[j].t - next.t) / 60000;
          if (window[j].h >= sl) { result = "SL"; exitPx = sl; break; }
          if (window[j].l <= tp) { result = "TP"; exitPx = tp; break; }
          if (holdMin >= 60) { result = "EXPIRE"; exitPx = window[j].c; break; }
        }
        trades.push({ date, dir: "SHORT", entry, sl, tp, result, pnl: (entry - exitPx) * qty, holdMin: Math.round(holdMin) });
        traded = true;
      }
    }
  }
  return trades;
}

(async () => {
  console.log("\nORB + FAIR VALUE GAP | 9:30am ET open range | 1m | 2 weeks | 2:1 RR | $25\n");
  for (const coin of COINS) {
    process.stdout.write(`Fetching ${coin}...`);
    const candles = await fetchKlines(coin);
    console.log(` ${candles.length} candles`);
    const trades = sim(candles);
    const wins = trades.filter(t => t.result === "TP").length;
    const losses = trades.filter(t => t.result === "SL").length;
    const expires = trades.filter(t => t.result === "EXPIRE").length;
    const pnl = trades.reduce((a, t) => a + t.pnl, 0);
    console.log(`\n── ${coin} | ${trades.length} trades | TP:${wins} SL:${losses} EXP:${expires} | WR:${trades.length ? (wins/trades.length*100).toFixed(0) : 0}% | PnL: ${pnl>=0?"+":""}$${pnl.toFixed(2)} (${(pnl/ALLOC*100).toFixed(1)}%)\n`);
    console.log("Date        Dir    Entry       SL          TP          Result   Hold   PnL$");
    console.log("─".repeat(78));
    for (const t of trades) {
      console.log(
        `${t.date}  ${t.dir.padEnd(6)} ${t.entry.toFixed(4).padStart(10)}  ${t.sl.toFixed(4).padStart(10)}  ${t.tp.toFixed(4).padStart(10)}  ${t.result.padEnd(7)}  ${String(t.holdMin+"m").padStart(5)}  ${(t.pnl>=0?"+":"") + "$"+t.pnl.toFixed(3)}`
      );
    }
    console.log();
    await sleep(200);
  }
})();
