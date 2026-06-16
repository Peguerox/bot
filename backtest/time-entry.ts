// Buy at specific 5m candle times every day, TP 0.20% SL 0.10% MAX_HOLD 6 candles
// Binance global, 2 weeks, BTC + SOL + BNB
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_GL  = "https://data-api.binance.vision/api/v3";
const LOOKBACK = 180 * 24 * 60 * 60 * 1000;
const TP = 0.002, SL = 0.001, MAX_HOLD = 6;
const ALLOC = 25;

// BTC best times: 22:10 (6:10pm ET) and 16:10 (12:10pm ET)
// XRP best times: 14:05 (10:05am ET) and 22:10 (6:10pm ET)
const COINS: [string, string[]][] = [
  ["XRPUSDT", ["14:05","22:10"]],
];

type C = { t: number; o: number; h: number; l: number; c: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string): Promise<C[]> {
  const out: C[] = [];
  let from = Date.now() - LOOKBACK;
  while (from < Date.now()) {
    const res = await fetch(`${BASE_GL}/klines?symbol=${symbol}&interval=5m&startTime=${from}&limit=1000`);
    if (res.status === 429) { await sleep(5000); continue; }
    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) out.push({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4] });
    from = +raw[raw.length - 1][0] + 1;
    await sleep(80);
  }
  return out;
}

function sim(candles: C[], timeUTC: string): { wins: number; losses: number; pnl: number; byMonth: Map<string, { w: number; l: number; pnl: number }> } {
  const [th, tm] = timeUTC.split(":").map(Number);
  let wins = 0, losses = 0, pnl = 0;
  const byMonth = new Map<string, { w: number; l: number; pnl: number }>();
  for (let i = 0; i < candles.length - MAX_HOLD - 1; i++) {
    const d = new Date(candles[i].t);
    if (d.getUTCHours() !== th || d.getUTCMinutes() !== tm) continue;
    const entry = candles[i].o;
    const tp = entry * (1 + TP), sl = entry * (1 - SL);
    let result = "EXPIRE", exitPx = candles[i + MAX_HOLD].c;
    for (let j = i + 1; j <= i + MAX_HOLD; j++) {
      if (candles[j].l <= sl) { result = "SL"; exitPx = sl; break; }
      if (candles[j].h >= tp) { result = "TP"; exitPx = tp; break; }
    }
    const tradePnl = (exitPx - entry) / entry * ALLOC;
    const mk = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
    const m = byMonth.get(mk) ?? { w: 0, l: 0, pnl: 0 };
    if (result === "TP") { wins++; m.w++; } else { losses++; m.l++; }
    pnl += tradePnl; m.pnl += tradePnl;
    byMonth.set(mk, m);
  }
  return { wins, losses, pnl, byMonth };
}

(async () => {
  console.log(`\nTIME-BASED ENTRY | 2 weeks | Binance Global 5m | TP ${TP*100}% SL ${SL*100}% MAX_HOLD ${MAX_HOLD*5}m | $${ALLOC}\n`);
  console.log(`${"Coin".padEnd(10)} ${"Time UTC".padEnd(10)} ${"ET".padEnd(8)} ${"W".padStart(4)} ${"L".padStart(4)} ${"WR%".padStart(6)} ${"PnL$".padStart(8)} ${"Ret%".padStart(8)}`);
  console.log("─".repeat(62));

  const totals: { coin: string; wins: number; losses: number; pnl: number }[] = [];

  for (const [coin, ENTRY_TIMES] of COINS) {
    const candles = await fetchKlines(coin);
    let coinWins = 0, coinLosses = 0, coinPnl = 0;
    for (const time of ENTRY_TIMES) {
      const r = sim(candles, time);
      const [h, m] = time.split(":").map(Number);
      const et = `${String((h-4+24)%24).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
      const n = r.wins + r.losses;
      coinWins += r.wins; coinLosses += r.losses; coinPnl += r.pnl;
      console.log(
        coin.padEnd(10) + time.padEnd(10) + (et+" ET").padEnd(8) +
        String(r.wins).padStart(4) + String(r.losses).padStart(5) +
        (n ? (r.wins/n*100).toFixed(0).padStart(5)+"%" : "     -") +
        (r.pnl>=0?"+":"") + `$${r.pnl.toFixed(2)}`.padStart(7) +
        (r.pnl>=0?"+":"") + `${(r.pnl/ALLOC*100).toFixed(1)}%`.padStart(8)
      );
      console.log("  Month      W   L   WR%    PnL$    Ret%");
      for (const [mk, m] of [...r.byMonth.entries()].sort()) {
        const mn = m.w + m.l;
        console.log(`  ${mk}   ${String(m.w).padStart(2)}  ${String(m.l).padStart(2)}  ${(m.w/mn*100).toFixed(0).padStart(3)}%  ${(m.pnl>=0?"+":"") + "$"+m.pnl.toFixed(2)}  ${(m.pnl>=0?"+":"")+(m.pnl/ALLOC*100).toFixed(1)}%`);
      }
    }
    totals.push({ coin, wins: coinWins, losses: coinLosses, pnl: coinPnl });
    console.log();
    await sleep(150);
  }

  console.log("── TOTAL PER COIN (all times combined) ──");
  console.log(`${"Coin".padEnd(10)} ${"W".padStart(4)} ${"L".padStart(4)} ${"WR%".padStart(6)} ${"PnL$".padStart(8)} ${"Ret%".padStart(8)}`);
  console.log("─".repeat(45));
  for (const t of totals.sort((a,b) => b.pnl - a.pnl)) {
    const n = t.wins + t.losses;
    console.log(
      t.coin.padEnd(10) +
      String(t.wins).padStart(4) + String(t.losses).padStart(5) +
      (t.wins/n*100).toFixed(0).padStart(5)+"%" +
      (t.pnl>=0?"+":"") + `$${t.pnl.toFixed(2)}`.padStart(7) +
      (t.pnl>=0?"+":"") + `${(t.pnl/ALLOC*100).toFixed(1)}%`.padStart(8)
    );
  }
  console.log();
})();
