// EMA gate on existing lag signal: global ≥0.10% ahead of US last price → buy BTC on US
// Gate: only trade when fast EMA > slow EMA on BTC (Binance.US 5m)
// Tests multiple EMA pairs to find the best filter
// Strict fills, TP 0.10%, SL 0.10%, MAX_HOLD 6m, $25, US working hours 13:00-20:00 UTC
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US  = "https://api.binance.us/api/v3";
const BASE_GL  = "https://data-api.binance.vision/api/v3";
const KEY      = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK = 30 * 24 * 60 * 60 * 1000;  // 30 days (enough history)
const GL_THRESH = 0.001, TP = 0.001, SL = 0.001, MAX_HOLD = 6;
const ALLOC = 25;
const EMA_PAIRS: [number, number][] = [[9,21],[12,26],[20,50]];

type C1 = { t: number; o: number; h: number; l: number; c: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(base: string, symbol: string, interval: string): Promise<C1[]> {
  const out: C1[] = [];
  let from = Date.now() - LOOKBACK;
  while (from < Date.now()) {
    const url = `${base}/klines?symbol=${symbol}&interval=${interval}&startTime=${from}&limit=1000`;
    const res = await fetch(url, base === BASE_US ? { headers: { "X-MBX-APIKEY": KEY } } : {});
    if (res.status === 429) { await sleep(5000); continue; }
    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) out.push({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4] });
    from = +raw[raw.length - 1][0] + 1;
    await sleep(100);
  }
  return out;
}

function ema(candles: C1[], period: number): number[] {
  const k = 2 / (period + 1), out: number[] = [];
  out[0] = candles[0].c;
  for (let i = 1; i < candles.length; i++) out[i] = candles[i].c * k + out[i-1] * (1 - k);
  return out;
}

// build EMA gate lookup: for each 1m timestamp, is fast > slow on 5m?
function buildGate(candles5m: C1[], fast: number, slow: number): Set<number> {
  const f = ema(candles5m, fast), s = ema(candles5m, slow);
  const open = new Set<number>();
  for (let i = 0; i < candles5m.length; i++) {
    if (f[i] > s[i]) {
      // gate open for all 1m candles within this 5m bar
      for (let m = 0; m < 5; m++) open.add(candles5m[i].t + m * 60000);
    }
  }
  return open;
}

function sim(us1m: C1[], gl1m: C1[], gate: Set<number> | null): { n: number; wins: number; pnl: number } {
  const glMap = new Map(gl1m.map(c => [c.t, c]));
  let n = 0, wins = 0, pnl = 0, i = 1;
  while (i < us1m.length - MAX_HOLD - 1) {
    const c = us1m[i], prev = us1m[i-1];
    const gl = glMap.get(c.t);
    if (!gl) { i++; continue; }
    const glPrev = glMap.get(prev.t);
    if (!glPrev) { i++; continue; }
    const spread = (gl.c - c.c) / c.c;
    const glRet  = (gl.c - glPrev.c) / glPrev.c;
    const usRet  = (c.c - prev.c) / prev.c;
    const hourUTC = new Date(c.t).getUTCHours();
    const inWindow = hourUTC >= 13 && hourUTC < 20;
    const signal = spread >= GL_THRESH && glRet > 0 && usRet < glRet && inWindow;
    const gateOpen = gate === null || gate.has(c.t);
    if (!signal || !gateOpen) { i++; continue; }
    const entry = us1m[i+1].o;
    const tp = entry * (1 + TP), sl = entry * (1 - SL);
    let result = "EXPIRE", hold = MAX_HOLD, exitPx = us1m[i + MAX_HOLD].c;
    for (let j = i+1; j <= i + MAX_HOLD; j++) {
      const x = us1m[j];
      if (x.l <= sl) { result = "SL"; hold = j-i; exitPx = sl; break; }
      if (x.h >= tp) { result = "TP"; hold = j-i; exitPx = tp; break; }
    }
    n++; if (result === "TP") wins++;
    pnl += (exitPx - entry) / entry * ALLOC;
    i += hold + 1;
  }
  return { n, wins, pnl };
}

(async () => {
  console.log("\nEMA GATE TEST — lag signal + EMA trend filter | 30d | BTC US vs Global | $25\n");
  process.stdout.write("Fetching US 1m...");
  const us1m = await fetchKlines(BASE_US, "BTCUSDT", "1m");
  process.stdout.write(` ${us1m.length} | Fetching Global 1m...`);
  const gl1m = await fetchKlines(BASE_GL, "BTCUSDT", "1m");
  process.stdout.write(` ${gl1m.length} | Fetching US 5m...`);
  const us5m = await fetchKlines(BASE_US, "BTCUSDT", "5m");
  console.log(` ${us5m.length}\n`);

  console.log(`${"Filter".padEnd(16)} ${"Trades".padStart(7)} ${"WR%".padStart(6)} ${"PnL$".padStart(8)} ${"Ret%".padStart(8)}`);
  console.log("─".repeat(50));

  // baseline: no gate
  const base = sim(us1m, gl1m, null);
  console.log(
    "No gate".padEnd(16) +
    String(base.n).padStart(7) +
    (base.n ? (base.wins/base.n*100).toFixed(0).padStart(5)+"%" : "     -") +
    (base.pnl>=0?"+":"") + `$${base.pnl.toFixed(2)}`.padStart(7) +
    (base.pnl>=0?"+":"") + `${(base.pnl/ALLOC*100).toFixed(1)}%`.padStart(8)
  );

  for (const [fast, slow] of EMA_PAIRS) {
    const gate = buildGate(us5m, fast, slow);
    const r = sim(us1m, gl1m, gate);
    console.log(
      `EMA ${fast}/${slow} (5m)`.padEnd(16) +
      String(r.n).padStart(7) +
      (r.n ? (r.wins/r.n*100).toFixed(0).padStart(5)+"%" : "     -") +
      (r.pnl>=0?"+":"") + `$${r.pnl.toFixed(2)}`.padStart(7) +
      (r.pnl>=0?"+":"") + `${(r.pnl/ALLOC*100).toFixed(1)}%`.padStart(8)
    );
  }
  console.log();
})();
