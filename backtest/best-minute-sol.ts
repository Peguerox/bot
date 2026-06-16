// Every 1m candle time of day → simulate TP/SL → rank by return on invested
// SOL | 1 month | Binance global | TP 0.20% SL 0.10% MAX_HOLD 6m
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_GL  = "https://data-api.binance.vision/api/v3";
const LOOKBACK = 30 * 24 * 60 * 60 * 1000;
const TP = 0.002, SL = 0.001, MAX_HOLD = 6;
const ALLOC = 25;

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

function simAllMinutes(candles: C[]) {
  // bucket candles by HH:MM
  const byTime = new Map<string, number[]>();
  for (let i = 0; i < candles.length - MAX_HOLD - 1; i++) {
    const d = new Date(candles[i].t);
    const key = `${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}`;
    const entry = candles[i].o;
    const tp = entry * (1 + TP), sl = entry * (1 - SL);
    let exitPx = candles[i + MAX_HOLD].c;
    for (let j = i + 1; j <= i + MAX_HOLD; j++) {
      if (candles[j].l <= sl) { exitPx = sl; break; }
      if (candles[j].h >= tp) { exitPx = tp; break; }
    }
    const pnlPct = (exitPx - entry) / entry * 100;
    const arr = byTime.get(key) ?? [];
    arr.push(pnlPct);
    byTime.set(key, arr);
  }

  return [...byTime.entries()].map(([time, results]) => {
    const wins = results.filter(p => p > 0).length;
    const pnl = results.reduce((a, b) => a + b, 0) / 100 * ALLOC;
    const retPct = pnl / (results.length * ALLOC) * 100;
    return { time, wins, losses: results.length - wins, trades: results.length, wr: wins / results.length * 100, retPct };
  }).sort((a, b) => b.retPct - a.retPct);
}

(async () => {
  console.log(`\nBEST MINUTE OF DAY | SOLUSDT | 1 month | TP ${TP*100}% SL ${SL*100}% MAX_HOLD ${MAX_HOLD}m\n`);
  process.stdout.write("Fetching SOLUSDT...");
  const candles = await fetchKlines("SOLUSDT");
  console.log(` ${candles.length} candles\n`);

  const ranked = simAllMinutes(candles);

  console.log("TOP 25 minutes by % return on invested:\n");
  console.log(`${"UTC".padEnd(6)} ${"ET".padEnd(8)} ${"W".padStart(4)} ${"L".padStart(4)} ${"WR%".padStart(6)} ${"Trades".padStart(7)} ${"Ret%".padStart(8)}`);
  console.log("─".repeat(48));
  for (const r of ranked.slice(0, 25)) {
    const [h, m] = r.time.split(":").map(Number);
    const et = `${String((h - 4 + 24) % 24).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
    console.log(
      r.time.padEnd(6) + (et + " ET").padEnd(9) +
      String(r.wins).padStart(4) + String(r.losses).padStart(5) +
      (r.wr.toFixed(0) + "%").padStart(6) +
      String(r.trades).padStart(7) +
      (r.retPct >= 0 ? "+" : "") + `${r.retPct.toFixed(3)}%`.padStart(8)
    );
  }

  console.log("\nBOTTOM 10 (worst minutes):\n");
  console.log(`${"UTC".padEnd(6)} ${"ET".padEnd(8)} ${"W".padStart(4)} ${"L".padStart(4)} ${"WR%".padStart(6)} ${"Trades".padStart(7)} ${"Ret%".padStart(8)}`);
  console.log("─".repeat(48));
  for (const r of ranked.slice(-10).reverse()) {
    const [h, m] = r.time.split(":").map(Number);
    const et = `${String((h - 4 + 24) % 24).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
    console.log(
      r.time.padEnd(6) + (et + " ET").padEnd(9) +
      String(r.wins).padStart(4) + String(r.losses).padStart(5) +
      (r.wr.toFixed(0) + "%").padStart(6) +
      String(r.trades).padStart(7) +
      (r.retPct >= 0 ? "+" : "") + `${r.retPct.toFixed(3)}%`.padStart(8)
    );
  }
  console.log();
})();
