// EUR/USD as macro signal → buy crypto
// Theory A: EUR rises (dollar weakens) → buy crypto (risk-on)
// Theory B: EUR drops (dollar strengthens) → buy crypto (mean reversion / oversold)
// Signal threshold 0.02% (EUR moves slowly vs crypto), TP 0.20%, SL 0.10%, MAX_HOLD 6m
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_GL   = "https://data-api.binance.vision/api/v3";
const LOOKBACK  = 7 * 24 * 60 * 60 * 1000;
const EUR_THRESH = 0.0002;  // 0.02% EUR/USD move
const TP = 0.002, SL = 0.001, MAX_HOLD = 6;
const ALLOC = 25;
const COINS = ["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","DOGEUSDT","BNBUSDT"];

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

function align(signal: C[], target: C[]): [C, C][] {
  const tMap = new Map(target.map(c => [c.t, c]));
  return signal.map(s => [s, tMap.get(s.t)!]).filter(([, t]) => t != null) as [C, C][];
}

function sim(pairs: [C, C][], direction: "up" | "down"): { win: boolean; pnl: number } [] {
  const trades: { win: boolean; pnl: number }[] = [];
  let i = 1;
  while (i < pairs.length - MAX_HOLD - 1) {
    const [ePrev] = pairs[i - 1];
    const [eNow]  = pairs[i];
    const eurRet = (eNow.c - ePrev.c) / ePrev.c;
    const triggered = direction === "up" ? eurRet >= EUR_THRESH : eurRet <= -EUR_THRESH;
    if (!triggered) { i++; continue; }
    const [, coin] = pairs[i + 1];
    const entry = coin.o;
    const tp = entry * (1 + TP), sl = entry * (1 - SL);
    let result = "EXPIRE", hold = MAX_HOLD, exitPx = pairs[i + MAX_HOLD][1].c;
    for (let j = i + 1; j <= i + MAX_HOLD; j++) {
      const [, c] = pairs[j];
      if (c.l <= sl) { result = "SL"; hold = j - i; exitPx = sl; break; }
      if (c.h >= tp) { result = "TP"; hold = j - i; exitPx = tp; break; }
    }
    trades.push({ win: result === "TP", pnl: (exitPx - entry) / entry * ALLOC });
    i += hold + 1;
  }
  return trades;
}

(async () => {
  console.log(`\nEUR/USD MACRO SIGNAL → BUY CRYPTO | 1 week | TP ${TP*100}% SL ${SL*100}% | EUR thresh ±${EUR_THRESH*100}%\n`);
  process.stdout.write("Fetching EURUSDT...");
  const eur = await fetchKlines("EURUSDT");
  console.log(` ${eur.length} candles\n`);

  console.log(`${"Coin".padEnd(12)} ${"Dir".padEnd(6)} ${"Trades".padStart(7)} ${"WR%".padStart(6)} ${"PnL$".padStart(8)} ${"Ret%".padStart(8)}`);
  console.log("─".repeat(52));

  for (const coin of COINS) {
    const candles = await fetchKlines(coin);
    const pairs = align(eur, candles);
    for (const dir of ["up", "down"] as const) {
      const trades = sim(pairs, dir);
      const wins = trades.filter(t => t.win).length;
      const pnl = trades.reduce((a, t) => a + t.pnl, 0);
      const label = dir === "up" ? "EUR↑" : "EUR↓";
      console.log(
        coin.padEnd(12) + label.padEnd(6) +
        String(trades.length).padStart(7) +
        (trades.length ? (wins / trades.length * 100).toFixed(0).padStart(5) + "%" : "     -") +
        (pnl >= 0 ? "+" : "") + `$${pnl.toFixed(2)}`.padStart(7) +
        (pnl >= 0 ? "+" : "") + `${(pnl / ALLOC * 100).toFixed(1)}%`.padStart(8)
      );
    }
    await sleep(150);
  }
  console.log();
})();
