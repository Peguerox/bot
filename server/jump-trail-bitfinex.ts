// NO LONGER REAL MONEY. Worker 2's Render service/API key repurposed 2026-09-07 from the ETH
// Jump+ratchet live trading bot (retired after real trading badly diverged from its own
// backtest -- see project_ratchet_whipsaw_finding memory) into a signal-agnostic live
// microstructure logger. No entry/exit logic, no orders, no positions held. Every 1s this
// snapshots live book/spread/trade-flow/cross-venue conditions for BOTH BTC and ETH on Bitfinex
// (+ Binance for cross-venue features) and, once 60s has passed, backfills what price actually
// did next (5s/15s/30s/60s) before writing one labeled row to `market_ticks`. Purpose: build a
// dataset to mine for real stay/exit or entry/exit patterns (starting with plain supervised
// classification: predict up/down/flat per horizon) instead of guessing at static rules first.
// Runs on Worker 2's existing pod so the 2-worker budget stays at 2 -- no new Render service.
// Worker 1 continues live BTC trading in parallel (plain trail, see zscore-trail-bitfinex.ts).
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import WebSocket from "ws";
import { insertMarketTick } from "../lib/market-ticks-db";

const SYMBOLS = [
  { bfx: "tBTCUSD", binance: "btcusdt" },
  { bfx: "tETHUSD", binance: "ethusdt" },
];

const HISTORY_MS = 65_000; // slightly more than the 60s max label horizon
const LABEL_HORIZONS_MS = [5_000, 15_000, 30_000, 60_000];
const SLIPPAGE_NOTIONAL_USD = 500;
const FLAT_EPS_PCT = 0.005;

type BookLevel = { count: number; amount: number };
type Trade = { ts: number; price: number; amount: number };
type HistEntry = { ts: number; mid: number; spreadPct: number; imbalance: number };
type Pending = { ts: number; mid: number; features: Record<string, unknown> };

type SymState = {
  bfx: string;
  binance: string;
  book: Map<number, BookLevel>;
  bookChanId: number | null;
  bookReady: boolean;
  tradesChanId: number | null;
  trades: Trade[];
  history: HistEntry[];
  pending: Pending[];
  prevLevelKey: Set<string>;
  binanceBid: number | null;
  binanceAsk: number | null;
  binanceBidQty: number | null;
  binanceAskQty: number | null;
  prevVelocity1s: number | null;
};

const states = new Map<string, SymState>();
for (const s of SYMBOLS) {
  states.set(s.bfx, {
    bfx: s.bfx, binance: s.binance,
    book: new Map(), bookChanId: null, bookReady: false,
    tradesChanId: null, trades: [], history: [], pending: [],
    prevLevelKey: new Set(),
    binanceBid: null, binanceAsk: null, binanceBidQty: null, binanceAskQty: null,
    prevVelocity1s: null,
  });
}

function applyBookRow(state: SymState, row: [number, number, number]) {
  const [price, count, amount] = row;
  if (count === 0) state.book.delete(price);
  else state.book.set(price, { count, amount });
}

function bestBidAsk(state: SymState): { bid: number | null; ask: number | null } {
  let bid: number | null = null, ask: number | null = null;
  for (const [price, lvl] of state.book) {
    if (lvl.amount > 0 && (bid === null || price > bid)) bid = price;
    if (lvl.amount < 0 && (ask === null || price < ask)) ask = price;
  }
  return { bid, ask };
}

function sortedLevels(state: SymState, side: "bid" | "ask"): { price: number; size: number }[] {
  const rows = [...state.book.entries()]
    .filter(([, lvl]) => (side === "bid" ? lvl.amount > 0 : lvl.amount < 0))
    .map(([price, lvl]) => ({ price, size: Math.abs(lvl.amount) }));
  rows.sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
  return rows;
}

function depthSum(levels: { size: number }[], n: number): number {
  return levels.slice(0, n).reduce((s, l) => s + l.size, 0);
}

function estimateSlippagePct(levels: { price: number; size: number }[], bestPrice: number, notionalUsd: number): number | null {
  let remaining = notionalUsd, cost = 0, filled = 0;
  for (const l of levels) {
    const levelNotional = l.price * l.size;
    const take = Math.min(remaining, levelNotional);
    const takeSize = take / l.price;
    cost += take;
    filled += takeSize;
    remaining -= take;
    if (remaining <= 0) break;
  }
  if (filled === 0 || remaining > 0) return null; // book too thin to fill
  const avgPrice = cost / filled;
  return (avgPrice - bestPrice) / bestPrice * 100;
}

function findHistAt(state: SymState, msAgo: number, now: number): HistEntry | null {
  const target = now - msAgo;
  let best: HistEntry | null = null, bestDiff = Infinity;
  for (const h of state.history) {
    const diff = Math.abs(h.ts - target);
    if (diff < bestDiff) { bestDiff = diff; best = h; }
  }
  return bestDiff <= 1_500 ? best : null;
}

function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function computeFeatures(state: SymState, now: number): { mid: number; features: Record<string, unknown> } | null {
  const { bid, ask } = bestBidAsk(state);
  if (bid === null || ask === null) return null;
  const mid = (bid + ask) / 2;
  const spreadPct = (ask - bid) / mid * 100;

  const bidLevels = sortedLevels(state, "bid");
  const askLevels = sortedLevels(state, "ask");
  const bidDepthTop3 = depthSum(bidLevels, 3), bidDepthTop10 = depthSum(bidLevels, 10);
  const askDepthTop3 = depthSum(askLevels, 3), askDepthTop10 = depthSum(askLevels, 10);
  const imbalance = (bidDepthTop10 - askDepthTop10) / (bidDepthTop10 + askDepthTop10 || 1);

  const bidSize0 = bidLevels[0]?.size ?? 0, askSize0 = askLevels[0]?.size ?? 0;
  const microprice = (bidSize0 + askSize0) > 0
    ? (bid * askSize0 + ask * bidSize0) / (bidSize0 + askSize0)
    : mid;
  const micropriceDivergencePct = (microprice - mid) / mid * 100;

  const levelKey = new Set<string>([...state.book.entries()].map(([p, l]) => `${p}:${l.amount}`));
  let churn = 0;
  for (const k of levelKey) if (!state.prevLevelKey.has(k)) churn++;
  for (const k of state.prevLevelKey) if (!levelKey.has(k)) churn++;
  state.prevLevelKey = levelKey;

  const recentTrades5s = state.trades.filter((t) => t.ts >= now - 5_000);
  const trades60s = state.trades.filter((t) => t.ts >= now - 60_000);
  const lastTrade = state.trades[state.trades.length - 1] ?? null;
  const buyVol5s = recentTrades5s.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const sellVol5s = recentTrades5s.filter((t) => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
  const vwap5sNotional = recentTrades5s.reduce((s, t) => s + t.price * Math.abs(t.amount), 0);
  const vwap5sVolume = recentTrades5s.reduce((s, t) => s + Math.abs(t.amount), 0);
  const vwap5s = vwap5sVolume > 0 ? vwap5sNotional / vwap5sVolume : null;
  const avgTradeSize60s = trades60s.length > 0
    ? trades60s.reduce((s, t) => s + Math.abs(t.amount), 0) / trades60s.length
    : null;
  const maxTradeSize5s = recentTrades5s.length > 0 ? Math.max(...recentTrades5s.map((t) => Math.abs(t.amount))) : 0;
  const largeTradeFlag = avgTradeSize60s !== null && avgTradeSize60s > 0 && maxTradeSize5s > 5 * avgTradeSize60s;

  const vel1s = findHistAt(state, 1_000, now);
  const vel5s = findHistAt(state, 5_000, now);
  const vel15s = findHistAt(state, 15_000, now);
  const vel30s = findHistAt(state, 30_000, now);
  const vel60s = findHistAt(state, 60_000, now);
  const velocity1sPct = vel1s ? (mid - vel1s.mid) / vel1s.mid * 100 : null;
  const acceleration = velocity1sPct !== null && state.prevVelocity1s !== null ? velocity1sPct - state.prevVelocity1s : null;
  if (velocity1sPct !== null) state.prevVelocity1s = velocity1sPct;

  const recentHist = state.history.slice(-15);
  const returns1s: number[] = [];
  for (let i = 1; i < recentHist.length; i++) returns1s.push((recentHist[i].mid - recentHist[i - 1].mid) / recentHist[i - 1].mid * 100);
  const realizedVol15s = stdev(returns1s);
  const spreadVol15s = stdev(recentHist.map((h) => h.spreadPct));
  const imbalanceTrend5s = vel5s ? imbalance - vel5s.imbalance : null;

  const slippageBuyPct = estimateSlippagePct(askLevels, ask, SLIPPAGE_NOTIONAL_USD);
  const slippageSellPct = estimateSlippagePct(bidLevels, bid, SLIPPAGE_NOTIONAL_USD);

  let binance: Record<string, unknown> | null = null;
  if (state.binanceBid !== null && state.binanceAsk !== null) {
    const bMid = (state.binanceBid + state.binanceAsk) / 2;
    const bImb = state.binanceBidQty !== null && state.binanceAskQty !== null && (state.binanceBidQty + state.binanceAskQty) > 0
      ? (state.binanceBidQty - state.binanceAskQty) / (state.binanceBidQty + state.binanceAskQty)
      : null;
    binance = {
      mid: bMid,
      bestBid: state.binanceBid,
      bestAsk: state.binanceAsk,
      spreadPct: (state.binanceAsk - state.binanceBid) / bMid * 100,
      imbalance: bImb,
      venueGapPct: (bMid - mid) / mid * 100,
    };
  }

  return {
    mid,
    features: {
      bestBid: bid, bestAsk: ask, spreadPct,
      bidDepthTop3, bidDepthTop10, askDepthTop3, askDepthTop10,
      imbalance, bidLevelCount: bidLevels.length, askLevelCount: askLevels.length,
      bidSlope: bidDepthTop10 > 0 ? bidDepthTop3 / bidDepthTop10 : null,
      askSlope: askDepthTop10 > 0 ? askDepthTop3 / askDepthTop10 : null,
      bookChurn: churn,
      microprice, micropriceDivergencePct,
      lastTradePrice: lastTrade?.price ?? null,
      lastTradeSize: lastTrade ? Math.abs(lastTrade.amount) : null,
      lastTradeSide: lastTrade ? (lastTrade.amount > 0 ? "buy" : "sell") : null,
      timeSinceLastTradeMs: lastTrade ? now - lastTrade.ts : null,
      tradeRate1s: state.trades.filter((t) => t.ts >= now - 1_000).length,
      buyVol5s, sellVol5s, vwap5s, largeTradeFlag,
      velocity1sPct,
      velocity5sPct: vel5s ? (mid - vel5s.mid) / vel5s.mid * 100 : null,
      velocity15sPct: vel15s ? (mid - vel15s.mid) / vel15s.mid * 100 : null,
      velocity30sPct: vel30s ? (mid - vel30s.mid) / vel30s.mid * 100 : null,
      velocity60sPct: vel60s ? (mid - vel60s.mid) / vel60s.mid * 100 : null,
      acceleration, realizedVol15s, spreadVol15s, imbalanceTrend5s,
      slippageBuyPct, slippageSellPct,
      binance,
    },
  };
}

function labelDirection(pctChange: number): "up" | "down" | "flat" {
  if (pctChange > FLAT_EPS_PCT) return "up";
  if (pctChange < -FLAT_EPS_PCT) return "down";
  return "flat";
}

async function flushPending(state: SymState, now: number) {
  const ready = state.pending.filter((p) => now - p.ts >= 60_000);
  if (ready.length === 0) return;
  state.pending = state.pending.filter((p) => now - p.ts < 60_000);

  for (const p of ready) {
    const labels: Record<string, unknown> = {};
    // Look up actual future prices relative to p.ts (not "now"-relative), via direct scan.
    for (const horizonMs of LABEL_HORIZONS_MS) {
      const targetTs = p.ts + horizonMs;
      let best: HistEntry | null = null, bestDiff = Infinity;
      for (const h of state.history) {
        const diff = Math.abs(h.ts - targetTs);
        if (diff < bestDiff) { bestDiff = diff; best = h; }
      }
      const key = `${horizonMs / 1000}s`;
      if (best && bestDiff <= 1_500) {
        const pct = (best.mid - p.mid) / p.mid * 100;
        labels[`pct${key}`] = pct;
        labels[`dir${key}`] = labelDirection(pct);
      } else {
        labels[`pct${key}`] = null;
        labels[`dir${key}`] = null;
      }
    }
    await insertMarketTick({
      symbol: state.bfx,
      ts: new Date(p.ts).toISOString(),
      mid_price: p.mid,
      features: p.features,
      labels,
    });
  }
}

function connectBitfinex() {
  const ws = new WebSocket("wss://api-pub.bitfinex.com/ws/2");

  ws.on("open", () => {
    console.log("Bitfinex WS connected, subscribing book+trades for", SYMBOLS.map((s) => s.bfx).join(", "));
    for (const s of SYMBOLS) {
      ws.send(JSON.stringify({ event: "subscribe", channel: "book", symbol: s.bfx, prec: "P0", freq: "F0", len: "25" }));
      ws.send(JSON.stringify({ event: "subscribe", channel: "trades", symbol: s.bfx }));
    }
  });

  const chanToSymbol = new Map<number, { bfx: string; channel: "book" | "trades" }>();

  ws.on("message", (raw: Buffer) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "subscribed") {
      if (msg.channel === "book" || msg.channel === "trades") {
        chanToSymbol.set(msg.chanId, { bfx: msg.symbol, channel: msg.channel });
        const state = states.get(msg.symbol);
        if (state) {
          if (msg.channel === "book") { state.bookChanId = msg.chanId; state.book.clear(); state.bookReady = false; }
          else state.tradesChanId = msg.chanId;
        }
      }
      return;
    }

    if (!Array.isArray(msg) || msg[1] === "hb") return;
    const meta = chanToSymbol.get(msg[0]);
    if (!meta) return;
    const state = states.get(meta.bfx);
    if (!state) return;

    if (meta.channel === "book") {
      const data = msg[1];
      if (Array.isArray(data[0])) {
        state.book.clear();
        for (const row of data) applyBookRow(state, row);
        state.bookReady = true;
      } else {
        applyBookRow(state, data);
      }
    } else if (meta.channel === "trades") {
      if (msg[1] === "te") {
        const [, , mts, amount, price] = msg[2];
        state.trades.push({ ts: mts, price, amount });
      }
      // ignore "tu" (duplicate/updated copy of the same trade) and the initial snapshot array
    }
  });

  ws.on("error", (err) => console.error("Bitfinex WS error:", err));
  ws.on("close", () => {
    console.log("Bitfinex WS closed, reconnecting in 2s...");
    for (const state of states.values()) { state.bookReady = false; state.book.clear(); }
    setTimeout(connectBitfinex, 2_000);
  });
}

function connectBinance() {
  const streams = SYMBOLS.map((s) => `${s.binance}@bookTicker`).join("/");
  const ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
  const streamToBfx = new Map(SYMBOLS.map((s) => [`${s.binance}@bookTicker`, s.bfx]));

  ws.on("open", () => console.log("Binance WS connected, streaming bookTicker for", SYMBOLS.map((s) => s.binance).join(", ")));

  ws.on("message", (raw: Buffer) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const bfx = streamToBfx.get(msg.stream);
    if (!bfx) return;
    const state = states.get(bfx);
    if (!state) return;
    const d = msg.data;
    state.binanceBid = parseFloat(d.b);
    state.binanceAsk = parseFloat(d.a);
    state.binanceBidQty = parseFloat(d.B);
    state.binanceAskQty = parseFloat(d.A);
  });

  ws.on("error", (err) => console.error("Binance WS error:", err));
  ws.on("close", () => {
    console.log("Binance WS closed, reconnecting in 2s...");
    setTimeout(connectBinance, 2_000);
  });
}

async function tick() {
  const now = Date.now();
  for (const state of states.values()) {
    if (!state.bookReady) continue;
    const result = computeFeatures(state, now);
    if (!result) continue;
    const { mid, features } = result;
    state.history.push({ ts: now, mid, spreadPct: features.spreadPct as number, imbalance: features.imbalance as number });
    state.history = state.history.filter((h) => now - h.ts <= HISTORY_MS);
    state.trades = state.trades.filter((t) => now - t.ts <= HISTORY_MS);
    state.pending.push({ ts: now, mid, features });
    await flushPending(state, now);
  }
}

async function main() {
  connectBitfinex();
  connectBinance();
  setInterval(() => { tick().catch((err) => console.error("tick error:", err)); }, 1_000);
  console.log("Market microstructure logger running (BTC + ETH, no orders, no real money).");
}

main().catch((err) => { console.error(err); process.exit(1); });
