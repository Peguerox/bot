/**
 * CHIMERA — Adaptive Dual-Regime Strategy
 *
 * Regime detection first, then strategy selection:
 *
 *   RANGING market (low realized vol):
 *     → Mean reversion. Price always gravitates back to fair value.
 *       Buy when price drops >0.25% below EMA fair value + sellers exhausting.
 *       Sell when price returns to fair value.
 *
 *   TRENDING market (high realized vol):
 *     → Momentum. Ride the wave with CVD confirmation.
 *       Buy when aggressive buyers dominate + large trades confirm.
 *       Sell when flow reverses.
 *
 *   NEUTRAL zone: stay flat.
 *
 * Data: Binance.com aggTrade stream (high frequency, same SOL/USDT price).
 * Capital: $1000 paper.
 */

import WebSocket from "ws";

const CAPITAL     = 1000;
const FEE         = 0.001;
const SL          = 0.006;   // -0.6% hard stop
const TP_REVERT   = 0.004;   // +0.4% take profit in mean-reversion mode
const TP_TREND    = 0.007;   // +0.7% take profit in trend mode
const MAX_HOLD_MS = 12 * 60_000;

type Tick = { price: number; qty: number; isBuy: boolean; ts: number };

let livePrice = 0;
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
let currentMode: "ranging" | "trending" | "neutral" = "neutral";
const tradeLog: { ts: number; action: string; price: number; reason: string; mode: string }[] = [];

// ── Fair value tracker (exponential moving average over ticks) ────────────────
let ema60  = 0;  // fast: ~60 ticks
let ema200 = 0;  // slow: ~200 ticks
let emaN   = 0;
const EMA60_K  = 2 / 61;
const EMA200_K = 2 / 201;

function updateEMA(price: number) {
  if (emaN === 0) { ema60 = price; ema200 = price; }
  else { ema60 = price * EMA60_K + ema60 * (1 - EMA60_K); ema200 = price * EMA200_K + ema200 * (1 - EMA200_K); }
  emaN++;
}

// ── Realized volatility (std dev of last N price changes) ────────────────────
function realizedVol(n = 60): number {
  const recent = ticks.slice(-n - 1);
  if (recent.length < 10) return 0;
  const changes: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    changes.push((recent[i].price - recent[i - 1].price) / recent[i - 1].price);
  }
  const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
  const variance = changes.reduce((a, b) => a + (b - mean) ** 2, 0) / changes.length;
  return Math.sqrt(variance);
}

// ── CVD: net buy pressure over window ────────────────────────────────────────
function cvd(windowMs: number): number {
  const now    = Date.now();
  const window = ticks.filter(t => now - t.ts < windowMs);
  if (window.length < 3) return 0;
  let buy = 0, sell = 0;
  for (const t of window) t.isBuy ? (buy += t.qty) : (sell += t.qty);
  const total = buy + sell;
  return total === 0 ? 0 : (buy - sell) / total;
}

// ── Large trade bias: top quartile by size ────────────────────────────────────
function bigMoneyBias(windowMs: number): number {
  const now    = Date.now();
  const window = ticks.filter(t => now - t.ts < windowMs);
  if (window.length < 8) return 0;
  const threshold = [...window].sort((a, b) => a.qty - b.qty)[Math.floor(window.length * 0.75)].qty;
  let bigBuy = 0, bigSell = 0;
  for (const t of window) {
    if (t.qty < threshold) continue;
    t.isBuy ? (bigBuy += t.qty) : (bigSell += t.qty);
  }
  const total = bigBuy + bigSell;
  return total === 0 ? 0 : (bigBuy - bigSell) / total;
}

// ── Regime detection ──────────────────────────────────────────────────────────
function detectRegime(): "ranging" | "trending" | "neutral" {
  const vol = realizedVol(80);
  // Calibrated to actual SOL/USDT aggTrade tick volatility
  if (vol < 0.00015) return "ranging";   // < 0.015% per tick = choppy/range
  if (vol > 0.00030) return "trending";  // > 0.030% per tick = clear trend
  return "neutral";
}

// ── Mean reversion signal ─────────────────────────────────────────────────────
function meanReversionSignal(): { enter: boolean; reason: string } {
  if (emaN < 80) return { enter: false, reason: "warming up" };
  const fairValue = ema60;
  const deviation = (livePrice - fairValue) / fairValue;
  const cvd5  = cvd(5_000);
  const cvd15 = cvd(15_000);

  // Price dropped >0.25% below fair value AND selling is starting to exhaust
  if (deviation < -0.0010 && cvd5 > cvd15 && cvd5 > -0.5) {
    return { enter: true, reason: `revert: ${(deviation * 100).toFixed(3)}% below fair value, sellers exhausting` };
  }
  return { enter: false, reason: "" };
}

// ── Trend momentum signal ─────────────────────────────────────────────────────
function trendSignal(): { enter: boolean; reason: string } {
  const cvd30 = cvd(30_000);
  const cvd10 = cvd(10_000);
  const big   = bigMoneyBias(45_000);
  const now   = Date.now();
  const urg   = ticks.filter(t => now - t.ts < 15_000).length /
                Math.max(1, ticks.filter(t => now - t.ts < 60_000).length / 4);

  // Strong buying across all windows + large trade confirmation
  if (cvd30 > 0.40 && cvd10 > 0.25 && big > 0.15 && urg > 1.05) {
    return { enter: true, reason: `momentum: CVD30 ${(cvd30*100).toFixed(0)}% CVD10 ${(cvd10*100).toFixed(0)}% big ${(big*100).toFixed(0)}%` };
  }
  return { enter: false, reason: "" };
}

// ── Decision ──────────────────────────────────────────────────────────────────
function decide() {
  if (ticks.length < 80 || emaN < 80) return;

  const regime = detectRegime();
  currentMode  = regime;
  const fairValue = ema60;
  const cvd5   = cvd(5_000);
  const big    = bigMoneyBias(45_000);

  // ── EXIT ──────────────────────────────────────────────────────────────────
  if (pos === "long") {
    const ret    = livePrice / entryPrice - 1;
    const holdMs = Date.now() - entryTime;
    const tp     = entryMode === "revert" ? TP_REVERT : TP_TREND;

    if (ret <= -SL)                        { close(livePrice, `stop loss ${(ret*100).toFixed(2)}%`); return; }
    if (ret >= tp)                         { close(livePrice, `take profit +${(ret*100).toFixed(2)}%`); return; }
    if (holdMs > MAX_HOLD_MS)              { close(livePrice, "max hold"); return; }

    if (entryMode === "revert") {
      // Exit mean-reversion when price returns to fair value
      if (livePrice >= fairValue)          { close(livePrice, "returned to fair value"); return; }
      if (cvd5 < -0.6 && big < -0.4)      { close(livePrice, "strong selling surge"); return; }
    } else {
      // Exit trend when momentum dies
      if (cvd5 < -0.35)                   { close(livePrice, "momentum reversed"); return; }
      if (big < -0.5)                      { close(livePrice, "smart money flipped short"); return; }
    }
    return;
  }

  // ── ENTRY ─────────────────────────────────────────────────────────────────
  if (regime === "ranging") {
    const sig = meanReversionSignal();
    if (sig.enter) { enter(livePrice, sig.reason, "revert"); }
  } else if (regime === "trending") {
    const sig = trendSignal();
    if (sig.enter) { enter(livePrice, sig.reason, "trend"); }
  }
}

let entryMode: "revert" | "trend" = "revert";

function equity(): number {
  return pos === "long" ? solQty * livePrice * (1 - FEE) : cash;
}

function enter(price: number, reason: string, mode: "revert" | "trend") {
  if (pos !== "flat" || cash < 1) return;
  solQty     = (cash * (1 - FEE)) / price;
  cash       = 0;
  entryPrice = price;
  entryTime  = Date.now();
  entryMode  = mode;
  pos        = "long";
  tradeLog.push({ ts: Date.now(), action: "BUY", price, reason, mode });
}

function close(price: number, reason: string) {
  if (pos !== "long") return;
  const out  = solQty * price * (1 - FEE);
  const cost = entryPrice * (solQty / (1 - FEE));
  if (out > cost) wins++;
  cash   = out;
  solQty = 0;
  pos    = "flat";
  trades++;
  tradeLog.push({ ts: Date.now(), action: "SELL", price, reason, mode: entryMode });
  const eq = equity();
  if (eq > peakEq) peakEq = eq;
  const dd = (peakEq - eq) / peakEq * 100;
  if (dd > maxDD) maxDD = dd;
}

// ── Display ───────────────────────────────────────────────────────────────────
const G = "\x1B[32m", R = "\x1B[31m", Y = "\x1B[33m", C = "\x1B[36m";
const DIM = "\x1B[2m", B = "\x1B[1m", X = "\x1B[0m";

function display() {
  const now = Date.now();
  if (now - lastDisplay < 1000) return;
  lastDisplay = now;

  const regime  = detectRegime();
  const vol     = realizedVol(80);
  const cvd30   = cvd(30_000);
  const cvd5    = cvd(5_000);
  const big     = bigMoneyBias(45_000);
  const fairVal = ema60;
  const dev     = emaN > 0 ? (livePrice - fairVal) / fairVal : 0;
  const eq      = equity();
  const pct     = (eq / CAPITAL - 1) * 100;
  const elapsed = ((now - startTime) / 60_000).toFixed(1);

  const regimeStr = regime === "ranging"  ? `${Y}◈ RANGING (mean-revert)${X}` :
                    regime === "trending" ? `${G}▲ TRENDING (momentum)${X}` :
                                           `${DIM}— NEUTRAL (flat)${X}`;

  const lines: string[] = [];
  lines.push("\x1B[2J\x1B[H");
  lines.push(`${B}┌─ CHIMERA ─ Adaptive Dual-Regime ─ SOL/USDT $${livePrice.toFixed(2)} ─ ${new Date().toLocaleTimeString()} ─ ${elapsed}m${X}`);
  lines.push(`│  Regime: ${regimeStr}   Vol: ${(vol * 100).toFixed(4)}%   Ticks: ${ticks.length}`);
  lines.push(`${B}│${X}`);

  lines.push(`${B}│  MARKET STATE${X}`);
  lines.push(`│  Fair value (EMA60):  $${fairVal.toFixed(3)}   deviation: ${dev >= 0 ? G : R}${(dev * 100).toFixed(3)}%${X}`);
  lines.push(`│  CVD 30s:  ${cvd30 >= 0 ? G : R}${(cvd30 >= 0 ? "+" : "") + (cvd30 * 100).toFixed(1)}%${X}   CVD 5s: ${cvd5 >= 0 ? G : R}${(cvd5 >= 0 ? "+" : "") + (cvd5 * 100).toFixed(1)}%${X}   Big $: ${big >= 0 ? G : R}${(big >= 0 ? "+" : "") + (big * 100).toFixed(1)}%${X}`);
  lines.push(`${B}│${X}`);

  // Regime-specific signal preview
  if (regime === "ranging") {
    const sig = meanReversionSignal();
    lines.push(`${B}│  RANGING SIGNAL${X}`);
    lines.push(`│  Entry needs: price < fair - 0.25% (now ${(dev * 100).toFixed(3)}%) + sellers exhausting`);
    lines.push(`│  Signal: ${sig.enter ? G + "▶ FIRE" : DIM + "waiting"}${X}   ${DIM}${sig.reason}${X}`);
  } else if (regime === "trending") {
    const sig = trendSignal();
    lines.push(`${B}│  TRENDING SIGNAL${X}`);
    lines.push(`│  Entry needs: CVD30>40% + CVD10>25% + big>15% + urgency>1.05`);
    lines.push(`│  Signal: ${sig.enter ? G + "▶ FIRE" : DIM + "waiting"}${X}   ${DIM}${sig.reason}${X}`);
  } else {
    lines.push(`${B}│  NEUTRAL — no trades${X}`);
    lines.push(`│  Waiting for vol to define a regime...`);
  }
  lines.push(`${B}│${X}`);

  // Position
  lines.push(`${B}│  POSITION${X}`);
  if (pos === "long") {
    const ret     = (livePrice / entryPrice - 1) * 100;
    const tp      = entryMode === "revert" ? TP_REVERT * 100 : TP_TREND * 100;
    lines.push(`│  ${G}▲ LONG${X} [${C}${entryMode}${X}]  entry $${entryPrice.toFixed(3)}  now $${livePrice.toFixed(3)}  ${ret >= 0 ? G : R}${ret >= 0 ? "+" : ""}${ret.toFixed(3)}%${X}`);
    lines.push(`│  SL $${(entryPrice * (1 - SL)).toFixed(3)}   TP $${(entryPrice * (1 + (entryMode === "revert" ? TP_REVERT : TP_TREND))).toFixed(3)} (+${tp}%)`);
  } else {
    lines.push(`│  ${DIM}flat${X}`);
  }
  lines.push(`${B}│${X}`);

  // Portfolio
  const pctCol = pct > 0 ? G : pct < 0 ? R : X;
  lines.push(`${B}│  PORTFOLIO${X}`);
  lines.push(`│  $${eq.toFixed(2)}  ${pctCol}${pct >= 0 ? "+" : ""}${pct.toFixed(3)}%${X}  trades ${trades}  wins ${wins}  WR ${trades > 0 ? ((wins / trades) * 100).toFixed(0) + "%" : "—"}  maxDD ${R}${maxDD.toFixed(2)}%${X}`);
  lines.push(`${B}│${X}`);

  // Trade log
  lines.push(`${B}│  TRADE LOG${X}`);
  const recent = tradeLog.slice(-8);
  if (recent.length === 0) {
    lines.push(`│  ${DIM}no trades yet${X}`);
  } else {
    for (const t of recent) {
      const col  = t.action === "BUY" ? G : R;
      const mCol = t.mode === "revert" ? Y : C;
      lines.push(`│  ${new Date(t.ts).toLocaleTimeString()}  ${col}${t.action}${X} [${mCol}${t.mode}${X}] $${t.price.toFixed(3)}  ${DIM}${t.reason}${X}`);
    }
  }
  lines.push(`└${"─".repeat(78)}`);

  process.stdout.write(lines.join("\n") + "\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  process.stdout.write(`${B}CHIMERA${X} starting — dual-regime adaptive strategy\n`);

  const ws = new WebSocket("wss://stream.binance.com:9443/ws/solusdt@aggTrade");

  ws.on("message", (raw) => {
    const d = JSON.parse(raw.toString());
    livePrice = parseFloat(d.p);
    const tick: Tick = {
      price: livePrice,
      qty:   parseFloat(d.q),
      isBuy: !d.m,
      ts:    d.T,
    };
    ticks.push(tick);
    if (ticks.length > 2000) ticks.shift();
    updateEMA(livePrice);
    decide();
    display();
  });

  ws.on("error", (e) => process.stderr.write(`WS error: ${e.message}\n`));
  ws.on("close", () => process.stderr.write("Disconnected.\n"));
}

main().catch(console.error);
