import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Compares REAL live trade results against what the backtest would have predicted for the exact
// same real historical window -- same methodology used manually throughout this session (fetch
// real Binance/Bitfinex candles for the live bot's actual trading window, replay the same signal
// logic, compare aggregate stats). Turned into a standing dashboard feature instead of a one-off
// script, per request, so it doesn't need to be re-asked for every time.
//
// As of 2026-09-07 (updated): Worker 1 ("zscore" query param, kept for the existing dashboard
// button) is BTC/tBTCUSD, running Jump entry + a PLAIN 0.1% trailing stop (no ratchet/breakeven
// arm -- reverted the same day after the ratchet exit was found to whipsaw badly on real chop,
// see project_ratchet_whipsaw_finding memory). Worker 2 ("jump-trail" config, ETH/tETHUSD) no
// longer trades real money at all -- its Render service was repurposed into the market
// microstructure logger (see project_market_ticks_logger memory) -- this config entry is now
// unused/stale, kept only so the route doesn't 500 if something still calls it.
//
// Uses data-api.binance.vision, not api.binance.com -- Binance geo-blocks Vercel's server IPs
// from api.binance.com directly (see app/api/buy-hold and app/api/eth-zscore-live for the same
// fix applied earlier).

const JUMP_PCT = 0.02;
const TRAIL_PCT = 0.1;

const BOT_CONFIG = {
  "jump-trail": { table: "sol_jump_trail_bitfinex_trades", binanceSymbol: "ETHUSDT", bfxSymbol: "tETHUSD", halfSpreadPct: 0.0072 },
  "zscore":     { table: "eth_zscore_bitfinex_trades",      binanceSymbol: "BTCUSDT", bfxSymbol: "tBTCUSD", halfSpreadPct: 0.00772 },
} as const;

type Candle = { time: number; open: number; close: number; high: number; low: number };

async function fetchBinance(symbol: string, start: number, end: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let cursor = start;
  while (cursor < end) {
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${cursor}&endTime=${end}&limit=1000`;
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    for (const k of data) all.push({ time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]) });
    const last = data[data.length - 1][0];
    if (last <= cursor) break;
    cursor = last + 60_000;
    if (data.length < 1000) break;
  }
  return all;
}

async function fetchBitfinex(symbol: string, start: number, end: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let cursor = start;
  while (cursor < end) {
    const url = `https://api-pub.bitfinex.com/v2/candles/trade:1m:${symbol}/hist?start=${cursor}&end=${end}&limit=1000&sort=1`;
    const res = await fetch(url, { cache: "no-store" });
    const data: number[][] = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    for (const c of data) all.push({ time: c[0], open: c[1], close: c[2], high: c[3], low: c[4] });
    const last = data[data.length - 1][0];
    if (last <= cursor) break;
    cursor = last + 1;
    if (data.length < 1000) break;
  }
  return all;
}

function computeStop(entryPrice: number, extremePrice: number): number {
  return extremePrice * (1 - TRAIL_PCT / 100);
}

function runBacktest(binance: Candle[], bfxByTime: Map<number, Candle>, bfxTimesSorted: number[], halfSpreadPct: number) {
  let trades = 0, wins = 0, totalPnlPct = 0;
  let cooldownUntilIdx = -1;

  for (let i = 1; i < binance.length; i++) {
    if (i <= cooldownUntilIdx) continue;
    const jump = (binance[i].close - binance[i - 1].close) / binance[i - 1].close * 100 >= JUMP_PCT;
    if (jump) {
      const signalTime = binance[i].time;
      const entryIdx = bfxTimesSorted.indexOf(signalTime);
      const bfxEntryCandle = bfxByTime.get(signalTime);
      if (bfxEntryCandle && entryIdx !== -1 && entryIdx + 1 < bfxTimesSorted.length) {
        const entryAsk = bfxEntryCandle.close * (1 + halfSpreadPct / 100);
        let stop = computeStop(entryAsk, bfxEntryCandle.close);
        let peak = bfxEntryCandle.close;
        let exited = false;
        for (let j = entryIdx + 1; j < bfxTimesSorted.length; j++) {
          const c = bfxByTime.get(bfxTimesSorted[j])!;
          const bidLow = c.low * (1 - halfSpreadPct / 100);
          if (bidLow <= stop) {
            const pnlPct = (stop - entryAsk) / entryAsk * 100;
            totalPnlPct += pnlPct;
            trades++;
            if (pnlPct > 0) wins++;
            exited = true;
            const exitTime = bfxTimesSorted[j];
            while (cooldownUntilIdx + 1 < binance.length && binance[cooldownUntilIdx + 1].time < exitTime) cooldownUntilIdx++;
            break;
          }
          if (c.high > peak) peak = c.high;
          stop = computeStop(entryAsk, peak);
        }
        if (!exited) { /* unresolved at end of fetched window, skip */ }
      }
    }
  }
  return { trades, wins, totalPnlPct };
}

export async function GET(req: NextRequest) {
  const bot = req.nextUrl.searchParams.get("bot"); // "jump-trail" | "zscore"
  if (bot !== "jump-trail" && bot !== "zscore") {
    return NextResponse.json({ ok: false, error: "bot must be jump-trail or zscore" }, { status: 400 });
  }
  if (bot === "zscore") {
    // Worker 1 switched 2026-09-08 to a locked ML predictor (lib/btc-ml-predictor.ts) whose
    // entry depends on binance_imbalance -- real order-book bid/ask sizes, which this route's
    // 1-min OHLC candle data structurally cannot provide. No honest backtest replay is possible
    // here anymore; report that plainly instead of silently comparing against a stale/wrong
    // strategy (exactly the bug found and fixed earlier this session for the ratchet exit).
    return NextResponse.json({
      ok: false,
      error: "Not available for the current BTC ML predictor strategy -- it needs live order-book data (bid/ask sizes) that 1-min candles can't reconstruct. See project_market_ticks_logger memory.",
    });
  }
  const cfg = BOT_CONFIG[bot];

  const sb = getSupabaseAdmin();
  const { data: trades, error } = await sb.from(cfg.table).select("*").order("entry_time", { ascending: true });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!trades || trades.length === 0) {
    return NextResponse.json({ ok: false, error: "No real trades yet for this bot" });
  }

  const warmupMs = 5 * 60_000; // jump only needs the prior candle
  const start = new Date(trades[0].entry_time).getTime() - warmupMs;
  const end = new Date(trades[trades.length - 1].exit_time).getTime() + 5 * 60_000;

  const [binance, bfx] = await Promise.all([
    fetchBinance(cfg.binanceSymbol, start, end),
    fetchBitfinex(cfg.bfxSymbol, start, end),
  ]);
  const bfxByTime = new Map<number, Candle>();
  for (const c of bfx) bfxByTime.set(c.time, c);
  const bfxTimesSorted = bfx.map((c) => c.time).sort((a, b) => a - b);

  const bt = runBacktest(binance, bfxByTime, bfxTimesSorted, cfg.halfSpreadPct);

  const realWins = trades.filter((t: any) => t.pnl_usd > 0).length;
  const realSumPct = trades.reduce((s: number, t: any) => s + t.pnl_pct, 0);
  const realSumUsd = trades.reduce((s: number, t: any) => s + t.pnl_usd, 0);

  return NextResponse.json({
    ok: true,
    windowStart: new Date(start).toISOString(),
    windowEnd: new Date(end).toISOString(),
    real: {
      trades: trades.length,
      wins: realWins,
      winRate: (realWins / trades.length) * 100,
      sumPnlPct: realSumPct,
      sumPnlUsd: realSumUsd,
    },
    backtest: {
      trades: bt.trades,
      wins: bt.wins,
      winRate: bt.trades ? (bt.wins / bt.trades) * 100 : 0,
      sumPnlPct: bt.totalPnlPct,
    },
  });
}
