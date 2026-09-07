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
// Worker 1 continues live BTC trading in parallel (see server/zscore-trail-bitfinex.ts and, once
// promoted, server/btc-predictor-bitfinex.ts -- the live predictor built from this data).
//
// Feature computation lives in lib/market-features.ts, shared with the live predictor, so
// training and live inference can never silently drift apart (see that file's header).
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import WebSocket from "ws";
import { insertMarketTick } from "../lib/market-ticks-db";
import {
  createFeatureState, applyBookRow, computeFeatures, updateHistory,
  type FeatureState, type HistEntry,
} from "../lib/market-features";

const SYMBOLS = [
  { bfx: "tBTCUSD", binance: "btcusdt" },
  { bfx: "tETHUSD", binance: "ethusdt" },
];

const LABEL_HORIZONS_MS = [5_000, 15_000, 30_000, 60_000];
const FLAT_EPS_PCT = 0.005;

type Pending = { ts: number; mid: number; features: Record<string, unknown> };
type LoggerState = FeatureState & { bfx: string; binance: string; pending: Pending[] };

const states = new Map<string, LoggerState>();
for (const s of SYMBOLS) {
  states.set(s.bfx, { ...createFeatureState(), bfx: s.bfx, binance: s.binance, pending: [] });
}

function labelDirection(pctChange: number): "up" | "down" | "flat" {
  if (pctChange > FLAT_EPS_PCT) return "up";
  if (pctChange < -FLAT_EPS_PCT) return "down";
  return "flat";
}

async function flushPending(state: LoggerState, now: number) {
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
          if (msg.channel === "book") { state.book.clear(); state.bookReady = false; }
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
        // te payload is [ID, MTS, AMOUNT, PRICE] -- only skip ID, not ID+MTS.
        const [, mts, amount, price] = msg[2];
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
    updateHistory(state, now, mid, features.spreadPct as number, features.imbalance as number);
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
