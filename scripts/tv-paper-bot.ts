// ── TV Signal Paper Bot ───────────────────────────────────────────────────
// Paper-trades SOL based on TradingView Technical Analysis summary.
// Adjust the CONFIG block below, then run:
//   npx tsx scripts/tv-paper-bot.ts
//
// ── HOW TO CONFIGURE ─────────────────────────────────────────────────────
//
//  EXCHANGE   "BINANCEUS"  or  "BINANCE"  (global)
//  TV_SYMBOL  "SOLUSD"    for BINANCEUS
//             "SOLUSDT"   for BINANCE global
//
//  TIMEFRAME  1 | 5 | 15 | 60 | 240 | 1D | 1W
//             (how often TradingView refreshes the signal)
//
//  BUY_ON     "buy"    → enter on Buy  OR  Strong Buy
//             "strong" → enter on Strong Buy only
//
//  SELL_ON    "sell"   → exit on Sell  OR  Strong Sell
//             "strong" → exit on Strong Sell only
//
//  CAPITAL    starting USDT balance
//
//  POLL_SECS  how often to check (seconds). Min recommended: 30

// ── CONFIG ───────────────────────────────────────────────────────────────
const EXCHANGE   = "BINANCEUS";  // "BINANCE" | "BINANCEUS"
const TV_SYMBOL  = "SOLUSD";     // "SOLUSDT" for BINANCE, "SOLUSD" for BINANCEUS
const TIMEFRAME  = "60";         // 1 | 5 | 15 | 60 | 240 | 1D | 1W
const BUY_ON     = "buy";        // "buy" | "strong"
const SELL_ON    = "sell";       // "sell" | "strong"
const CAPITAL    = 1000;         // starting USDT
const POLL_SECS  = 60;           // poll interval in seconds
// ─────────────────────────────────────────────────────────────────────────

type Signal = "STRONG_BUY" | "BUY" | "NEUTRAL" | "SELL" | "STRONG_SELL";
type Trade  = { time: string; side: "BUY" | "SELL"; price: number; qty: number; signal: Signal; pnlPct?: number };

const TV_TICKER = `${EXCHANGE}:${TV_SYMBOL}`;
const PRICE_URL = EXCHANGE === "BINANCE"
  ? `https://api.binance.com/api/v3/ticker/price?symbol=${TV_SYMBOL}`
  : `https://api.binance.us/api/v3/ticker/price?symbol=${TV_SYMBOL}`;

const TF_LABEL: Record<string, string> = {
  "1": "1m", "5": "5m", "15": "15m", "60": "1h",
  "240": "4h", "1D": "1D", "1W": "1W",
};

function toSignal(val: number): Signal {
  if (val >=  0.5) return "STRONG_BUY";
  if (val >=  0.1) return "BUY";
  if (val >  -0.1) return "NEUTRAL";
  if (val >  -0.5) return "SELL";
  return "STRONG_SELL";
}

function isBuySignal(s: Signal): boolean {
  return BUY_ON === "strong" ? s === "STRONG_BUY" : s === "STRONG_BUY" || s === "BUY";
}

function isSellSignal(s: Signal): boolean {
  return SELL_ON === "strong" ? s === "STRONG_SELL" : s === "STRONG_SELL" || s === "SELL";
}

function signalLabel(s: Signal): string {
  return {
    STRONG_BUY:  "▲▲ STRONG BUY",
    BUY:         "▲  BUY",
    NEUTRAL:     "─  NEUTRAL",
    SELL:        "▼  SELL",
    STRONG_SELL: "▼▼ STRONG SELL",
  }[s];
}

async function fetchSignal(): Promise<{ signal: Signal; raw: number; ma: number; osc: number }> {
  const col = (c: string) => TIMEFRAME === "1D" || TIMEFRAME === "1W" ? c : `${c}|${TIMEFRAME}`;
  const res  = await fetch("https://scanner.tradingview.com/crypto/scan", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      symbols: { tickers: [TV_TICKER], query: { types: [] } },
      columns: [col("Recommend.All"), col("Recommend.MA"), col("Recommend.Other")],
    }),
  });
  const json = await res.json() as { data: { d: number[] }[] };
  const [raw, ma, osc] = json.data[0].d;
  return { signal: toSignal(raw ?? 0), raw: raw ?? 0, ma: ma ?? 0, osc: osc ?? 0 };
}

async function fetchPrice(): Promise<number> {
  const res  = await fetch(PRICE_URL);
  const json = await res.json() as { price: string };
  return parseFloat(json.price);
}

async function main() {
  let usdt      = CAPITAL;
  let solQty    = 0;
  let pos: "flat" | "long" = "flat";
  let entryPrice = 0;
  let entrySignal: Signal = "NEUTRAL";
  let trades    = 0, wins = 0;
  let peakEq    = CAPITAL, maxDD = 0;
  const tradeLog: Trade[] = [];
  const startTime = Date.now();

  const buyLabel  = BUY_ON  === "strong" ? "Strong Buy only"        : "Buy or Strong Buy";
  const sellLabel = SELL_ON === "strong" ? "Strong Sell only"       : "Sell or Strong Sell";

  while (true) {
    try {
      const [{ signal, raw, ma, osc }, price] = await Promise.all([fetchSignal(), fetchPrice()]);
      const now    = new Date().toLocaleTimeString();
      const equity = pos === "long" ? solQty * price : usdt;
      if (equity > peakEq) peakEq = equity;
      const dd = (peakEq - equity) / peakEq * 100;
      if (dd > maxDD) maxDD = dd;
      const pnlPct  = (equity / CAPITAL - 1) * 100;
      const elapsed = ((Date.now() - startTime) / 60_000).toFixed(1);

      // ── TRADE LOGIC ─────────────────────────────────────────────────────
      if (pos === "flat" && isBuySignal(signal)) {
        solQty      = usdt / price;
        usdt        = 0;
        entryPrice  = price;
        entrySignal = signal;
        pos         = "long";
        trades++;
        tradeLog.push({ time: now, side: "BUY", price, qty: solQty, signal });
      } else if (pos === "long" && isSellSignal(signal)) {
        const out   = solQty * price;
        const pnl   = (out / (entryPrice * solQty) - 1) * 100;
        if (out > entryPrice * solQty) wins++;
        tradeLog.push({ time: now, side: "SELL", price, qty: solQty, signal, pnlPct: pnl });
        usdt   = out;
        solQty = 0;
        pos    = "flat";
        trades++;
      }

      // ── DISPLAY ─────────────────────────────────────────────────────────
      const unreal = pos === "long" ? (price / entryPrice - 1) * 100 : 0;
      const w      = 80;
      const sep    = "─".repeat(w);

      const lines = [
        `┌─ TV Signal Bot ─ ${TV_TICKER} ─ TF: ${TF_LABEL[TIMEFRAME] ?? TIMEFRAME} ─ $${price.toFixed(2)} ─ ${now} ─ ${elapsed}m`,
        `│`,
        `│  SIGNAL  (${raw >= 0 ? "+" : ""}${raw.toFixed(4)})`,
        `│  Overall:   ${signalLabel(signal).padEnd(20)}  raw ${raw >= 0 ? "+" : ""}${raw.toFixed(4)}`,
        `│  MA:        ${signalLabel(toSignal(ma)).padEnd(20)}  raw ${ma >= 0 ? "+" : ""}${ma.toFixed(4)}`,
        `│  Oscillator:${signalLabel(toSignal(osc)).padEnd(20)}  raw ${osc >= 0 ? "+" : ""}${osc.toFixed(4)}`,
        `│`,
        `│  CONFIG`,
        `│  Buy when:  ${buyLabel}`,
        `│  Sell when: ${sellLabel}`,
        `│`,
        `│  POSITION`,
        pos === "long"
          ? `│  LONG  ${solQty.toFixed(4)} SOL @ $${entryPrice.toFixed(2)}  [entered on ${entrySignal}]  unrealized ${unreal >= 0 ? "+" : ""}${unreal.toFixed(3)}%`
          : `│  flat — waiting for ${buyLabel}`,
        `│`,
        `│  PORTFOLIO`,
        `│  $${equity.toFixed(2)}  ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(3)}%  trades ${trades}  wins ${wins}  WR ${trades > 0 ? (wins / Math.ceil(trades / 2) * 100).toFixed(0) : "—"}%  maxDD ${maxDD.toFixed(2)}%`,
        `│`,
        `│  TRADE LOG`,
        ...(tradeLog.length === 0
          ? ["│  no trades yet"]
          : tradeLog.slice(-8).map(t =>
              `│  ${t.time}  ${t.side.padEnd(4)}  $${t.price.toFixed(2).padEnd(9)} [${t.signal}]${t.pnlPct !== undefined ? `  →  ${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(3)}%` : ""}`
            )),
        `└${sep}`,
      ];

      process.stdout.write("\x1b[2J\x1b[H");
      console.log(lines.join("\n"));

    } catch (e: unknown) {
      console.error("Poll error:", e instanceof Error ? e.message : e);
    }

    await new Promise(r => setTimeout(r, POLL_SECS * 1000));
  }
}

main().catch(console.error);
