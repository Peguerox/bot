// Live paper-trading arena — 7 strategies vs SOL/USDT simultaneously
// Each strategy gets $1000 virtual capital. Runs until you Ctrl+C.

import WebSocket from "ws";

const BASE    = "https://api.binance.us/api/v3";
const CAPITAL = 1000;
const FEE     = 0.001; // 0.1% per side (taker)

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type TF     = "1m" | "5m" | "15m" | "1h";

let livePrice = 0;
const startTime = Date.now();

// ── Indicators ────────────────────────────────────────────────────────────────

function calcEMA(vals: number[], p: number): number[] {
  const k = 2 / (p + 1);
  const out: number[] = new Array(vals.length).fill(NaN);
  if (vals.length < p) return out;
  out[p - 1] = vals.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < vals.length; i++) out[i] = vals[i] * k + out[i - 1] * (1 - k);
  return out;
}

function calcRSI(vals: number[], p = 14): number[] {
  const out: number[] = new Array(vals.length).fill(NaN);
  if (vals.length < p + 1) return out;
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) { const d = vals[i] - vals[i - 1]; d > 0 ? (ag += d) : (al -= d); }
  ag /= p; al /= p;
  out[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1];
    ag = (ag * (p - 1) + Math.max(d, 0)) / p;
    al = (al * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function calcBB(vals: number[], p = 20, mult = 2) {
  const upper: number[] = new Array(vals.length).fill(NaN);
  const mid: number[]   = new Array(vals.length).fill(NaN);
  const lower: number[] = new Array(vals.length).fill(NaN);
  for (let i = p - 1; i < vals.length; i++) {
    const sl = vals.slice(i - p + 1, i + 1);
    const m  = sl.reduce((a, b) => a + b, 0) / p;
    const sd = Math.sqrt(sl.reduce((a, b) => a + (b - m) ** 2, 0) / p);
    mid[i] = m; upper[i] = m + mult * sd; lower[i] = m - mult * sd;
  }
  return { upper, mid, lower };
}

function calcMACD(vals: number[]) {
  const fast = calcEMA(vals, 12);
  const slow = calcEMA(vals, 26);
  const line: number[] = vals.map((_, i) => isNaN(fast[i]) || isNaN(slow[i]) ? NaN : fast[i] - slow[i]);
  const firstV = line.findIndex(v => !isNaN(v));
  const sig: number[] = new Array(vals.length).fill(NaN);
  if (firstV >= 0 && vals.length - firstV >= 9) {
    const sl = calcEMA(line.slice(firstV), 9);
    sl.forEach((v, i) => (sig[firstV + i] = v));
  }
  const hist: number[] = vals.map((_, i) => isNaN(line[i]) || isNaN(sig[i]) ? NaN : line[i] - sig[i]);
  return { line, sig, hist };
}

// ── Strategy engine ───────────────────────────────────────────────────────────

type Strat = {
  name: string;
  tf: TF;
  pos: "flat" | "long";
  entry: number;
  cash: number;
  qty: number;
  trades: number;
  wins: number;
  sig: string;
  _armed?: boolean;
  equity(): number;
  pnlPct(): number;
  run(candles: Candle[], price: number): void;
};

function mkStrat(name: string, tf: TF, run: (s: Strat, c: Candle[], p: number) => void): Strat {
  const s: Strat = {
    name, tf, pos: "flat", entry: 0, cash: CAPITAL, qty: 0,
    trades: 0, wins: 0, sig: "waiting…",
    equity() {
      return this.pos === "long"
        ? this.qty * livePrice * (1 - FEE)
        : this.cash;
    },
    pnlPct() { return (this.equity() / CAPITAL - 1) * 100; },
    run(c, p) { run(this, c, p); },
  };
  return s;
}

function goLong(s: Strat, price: number, label: string) {
  if (s.pos !== "flat" || s.cash < 1) return;
  s.qty   = (s.cash * (1 - FEE)) / price;
  s.cash  = 0;
  s.entry = price;
  s.pos   = "long";
  s.sig   = `▲ BUY  @${price.toFixed(2)} (${label})`;
}

function goFlat(s: Strat, price: number, label: string) {
  if (s.pos !== "long") return;
  const out = s.qty * price * (1 - FEE);
  if (out > s.entry * (s.qty / (1 - FEE))) s.wins++;
  s.cash  = out;
  s.qty   = 0;
  s.trades++;
  s.pos   = "flat";
  s.sig   = `▼ SELL @${price.toFixed(2)} (${label})`;
}

// ── 7 Strategies ──────────────────────────────────────────────────────────────

const strategies: Strat[] = [

  // 1. RSI Scalp — buy when RSI crosses up through 30, sell above 70
  mkStrat("RSI Scalp", "1m", (s, c, p) => {
    const rsi  = calcRSI(c.map(x => x.close));
    const cur  = rsi[rsi.length - 1], prev = rsi[rsi.length - 2];
    if (isNaN(cur) || isNaN(prev)) return;
    if (s.pos === "flat" && prev < 30 && cur >= 30) goLong(s, p, "RSI cross 30");
    if (s.pos === "long" && cur > 70) goFlat(s, p, "RSI > 70");
  }),

  // 2. EMA Cross — EMA7 crosses EMA25 (5m)
  mkStrat("EMA Cross", "5m", (s, c, p) => {
    const cl  = c.map(x => x.close);
    const e7  = calcEMA(cl, 7), e25 = calcEMA(cl, 25);
    const i   = cl.length - 1;
    if (isNaN(e7[i]) || isNaN(e25[i]) || isNaN(e7[i-1]) || isNaN(e25[i-1])) return;
    const bull = e7[i] > e25[i], prevBull = e7[i-1] > e25[i-1];
    if (s.pos === "flat" && !prevBull && bull) goLong(s, p, "EMA cross up");
    if (s.pos === "long" && prevBull && !bull) goFlat(s, p, "EMA cross down");
  }),

  // 3. Bollinger Bounce — buy below lower band, sell above upper or at mid
  mkStrat("BB Bounce", "5m", (s, c, p) => {
    const cl          = c.map(x => x.close);
    const { upper, mid, lower } = calcBB(cl, 20, 2);
    const i           = cl.length - 1;
    if (isNaN(lower[i])) return;
    if (s.pos === "flat" && cl[i] < lower[i]) goLong(s, p, "below BB lower");
    if (s.pos === "long" && cl[i] > upper[i]) goFlat(s, p, "above BB upper");
    if (s.pos === "long" && p > mid[i] && p > s.entry * 1.004) goFlat(s, p, "BB mid TP");
    if (s.pos === "long" && p < s.entry * 0.985) goFlat(s, p, "SL -1.5%");
  }),

  // 4. MACD — histogram flips positive/negative (15m)
  mkStrat("MACD", "15m", (s, c, p) => {
    const { hist } = calcMACD(c.map(x => x.close));
    const i        = hist.length - 1;
    if (isNaN(hist[i]) || isNaN(hist[i-1])) return;
    if (s.pos === "flat" && hist[i-1] < 0 && hist[i] >= 0) goLong(s, p, "MACD flip +");
    if (s.pos === "long" && hist[i-1] > 0 && hist[i] <= 0) goFlat(s, p, "MACD flip −");
  }),

  // 5. VWAP Reversion — fade 0.5% deviation from session VWAP (1m)
  mkStrat("VWAP Revert", "1m", (s, c, p) => {
    const recent  = c.slice(-120); // last 2h of 1m candles
    const totVol  = recent.reduce((a, x) => a + x.volume, 0);
    if (totVol === 0) return;
    const vwap    = recent.reduce((a, x) => a + ((x.high + x.low + x.close) / 3) * x.volume, 0) / totVol;
    const dev     = (p - vwap) / vwap;
    if (s.pos === "flat" && dev < -0.005) goLong(s, p, `VWAP dev ${(dev*100).toFixed(2)}%`);
    if (s.pos === "long" && dev >= 0)     goFlat(s, p, "returned to VWAP");
    if (s.pos === "long" && p < s.entry * 0.99) goFlat(s, p, "SL -1%");
  }),

  // 6. Momentum — EMA21 direction + RSI(7) momentum cross (1m)
  mkStrat("Momentum", "1m", (s, c, p) => {
    const cl   = c.map(x => x.close);
    const e21  = calcEMA(cl, 21);
    const rsi  = calcRSI(cl, 7);
    const i    = cl.length - 1;
    if (isNaN(e21[i]) || isNaN(rsi[i]) || isNaN(rsi[i-1])) return;
    const aboveEma = cl[i] > e21[i];
    if (s.pos === "flat" && aboveEma && rsi[i-1] < 50 && rsi[i] >= 50) goLong(s, p, "RSI7 cross 50");
    if (s.pos === "long" && (!aboveEma || rsi[i] < 40)) goFlat(s, p, "lost momentum");
    if (s.pos === "long" && p < s.entry * 0.988) goFlat(s, p, "SL -1.2%");
  }),

  // 7. Surfer — RSI(30) arm + EMA7>EMA25 on 15m (our live bot logic)
  mkStrat("Surfer", "15m", (s, c, p) => {
    const cl  = c.map(x => x.close);
    const rsi = calcRSI(cl);
    const e7  = calcEMA(cl, 7), e25 = calcEMA(cl, 25);
    const i   = cl.length - 1;
    const cur = rsi[i], prev = rsi[i-1];
    if (isNaN(cur) || isNaN(prev) || isNaN(e7[i]) || isNaN(e25[i])) return;
    if (prev < 30 && cur >= 30) s._armed = true;
    const bull = e7[i] > e25[i] && e7[i] > e7[i-1];
    if (s.pos === "flat" && s._armed && bull) { goLong(s, p, "RSI arm + bull EMA"); s._armed = false; }
    if (s.pos === "long" && !bull && cur < 50) goFlat(s, p, "EMA bear + RSI<50");
  }),
];

// ── Candle stores ─────────────────────────────────────────────────────────────

const store: Record<TF, Candle[]> = { "1m": [], "5m": [], "15m": [], "1h": [] };

async function fetchKlines(tf: TF, limit: number) {
  const url = `${BASE}/klines?symbol=SOLUSDT&interval=${tf}&limit=${limit}`;
  const res = await fetch(url);
  const raw: string[][] = await res.json();
  return raw.slice(0, -1).map(c => ({
    time: Number(c[0]), open: parseFloat(c[1]), high: parseFloat(c[2]),
    low:  parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5]),
  }));
}

// ── Display ───────────────────────────────────────────────────────────────────

const GREEN = "\x1B[32m", RED = "\x1B[31m", DIM = "\x1B[2m", RESET = "\x1B[0m", BOLD = "\x1B[1m";

function bar(pnl: number): string {
  const blocks = Math.round(Math.abs(pnl) / 0.05);
  const clamped = Math.min(blocks, 20);
  return pnl >= 0 ? GREEN + "█".repeat(clamped) + RESET : RED + "▓".repeat(clamped) + RESET;
}

function display() {
  const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
  const sorted  = [...strategies].sort((a, b) => b.pnlPct() - a.pnlPct());
  const lines: string[] = [];

  lines.push("\x1B[2J\x1B[H"); // clear + home
  lines.push(`${BOLD}SOL/USDT  $${livePrice.toFixed(2)}${RESET}   runtime: ${elapsed}m   ${new Date().toLocaleTimeString()}`);
  lines.push(`${"─".repeat(90)}`);
  lines.push(
    `${"Strategy".padEnd(16)}${"TF".padEnd(5)}${"Pos".padEnd(7)}${"P&L %".padEnd(10)}${"Equity".padEnd(11)}${"Trades".padEnd(8)}Signal`
  );
  lines.push(`${"─".repeat(90)}`);

  for (const s of sorted) {
    const pct = s.pnlPct();
    const col = pct > 0 ? GREEN : pct < 0 ? RED : DIM;
    const pctStr = (pct >= 0 ? "+" : "") + pct.toFixed(3) + "%";
    lines.push(
      `${s.name.padEnd(16)}${s.tf.padEnd(5)}${s.pos.padEnd(7)}` +
      `${col}${pctStr.padEnd(10)}${RESET}` +
      `$${s.equity().toFixed(2).padEnd(10)} ${String(s.trades).padEnd(7)} ${DIM}${s.sig}${RESET}`
    );
  }

  lines.push(`${"─".repeat(90)}`);

  const totalEq  = strategies.reduce((a, s) => a + s.equity(), 0);
  const totalPct = (totalEq / (CAPITAL * strategies.length) - 1) * 100;
  const totCol   = totalPct > 0 ? GREEN : totalPct < 0 ? RED : RESET;
  lines.push(
    `${BOLD}Portfolio  7×$${CAPITAL}  →  ${totCol}${totalPct >= 0 ? "+" : ""}${totalPct.toFixed(3)}%  ($${totalEq.toFixed(2)})${RESET}`
  );

  // Mini bar chart
  lines.push("");
  for (const s of sorted) {
    const pct = s.pnlPct();
    lines.push(`  ${s.name.padEnd(16)} ${bar(pct)} ${(pct >= 0 ? "+" : "") + pct.toFixed(3) + "%"}`);
  }

  process.stdout.write(lines.join("\n") + "\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write("Fetching historical candles…\n");

  [store["1m"], store["5m"], store["15m"], store["1h"]] = await Promise.all([
    fetchKlines("1m", 250),
    fetchKlines("5m", 150),
    fetchKlines("15m", 120),
    fetchKlines("1h", 100),
  ]);

  livePrice = store["1m"][store["1m"].length - 1].close;

  // Initial pass — prime all strategies with history
  for (const s of strategies) s.run(store[s.tf], livePrice);

  display();

  const streams = [
    "solusdt@miniTicker",
    "solusdt@kline_1m",
    "solusdt@kline_5m",
    "solusdt@kline_15m",
    "solusdt@kline_1h",
  ].join("/");

  const ws = new WebSocket(`wss://stream.binance.us:9443/stream?streams=${streams}`);

  ws.on("message", (raw) => {
    const { stream, data } = JSON.parse(raw.toString());

    if (stream === "solusdt@miniTicker") {
      livePrice = parseFloat(data.c);
      display();
      return;
    }

    if (stream.startsWith("solusdt@kline_")) {
      const tf = stream.replace("solusdt@kline_", "") as TF;
      const k  = data.k;
      const candle: Candle = {
        time: k.t, open: parseFloat(k.o), high: parseFloat(k.h),
        low:  parseFloat(k.l), close: parseFloat(k.c), volume: parseFloat(k.v),
      };
      const arr = store[tf];
      if (arr.length > 0 && arr[arr.length - 1].time === candle.time) {
        arr[arr.length - 1] = candle; // update forming candle
      } else {
        arr.push(candle);
        if (arr.length > 500) arr.shift();
      }
      if (k.x) { // candle closed — fire strategies
        for (const s of strategies.filter(st => st.tf === tf)) s.run(store[tf], livePrice);
        display();
      }
    }
  });

  ws.on("error", (e) => process.stderr.write(`\nWS error: ${e.message}\n`));
  ws.on("close", () => { process.stderr.write("\nDisconnected.\n"); display(); });
}

main().catch(console.error);
