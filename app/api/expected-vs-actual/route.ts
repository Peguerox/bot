import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getBitfinexTradesRange } from "@/lib/bitfinex";
import { initialState, processBatch, closeMinute, TINY_SOL, type Batch, type EngineState } from "@/lib/solbtc-sizeconf-engine";
import { runSurferSolbtcReplay, type Candle as SolbtcCandle } from "@/lib/surfer-solbtc-replay";
import { runSurferSolusdtReplay, type Candle15m } from "@/lib/surfer-solusdt-replay";
import { runHypertradeReplay, type Candle as HtCandle } from "@/lib/hypertrade-replay";
import { SEED_USD as HT_SEED_USD } from "@/lib/sol-hypertrade-config";

// Compares REAL live trade results against what the backtest would have predicted for the exact
// same real historical window -- same methodology used manually throughout this session (fetch
// real Binance/Bitfinex candles for the live bot's actual trading window, replay the same signal
// logic, compare aggregate stats). Turned into a standing dashboard feature instead of a one-off
// script, per request, so it doesn't need to be re-asked for every time.
//
// Worker 2 ("jump-trail" config) was the market microstructure logger for a while, now
// repurposed back into a real SOL/tSOLUSD Jump Trail bot with a wider 0.2% trail (testing
// whether that survives Jump's real overtrading tendency better than 0.1%).
//
// Uses data-api.binance.vision, not api.binance.com -- Binance geo-blocks Vercel's server IPs
// from api.binance.com directly (see app/api/buy-hold for the same fix applied earlier).

const JUMP_PCT = 0.02;

const BOT_CONFIG = {
  "jump-trail": { table: "sol_jump_trail_bitfinex_trades", binanceSymbol: "SOLUSDT", bfxSymbol: "tSOLUSD", halfSpreadPct: 0.00975, trailPct: 0.2 },
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

function computeStop(extremePrice: number, trailPct: number): number {
  return extremePrice * (1 - trailPct / 100);
}

function runBacktest(binance: Candle[], bfxByTime: Map<number, Candle>, bfxTimesSorted: number[], halfSpreadPct: number, trailPct: number) {
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
        let stop = computeStop(bfxEntryCandle.close, trailPct);
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
          stop = computeStop(peak, trailPct);
        }
        if (!exited) { /* unresolved at end of fetched window, skip */ }
      }
    }
  }
  return { trades, wins, totalPnlPct };
}

// SOL/BTC Size Confirmation: replays the EXACT SAME verified engine module the live worker uses
// (lib/solbtc-sizeconf-engine.ts) over Bitfinex's real trade tape for the live bot's actual
// window, batch-for-batch and minute-close-for-minute-close the same way the live worker does it
// (see server/sol-dca-bitfinex.ts). No separate/approximate backtest implementation -- if this
// diverges from what actually happened live, it's a real signal, not implementation drift between
// two different codebases. Starts the replay from the bot's actual first recorded activity (its
// earliest run log -- run logs are written every 5min from boot once enabled) rather than a fixed
// buffer before the first trade: an early version used "60min before the first trade" and it
// produced a real, understandable false divergence on fill #1 -- the live worker had actually
// been running for ~1h28m before that trade with a real 30-minute activity-gate history already
// built up, which a shorter replay window couldn't reproduce. Using the true known start fixes
// that class of mismatch instead of just guessing a bigger buffer.
async function runSizeconfComparison() {
  const sb = getSupabaseAdmin();
  const [{ data: trades, error }, { data: earliestRun }] = await Promise.all([
    sb.from("solbtc_sizeconf_trades").select("*").order("fill_time", { ascending: true }),
    sb.from("solbtc_sizeconf_runs").select("run_at").order("run_at", { ascending: true }).limit(1).maybeSingle(),
  ]);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!trades || trades.length === 0) {
    return NextResponse.json({ ok: false, error: "No real trades yet for this bot" });
  }

  const fallbackWarmupMs = 60 * 60_000;
  const firstTradeMs = new Date(trades[0].fill_time).getTime();
  const earliestRunMs = earliestRun?.run_at ? new Date(earliestRun.run_at).getTime() : null;
  const start = earliestRunMs !== null ? Math.min(earliestRunMs, firstTradeMs - fallbackWarmupMs) : firstTradeMs - fallbackWarmupMs;
  const end = Date.now();

  const rawTrades = await getBitfinexTradesRange("tSOLBTC", start, end);
  if (rawTrades.length === 0) {
    return NextResponse.json({ ok: false, error: "No real Bitfinex trade data returned for this window" });
  }

  // group into same-millisecond-timestamp batches, preserving source order -- identical
  // convention to the research CSVs and to the live worker's own batch buffering.
  const batches: Batch[] = [];
  let i = 0;
  while (i < rawTrades.length) {
    const tsMs = rawTrades[i].tsMs;
    let j = i;
    let firstPrice = rawTrades[i].price, lastPrice = rawTrades[i].price;
    let signedCount = 0, count = 0, tinySignedCount = 0, tinyCount = 0;
    while (j < rawTrades.length && rawTrades[j].tsMs === tsMs) {
      const sign = Math.sign(rawTrades[j].amount);
      signedCount += sign; count += 1;
      if (Math.abs(rawTrades[j].amount) < TINY_SOL) { tinySignedCount += sign; tinyCount += 1; }
      lastPrice = rawTrades[j].price;
      j++;
    }
    batches.push({ tsMs, firstPrice, lastPrice, signedCount, count, tinySignedCount, tinyCount });
    i = j;
  }

  // forward-filled minute grid, same as verify_ts_engine.ts / the live worker's advanceMinutes()
  const firstMinute = Math.floor(batches[0].tsMs / 60_000);
  const lastMinute = Math.floor(batches[batches.length - 1].tsMs / 60_000);
  const minuteClose = new Map<number, number>();
  const minuteCount = new Map<number, number>();
  for (const b of batches) {
    const mi = Math.floor(b.tsMs / 60_000);
    minuteClose.set(mi, b.lastPrice);
    minuteCount.set(mi, (minuteCount.get(mi) ?? 0) + b.count);
  }
  let lastC = minuteClose.get(firstMinute) ?? batches[0].firstPrice;
  const filledClose = new Map<number, number>();
  for (let m = firstMinute; m <= lastMinute; m++) {
    if (minuteClose.has(m)) lastC = minuteClose.get(m)!;
    filledClose.set(m, lastC);
  }

  // The live worker's internal drawdown-tightening math now uses the REAL measured spread at
  // each fill (see server/sol-dca-bitfinex.ts), not a flat assumption -- so this replay needs the
  // same real per-fill costs to stay a faithful comparison, not an approximation drifting on its
  // own flat guess. Since historical order-book depth isn't stored, use the actual recorded
  // cost_pct from each real fill, in order, falling back to the flat COST constant for whichever
  // fill(s) didn't have a live book snapshot yet (recorded as cost_pct=null).
  const realCostSequence: (number | null)[] = trades.map((t: any) => t.cost_pct !== null ? parseFloat(t.cost_pct) : null);

  let state: EngineState = initialState();
  let lastMinuteClosed = firstMinute - 1;
  const backtestFills: { side: string; fillPrice: number; fillTime: string }[] = [];

  for (const b of batches) {
    const batchMinute = Math.floor(b.tsMs / 60_000);
    while (lastMinuteClosed + 1 < batchMinute) {
      const m = lastMinuteClosed + 1;
      state = closeMinute(state, filledClose.get(m)!, minuteCount.get(m) ?? 0);
      lastMinuteClosed = m;
    }
    const costPct = realCostSequence[backtestFills.length] ?? undefined;
    const res = processBatch(state, b, costPct);
    state = res.state;
    if (res.fill) {
      backtestFills.push({ side: res.fill.side, fillPrice: res.fill.fillPrice, fillTime: new Date(b.tsMs).toISOString() });
    }
  }

  const realFills = trades.map((t: any) => ({ side: t.side_after, fillPrice: parseFloat(t.fill_price), fillTime: t.fill_time }));

  // Side+price is the correctness check -- fill TIME can legitimately drift by up to a couple
  // minutes without indicating a bug: the live worker misses whatever real trades happen during
  // a brief Render restart (deploys happened multiple times today) and can't backfill that gap,
  // while this replay reads the full continuous historical record with no gaps. Surfaced as
  // timeDeltaS per pair rather than hidden, instead of only checking side+price silently.
  //
  // Checks EVERY row, not just up to the first mismatch -- an earlier version stopped at the
  // first divergence and let the frontend silently assume every later row matched (it hadn't
  // actually been checked). Found by the user noticing the summary count ("6 of 10") didn't
  // match the number of checkmarks actually shown (9 of 10) in the per-row table.
  const n = Math.min(realFills.length, backtestFills.length);
  const rowMatches: boolean[] = [];
  const timeDeltasS: (number | null)[] = [];
  let firstDivergenceIndex: number | null = null;
  let matchedCount = 0;
  for (let k = 0; k < n; k++) {
    const isMatch = realFills[k].side === backtestFills[k].side && Math.abs(realFills[k].fillPrice - backtestFills[k].fillPrice) <= 1e-9;
    rowMatches.push(isMatch);
    if (isMatch) {
      matchedCount++;
      timeDeltasS.push((new Date(realFills[k].fillTime).getTime() - new Date(backtestFills[k].fillTime).getTime()) / 1000);
    } else {
      if (firstDivergenceIndex === null) firstDivergenceIndex = k;
      timeDeltasS.push(null);
    }
  }
  if (realFills.length !== backtestFills.length) {
    if (firstDivergenceIndex === null) firstDivergenceIndex = n;
  }

  // Total return comparison (the actual point of the "Backtest" column) -- not just per-fill
  // side/price matching, but the real question: over this exact real window, did replaying the
  // same code produce the same overall P&L as what actually happened live? Reconstructs a
  // portfolio for each fill sequence independently (real fills/costs vs backtest fills/costs,
  // same cost_pct reused per index per the comment above) and marks any still-open position to
  // the last known real price, so an in-progress cycle doesn't get silently dropped.
  const currentPrice = batches[batches.length - 1].lastPrice;
  function totalReturnPct(fills: { side: string; fillPrice: number }[], costs: (number | null)[]): number {
    let btc = 1, sol = 0;
    for (let k = 0; k < fills.length; k++) {
      const cost = costs[k] ?? 0.0002;
      if (fills[k].side === "SOL") { sol = btc * (1 - cost) / fills[k].fillPrice; btc = 0; }
      else { btc = sol * fills[k].fillPrice * (1 - cost); sol = 0; }
    }
    const finalValue = btc + sol * currentPrice;
    return (finalValue - 1) * 100;
  }
  const realTotalReturnPct = totalReturnPct(realFills, realCostSequence);
  const backtestTotalReturnPct = totalReturnPct(backtestFills, realCostSequence);

  return NextResponse.json({
    ok: true,
    windowStart: new Date(start).toISOString(),
    windowEnd: new Date(end).toISOString(),
    realTotalReturnPct,
    backtestTotalReturnPct,
    matchedCount,
    rowMatches,
    real: { trades: realFills.length, fills: realFills },
    backtest: { trades: backtestFills.length, fills: backtestFills },
    exactMatch: firstDivergenceIndex === null,
    firstDivergenceIndex,
    timeDeltasS,
  });
}

async function fetchBinanceUsCandles(symbol: string, interval: string, startMs: number, endMs: number): Promise<{ time: number; open: number; high: number; low: number; close: number }[]> {
  const out: { time: number; open: number; high: number; low: number; close: number }[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) break;
    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const c of raw) out.push({ time: Number(c[0]), open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]) });
    const newest = Number(raw[raw.length - 1][0]);
    if (raw.length < 1000 || newest >= endMs) break;
    cursor = newest + 1;
  }
  return out;
}

async function fetchBitfinex1mCandles(symbol: string, startMs: number, endMs: number): Promise<HtCandle[]> {
  const out: HtCandle[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `https://api-pub.bitfinex.com/v2/candles/trade:1m:${symbol}/hist?start=${cursor}&end=${endMs}&limit=1000&sort=1`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) break;
    const raw = await res.json() as number[][];
    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const c of raw) out.push({ time: c[0], open: c[1], high: c[3], low: c[4], close: c[2] });
    const newest = raw[raw.length - 1][0];
    if (raw.length < 1000 || newest >= endMs) break;
    cursor = newest + 1;
  }
  return out;
}

// Surfer SOLBTC -- "buffered rotation" v2, live since 2026-09-14. Needs H_WINDOW_MIN (6190min,
// ~4.3 days) of 1-min-candle history BEFORE the window being judged, so the fetch always starts
// that much earlier than the bot's real first run -- otherwise the replay would spuriously "miss"
// signals the live bot could actually see (it has been running since well before its first v2
// trade and had that history available).
async function runSurferSolbtcComparison() {
  const sb = getSupabaseAdmin();
  const [{ data: state }, { data: allTrades }] = await Promise.all([
    sb.from("surfer_state").select("*").eq("id", 1).single(),
    sb.from("surfer_trades").select("*").order("exit_time", { ascending: true }),
  ]);
  if (!state) return NextResponse.json({ ok: false, error: "No surfer_state row" });
  const SEED_BTC = 0.00075241;

  // Only replay from the v2 "buffered rotation" strategy's actual deploy date -- trades before
  // that were made under a completely different (RSI+EMA) strategy, comparing them against this
  // replay would be meaningless (same class of issue found earlier with the SOL/BTC
  // size-confirmation bot's mid-history strategy swap). Both real and backtest returns below are
  // computed v2-only, relative to whatever trading capital existed right at the v2 deploy moment,
  // so they're a genuine apples-to-apples pair.
  const v2DeployMs = new Date("2026-09-14T00:00:00Z").getTime();
  const trades = allTrades ?? [];
  const preV2Trades = trades.filter((t: any) => new Date(t.exit_time).getTime() < v2DeployMs);
  const v2Trades = trades.filter((t: any) => new Date(t.exit_time).getTime() >= v2DeployMs);
  const capitalAtV2Start = SEED_BTC + preV2Trades.reduce((s: number, t: any) => s + t.pnl_btc, 0);
  let realV2PnlBtc = v2Trades.reduce((s: number, t: any) => s + t.pnl_btc, 0);

  const H_WINDOW_MIN = 6190;
  const start = v2DeployMs - (H_WINDOW_MIN + 500) * 60_000;
  const end = Date.now();
  const rawCandles = await fetchBinanceUsCandles("SOLBTC", "1m", start, end);
  const candles: SolbtcCandle[] = rawCandles.map((c) => ({ time: c.time, close: c.close }));
  if (candles.length === 0) return NextResponse.json({ ok: false, error: "No candle data returned" });

  // mark any still-open real position to the last known real price
  if (state.mode === "SOL" && state.entry_price && state.entry_btc && candles.length) {
    const lastPrice = candles[candles.length - 1].close;
    realV2PnlBtc += state.sol_quantity * lastPrice - state.entry_btc;
  }
  const realTotalReturnPct = (realV2PnlBtc / capitalAtV2Start) * 100;

  const { fills, totalReturnPct: backtestTotalReturnPct } = runSurferSolbtcReplay(candles);

  return NextResponse.json({
    ok: true,
    windowStart: new Date(v2DeployMs).toISOString(),
    windowEnd: new Date(end).toISOString(),
    note: "Both numbers are v2 'buffered rotation' only (deployed 2026-09-14) -- pre-v2 trades under the old RSI+EMA strategy are excluded from both sides so this is a genuine apples-to-apples comparison, not the bot's full lifetime return.",
    realTotalReturnPct,
    backtestTotalReturnPct,
    backtest: { trades: fills.length, fills },
  });
}

// Surfer SOLUSDT -- RSI(14)-arm + EMA(7,25)-liveMode, unchanged since deployment.
async function runSurferSolusdtComparison() {
  const sb = getSupabaseAdmin();
  const [{ data: state }, { data: firstRun }] = await Promise.all([
    sb.from("surfer_usdt_state").select("*").eq("id", 1).single(),
    sb.from("surfer_usdt_runs").select("run_at").order("run_at", { ascending: true }).limit(1).maybeSingle(),
  ]);
  if (!state) return NextResponse.json({ ok: false, error: "No surfer_usdt_state row" });
  const realTotalReturnPct = ((state.realized_pnl_usdt ?? 0) / 50) * 100;

  const botStartMs = firstRun?.run_at ? new Date(firstRun.run_at).getTime() : Date.now() - 90 * 86400_000;
  const warmupMs = 55 * 86400_000; // ~55 days, covers 12h EMA(25) warmup (needs ~50 days of 12h candles)
  const start = botStartMs - warmupMs;
  const end = Date.now();

  const [c15raw, c12hraw] = await Promise.all([
    fetchBinanceUsCandles("SOLUSDT", "15m", start, end),
    fetchBinanceUsCandles("SOLUSDT", "12h", start, end),
  ]);
  const c15: Candle15m[] = c15raw.map((c) => ({ time: c.time, close: c.close }));
  const c12h: Candle15m[] = c12hraw.map((c) => ({ time: c.time, close: c.close }));
  if (c15.length === 0 || c12h.length === 0) return NextResponse.json({ ok: false, error: "No candle data returned" });

  const { fills, totalReturnPct: backtestTotalReturnPct } = runSurferSolusdtReplay(c15, c12h);

  return NextResponse.json({
    ok: true,
    windowStart: new Date(botStartMs).toISOString(),
    windowEnd: new Date(end).toISOString(),
    realTotalReturnPct,
    backtestTotalReturnPct,
    backtest: { trades: fills.length, fills },
  });
}

// Hypertrade DCA -- continuous grid, live since 2026-09-11 (real money moved here on 2026-09-12).
async function runHypertradeComparison() {
  const sb = getSupabaseAdmin();
  const [{ data: state }, { data: firstTrade }] = await Promise.all([
    sb.from("sol_hypertrade_paper_state").select("*").eq("id", 1).single(),
    sb.from("sol_hypertrade_paper_trades").select("entry_time").order("entry_time", { ascending: true }).limit(1).maybeSingle(),
  ]);
  if (!state) return NextResponse.json({ ok: false, error: "No sol_hypertrade_paper_state row" });
  const realTotalReturnPct = ((state.realized_pnl_usd ?? 0) / HT_SEED_USD) * 100;

  // Seed from the bot's REAL first trade, not its process-boot run-log timestamp -- those can be
  // many hours apart (wallet/book-WS readiness, or a deliberate delay before real money moved
  // onto this worker), and starting the replay's own first entry at an arbitrary boot-time candle
  // instead of the real one cascades into a drifting, increasingly-wrong cycle timeline. See the
  // comment in lib/hypertrade-replay.ts for how this was found.
  if (!firstTrade?.entry_time) return NextResponse.json({ ok: false, error: "No real trades yet for this bot" });
  const firstEntryMs = new Date(firstTrade.entry_time).getTime();
  const end = Date.now();
  const candles = await fetchBitfinex1mCandles("tSOLUSD", firstEntryMs - 5 * 60_000, end);
  if (candles.length === 0) return NextResponse.json({ ok: false, error: "No candle data returned" });

  const entryCandle = candles.find((c) => c.time >= firstEntryMs) ?? candles[0];
  const { fills, totalReturnPct: backtestTotalReturnPct } = runHypertradeReplay(
    candles, HT_SEED_USD, { time: entryCandle.time, price: entryCandle.open }
  );

  return NextResponse.json({
    ok: true,
    windowStart: new Date(firstEntryMs).toISOString(),
    windowEnd: new Date(end).toISOString(),
    note: "No real multi-level DCA cycle has happened yet to verify the DCA-add path against -- only the single-level entry/exit path has been checked against real fills. The size/drop/TP formulas themselves are imported directly from the live bot's own config file, not re-derived.",
    realTotalReturnPct,
    backtestTotalReturnPct,
    backtest: { trades: fills.length, fills },
  });
}

export async function GET(req: NextRequest) {
  const bot = req.nextUrl.searchParams.get("bot"); // "jump-trail" | "solbtc-sizeconf" | "surfer-solbtc" | "surfer-solusdt" | "hypertrade"
  if (bot === "solbtc-sizeconf") return runSizeconfComparison();
  if (bot === "surfer-solbtc") return runSurferSolbtcComparison();
  if (bot === "surfer-solusdt") return runSurferSolusdtComparison();
  if (bot === "hypertrade") return runHypertradeComparison();
  if (bot !== "jump-trail") {
    return NextResponse.json({ ok: false, error: "bot must be jump-trail, solbtc-sizeconf, surfer-solbtc, surfer-solusdt, or hypertrade" }, { status: 400 });
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

  const bt = runBacktest(binance, bfxByTime, bfxTimesSorted, cfg.halfSpreadPct, cfg.trailPct);

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
