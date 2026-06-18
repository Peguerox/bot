/**
 * HYDRA — Order Flow Intelligence
 *
 * Reads raw tick-by-tick trade data, not candles.
 * Every trade on Binance carries a flag: was the buyer or seller the aggressor?
 *   m=true  → buyer is maker → a SELL order hit the resting bid   → seller was aggressive
 *   m=false → buyer is taker → a BUY  order lifted the ask        → buyer was aggressive
 *
 * Strategy premise: short-term price direction is determined by which side is more urgent.
 * We measure that urgency, filter by large-trade confirmation, and detect divergence
 * (when pressure and price disagree — that's the highest-confidence signal).
 */

import WebSocket from "ws";

const CAPITAL     = 1000;
const FEE         = 0.001;      // 0.1% taker each side
const SL          = 0.008;      // -0.8% stop loss
const TP          = 0.006;      // +0.6% take profit
const MAX_HOLD_MS = 15 * 60_000; // 15 min max hold

type Tick = { price: number; qty: number; isBuy: boolean; ts: number };

let livePrice  = 0;
let ticks: Tick[] = [];
const startTime = Date.now();
let lastDisplay = 0;

// ── Position ──────────────────────────────────────────────────────────────────
let pos: "flat" | "long" = "flat";
let entryPrice = 0;
let entryTime  = 0;
let solQty     = 0;
let cash       = CAPITAL;
let trades     = 0;
let wins       = 0;
let peakEq     = CAPITAL;
let maxDD      = 0;
const tradeLog: { ts: number; action: string; price: number; reason: string }[] = [];

function equity(): number {
  return pos === "long" ? solQty * livePrice * (1 - FEE) : cash;
}

// ── Sensors ───────────────────────────────────────────────────────────────────

// Net aggressive buy volume / total volume → [-1, +1]
function cvd(windowMs: number): number {
  const now    = Date.now();
  const window = ticks.filter(t => now - t.ts < windowMs);
  if (window.length < 5) return 0;
  let buyVol = 0, sellVol = 0;
  for (const t of window) t.isBuy ? (buyVol += t.qty) : (sellVol += t.qty);
  const total = buyVol + sellVol;
  return total === 0 ? 0 : (buyVol - sellVol) / total;
}

// Are large trades (top quartile by size) going long or short? → [-1, +1]
function bigMoneyBias(windowMs: number): number {
  const now    = Date.now();
  const window = ticks.filter(t => now - t.ts < windowMs);
  if (window.length < 10) return 0;
  const sorted    = [...window].sort((a, b) => a.qty - b.qty);
  const threshold = sorted[Math.floor(sorted.length * 0.75)].qty;
  let bigBuy = 0, bigSell = 0;
  for (const t of window) {
    if (t.qty < threshold) continue;
    t.isBuy ? (bigBuy += t.qty) : (bigSell += t.qty);
  }
  const total = bigBuy + bigSell;
  return total === 0 ? 0 : (bigBuy - bigSell) / total;
}

// Trade frequency ratio: last 15s vs 60s baseline (>1 = accelerating)
function urgency(): number {
  const now  = Date.now();
  const n15  = ticks.filter(t => now - t.ts < 15_000).length;
  const n60  = ticks.filter(t => now - t.ts < 60_000).length;
  if (n60 < 4) return 1;
  return n15 / (n60 / 4);
}

// Shannon entropy of tick directions over last N ticks → 0 (one-sided) to 1 (random)
function tickEntropy(n = 40): number {
  const recent = ticks.slice(-n);
  if (recent.length < 10) return 0.5;
  const p = recent.filter(t => t.isBuy).length / recent.length;
  if (p === 0 || p === 1) return 0;
  return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}

// Price change in $/second over last 30 seconds
function velocity(): number {
  const now  = Date.now();
  const past = ticks.find(t => now - t.ts < 30_000);
  if (!past || !livePrice) return 0;
  return (livePrice - past.price) / 30;
}

// CVD divergence: when net order flow disagrees with price direction
function divergence(): "bullish_accum" | "bearish_dist" | "none" {
  const c = cvd(45_000);
  const v = velocity();
  // Strong buyers but price flat/down → sellers absorbing → bearish
  if (c > 0.45 && v < -0.005) return "bearish_dist";
  // Strong sellers but price flat/up → buyers absorbing → bullish
  if (c < -0.45 && v >  0.005) return "bullish_accum";
  return "none";
}

// ── Decision ──────────────────────────────────────────────────────────────────

function decide() {
  if (ticks.length < 60) return;

  const cvd30 = cvd(30_000);
  const cvd5  = cvd(5_000);
  const big   = bigMoneyBias(60_000);
  const urg   = urgency();
  const ent   = tickEntropy();
  const vel   = velocity();
  const div   = divergence();

  // ── EXIT ─────────────────────────────────────────────────────────────────
  if (pos === "long") {
    const ret    = livePrice / entryPrice - 1;
    const holdMs = Date.now() - entryTime;

    if (ret <= -SL)                           { close(livePrice, `stop loss ${(ret*100).toFixed(2)}%`); return; }
    if (ret >= TP)                            { close(livePrice, `take profit ${(ret*100).toFixed(2)}%`); return; }
    if (holdMs > MAX_HOLD_MS)                 { close(livePrice, "max hold time"); return; }
    if (cvd5 < -0.55 && urg > 1.4)           { close(livePrice, "aggressive sell surge"); return; }
    if (div === "bearish_dist" && vel < -0.04){ close(livePrice, "distribution detected"); return; }
    if (big < -0.6)                           { close(livePrice, "smart money exiting"); return; }
    return;
  }

  // ── ENTRY: momentum — all sensors agree ──────────────────────────────────
  const allBullish =
    cvd30 > 0.30 &&   // net buying pressure over 30s
    cvd5  > 0.15 &&   // still buying in last 5s (not exhausted)
    big   > 0.20 &&   // large orders are buys
    urg   > 1.10 &&   // activity accelerating
    ent   < 0.85 &&   // directional (not noise)
    vel   > 0;        // price moving up

  // ENTRY: divergence — smart money accumulating into a sell-off
  const accumulation =
    div === "bullish_accum" &&
    big  > 0.1 &&
    urg  > 0.9;

  if (allBullish)    enter(livePrice, "momentum confluence");
  if (accumulation)  enter(livePrice, "smart money accumulation");
}

function enter(price: number, reason: string) {
  if (pos !== "flat" || cash < 1) return;
  solQty     = (cash * (1 - FEE)) / price;
  cash       = 0;
  entryPrice = price;
  entryTime  = Date.now();
  pos        = "long";
  tradeLog.push({ ts: Date.now(), action: "BUY", price, reason });
}

function close(price: number, reason: string) {
  if (pos !== "long") return;
  cash   = solQty * price * (1 - FEE);
  const originalCost = entryPrice * (solQty / (1 - FEE));
  if (cash > originalCost) wins++;
  solQty = 0;
  pos    = "flat";
  trades++;
  tradeLog.push({ ts: Date.now(), action: "SELL", price, reason });
  const eq = equity();
  if (eq > peakEq) peakEq = eq;
  const dd = (peakEq - eq) / peakEq * 100;
  if (dd > maxDD) maxDD = dd;
}

// ── Display ───────────────────────────────────────────────────────────────────

const G = "\x1B[32m", R = "\x1B[31m", Y = "\x1B[33m";
const DIM = "\x1B[2m", B = "\x1B[1m", X = "\x1B[0m";

function sensorBar(val: number, width = 16): string {
  const half    = Math.floor(width / 2);
  const filled  = Math.min(Math.round(Math.abs(val) * half), half);
  const left    = val < 0 ? (R + "◀".repeat(filled)).padStart(half + (val < 0 ? filled * 2 : 0)) : " ".repeat(half);
  const right   = val > 0 ? (G + "▶".repeat(filled) + X) : "";
  return `[${X}${left}${X}|${right}${X}${"]"}`;
}

function display() {
  const now = Date.now();
  if (now - lastDisplay < 800) return; // throttle to ~1 FPS
  lastDisplay = now;

  const cvd30 = cvd(30_000);
  const cvd5  = cvd(5_000);
  const big   = bigMoneyBias(60_000);
  const urg   = urgency();
  const ent   = tickEntropy();
  const vel   = velocity();
  const div   = divergence();
  const eq    = equity();
  const pct   = (eq / CAPITAL - 1) * 100;
  const elapsed = ((now - startTime) / 60_000).toFixed(1);

  const lines: string[] = [];
  lines.push("\x1B[2J\x1B[H");
  lines.push(`${B}┌─ HYDRA ─ Order Flow Intelligence ─ SOL/USDT $${livePrice.toFixed(2)} ─ ${new Date().toLocaleTimeString()} ─ ${elapsed}m${X}`);
  lines.push(`${B}│${X}`);

  // Sensors
  lines.push(`${B}│  SENSORS${X}  (pure tick data — no candles)`);
  const fmt = (v: number) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
  lines.push(`│  CVD 30s  ${sensorBar(cvd30)}  ${cvd30 > 0.3 ? G : cvd30 < -0.3 ? R : DIM}${fmt(cvd30).padStart(7)}  ${cvd30 > 0.3 ? "buyers winning" : cvd30 < -0.3 ? "sellers winning" : "neutral"}${X}`);
  lines.push(`│  CVD  5s  ${sensorBar(cvd5)}  ${cvd5 > 0.2 ? G : cvd5 < -0.2 ? R : DIM}${fmt(cvd5).padStart(7)}  ${DIM}(recent)${X}`);
  lines.push(`│  Big $    ${sensorBar(big)}  ${big > 0.3 ? G : big < -0.3 ? R : DIM}${fmt(big).padStart(7)}  ${big > 0.3 ? "smart money: LONG" : big < -0.3 ? "smart money: SHORT" : "undecided"}${X}`);
  lines.push(`│  Urgency  ${urg.toFixed(2)}x   ${urg > 1.3 ? Y + "⚡ accelerating" : urg < 0.7 ? DIM + "slowing" : "normal"}${X}`);
  lines.push(`│  Entropy  ${("▪".repeat(Math.round(ent * 20))).padEnd(20)}  ${(ent * 100).toFixed(0)}%  ${ent < 0.6 ? G + "directional" : ent > 0.9 ? DIM + "noise" : "mixed"}${X}`);
  lines.push(`│  Velocity ${vel >= 0 ? G : R}${vel >= 0 ? "+" : ""}${vel.toFixed(4)} $/s${X}`);
  lines.push(`│  Diverge  ${div === "bullish_accum" ? G + "▲ ACCUMULATION (fade the sell)" : div === "bearish_dist" ? R + "▼ DISTRIBUTION (fade the buy)" : DIM + "none"}${X}`);
  lines.push(`${B}│${X}`);

  // Position
  lines.push(`${B}│  POSITION${X}`);
  if (pos === "long") {
    const ret     = (livePrice / entryPrice - 1) * 100;
    const holdMin = ((now - entryTime) / 60_000).toFixed(1);
    const retCol  = ret >= 0 ? G : R;
    lines.push(`│  ${G}▲ LONG${X}  entry $${entryPrice.toFixed(2)}  now $${livePrice.toFixed(2)}  ${retCol}${ret >= 0 ? "+" : ""}${ret.toFixed(3)}%${X}  held ${holdMin}m`);
    lines.push(`│  SL $${(entryPrice * (1 - SL)).toFixed(2)}  TP $${(entryPrice * (1 + TP)).toFixed(2)}`);
  } else {
    lines.push(`│  ${DIM}flat — scanning${X}`);
  }
  lines.push(`${B}│${X}`);

  // Portfolio
  const pctCol = pct > 0 ? G : pct < 0 ? R : X;
  lines.push(`${B}│  PORTFOLIO${X}`);
  lines.push(`│  Equity $${eq.toFixed(2)}  P&L ${pctCol}${pct >= 0 ? "+" : ""}${pct.toFixed(3)}%${X}  trades ${trades}  wins ${wins}  winrate ${trades > 0 ? ((wins / trades) * 100).toFixed(0) + "%" : "—"}  maxDD ${R}${maxDD.toFixed(2)}%${X}`);
  lines.push(`│  Ticks buffered: ${ticks.length}  (last 2000 trades)`);
  lines.push(`${B}│${X}`);

  // Trade log
  lines.push(`${B}│  TRADE LOG${X}`);
  const recent = tradeLog.slice(-6);
  if (recent.length === 0) {
    lines.push(`│  ${DIM}waiting for signal…${X}`);
  } else {
    for (const t of recent) {
      const col = t.action === "BUY" ? G : R;
      lines.push(`│  ${new Date(t.ts).toLocaleTimeString()}  ${col}${t.action}${X}  $${t.price.toFixed(2)}  ${DIM}${t.reason}${X}`);
    }
  }
  lines.push(`└${"─".repeat(78)}`);

  process.stdout.write(lines.join("\n") + "\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write(`${B}HYDRA${X} — connecting to raw trade stream…\n`);
  process.stdout.write("Reading every individual trade on SOLUSDT. Need 60 ticks to start.\n\n");

  // Binance.US has too little SOLUSDT volume for tick-level analysis (~1 trade/2min)
  // Using Binance.com global stream for signal data (public, no auth) — same price
  const ws = new WebSocket("wss://stream.binance.com:9443/ws/solusdt@aggTrade");

  ws.on("message", (raw) => {
    const d = JSON.parse(raw.toString());
    livePrice = parseFloat(d.p);
    ticks.push({
      price: livePrice,
      qty:   parseFloat(d.q),
      isBuy: !d.m, // m=true = buyer is maker = sell order hit = seller aggressive
      ts:    d.T,
    });
    if (ticks.length > 2000) ticks.shift();
    decide();
    display();
  });

  ws.on("error", (e) => process.stderr.write(`WS error: ${e.message}\n`));
  ws.on("close", () => { process.stderr.write("Disconnected.\n"); });
}

main().catch(console.error);
