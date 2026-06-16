// BTC global jumps ≥0.10% → buy altcoin on global. Does BTC momentum pull alts up?
// Signal: BTC 1m candle closes up ≥0.10% → buy ALT at next candle open
// TP 0.10% | SL 0.10% | MAX_HOLD 6 candles
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_GL   = "https://data-api.binance.vision/api/v3";
const LOOKBACK  = 7 * 24 * 60 * 60 * 1000;
const GL_THRESH = 0.001, TP = 0.005, SL = 0.001, MAX_HOLD = 6;
const ALLOC     = 25;
const ALTS      = ["XRPUSDT"];

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

// align alt candles to BTC by timestamp
function align(btc: C[], alt: C[]): [C, C][] {
  const altMap = new Map(alt.map(c => [c.t, c]));
  return btc.map(b => [b, altMap.get(b.t)!]).filter(([, a]) => a != null) as [C, C][];
}

function sim(pairs: [C, C][]): { win: boolean; pnl: number; hold: number; t: number }[] {
  const trades: { win: boolean; pnl: number; hold: number; t: number }[] = [];
  let i = 1;
  while (i < pairs.length - MAX_HOLD - 1) {
    const [btcPrev] = pairs[i - 1];
    const [btcNow]  = pairs[i];
    const btcRet = (btcNow.c - btcPrev.c) / btcPrev.c;
    if (btcRet > -GL_THRESH) { i++; continue; }  // BTC drops ≥0.10%
    const [, altEntry] = pairs[i + 1];
    const entry = altEntry.o;
    const tp = entry * (1 + TP), sl = entry * (1 - SL);
    let result = "EXPIRE", hold = MAX_HOLD, exitPx = pairs[i + MAX_HOLD][1].c;
    for (let j = i + 1; j <= i + MAX_HOLD; j++) {
      const [, a] = pairs[j];
      if (a.l <= sl) { result = "SL"; hold = j - i; exitPx = sl; break; }
      if (a.h >= tp) { result = "TP"; hold = j - i; exitPx = tp; break; }
    }
    trades.push({ win: result === "TP", pnl: (exitPx - entry) / entry * ALLOC, hold, t: pairs[i][0].t });
    i += hold + 1;
  }
  return trades;
}

(async () => {
  console.log(`\nBTC DROP ≥0.10% → BUY ALT | Binance Global 1m | 2 weeks | TP ${TP*100}% SL ${SL*100}% | MAX_HOLD ${MAX_HOLD}m | $${ALLOC}\n`);
  process.stdout.write("Fetching BTCUSDT (signal)...");
  const btc = await fetchKlines("BTCUSDT");
  console.log(` ${btc.length} candles`);

  const results: { coin: string; n: number; wr: number; pnl: number; perDay: number; avgHold: number }[] = [];

  for (const coin of ALTS) {
    process.stdout.write(`Fetching ${coin}...`);
    const alt = await fetchKlines(coin);
    const pairs = align(btc, alt);
    const trades = sim(pairs);
    const wins = trades.filter(t => t.win).length;
    const pnl  = trades.reduce((a, t) => a + t.pnl, 0);
    const avgHold = trades.length ? trades.reduce((a, t) => a + t.hold, 0) / trades.length : 0;
    results.push({ coin, n: trades.length, wr: wins / trades.length * 100, pnl, perDay: trades.length / (LOOKBACK / 86400000), avgHold });
    console.log(` ${trades.length} trades | ${(wins/trades.length*100).toFixed(0)}% WR | ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`);

    // monthly breakdown
    const byMonth = new Map<string, { n: number; w: number; pnl: number }>();
    for (const t of trades) {
      const d = new Date(t.t); const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
      const m = byMonth.get(k) ?? { n: 0, w: 0, pnl: 0 };
      m.n++; if (t.win) m.w++; m.pnl += t.pnl; byMonth.set(k, m);
    }
    console.log("  Month     Trades  WR%     PnL$    Ret%");
    for (const [k, m] of [...byMonth.entries()].sort()) {
      console.log(`  ${k}  ${String(m.n).padStart(6)}  ${(m.w/m.n*100).toFixed(0).padStart(3)}%  ${(m.pnl>=0?"+":"")}$${m.pnl.toFixed(2).padStart(6)}  ${(m.pnl>=0?"+":"")}${(m.pnl/ALLOC*100).toFixed(1)}%`);
    }
    await sleep(200);
  }

  console.log(`\n${"Alt".padEnd(12)} ${"Trades".padStart(7)} ${"T/day".padStart(7)} ${"WR%".padStart(6)} ${"AvgHold".padStart(9)} ${"PnL$".padStart(9)} ${"Ret%".padStart(8)}`);
  console.log("─".repeat(65));
  for (const r of results.sort((a, b) => b.pnl - a.pnl)) {
    console.log(
      r.coin.padEnd(12) +
      String(r.n).padStart(7) +
      r.perDay.toFixed(1).padStart(7) +
      r.wr.toFixed(0).padStart(5) + "%" +
      (r.avgHold.toFixed(1) + "m").padStart(9) +
      (r.pnl >= 0 ? "+" : "") + `$${r.pnl.toFixed(2)}`.padStart(8) +
      (r.pnl >= 0 ? "+" : "") + `${(r.pnl / ALLOC * 100).toFixed(1)}%`.padStart(8)
    );
  }
  console.log();
})();
