/**
 * Sustained BTC pump / ATOM lag — 15m candles — 1 year
 *
 * Baseline:   BTC[i] > 0.2%  AND  ATOM[i] < 0.1%
 * Theory 1:   + BTC[i-1] > 0%          (BTC positive 2 candles in a row)
 * Theory 2:   + BTC cumulative [i-1,i] > 0.3%  AND  ATOM cumulative [i-1,i] < 0.1%
 *               (lag growing over 2 candles)
 *
 * Run: npx ts-node --transpile-only backtest/sustained-lag-15m.ts
 */

const BASE       = "https://api.binance.us/api/v3";
const API_KEY    = process.env.BINANCE_API_KEY ?? "";
const ALLOCATION = 200;
const LOOKBACK   = 365 * 24 * 60 * 60 * 1000;
const TAKER_FEE  = 0.0002;

const BTC_THRESH  = 0.002;   // 0.2%
const ATOM_THRESH = 0.001;   // 0.1%
const TP_PCT      = 0.010;
const SL_PCT      = 0.003;
const MAX_HOLD    = 6;
const CHASE_OFFSET = 0.0005;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
type Candle = { time: number; close: number };
function ret(a: number, b: number) { return (b - a) / a; }

async function fetchKlines(symbol: string): Promise<Candle[]> {
  const candles: Candle[] = [];
  const endMs = Date.now();
  const startMs = endMs - LOOKBACK;
  let from = startMs;
  while (from < endMs) {
    const url = `${BASE}/klines?symbol=${symbol}&interval=15m&startTime=${from}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url, { headers: { "X-MBX-APIKEY": API_KEY } });
    if (res.status === 429) { await sleep(10_000); continue; }
    if (!res.ok) throw new Error(`${res.status} ${symbol}`);
    const raw = await res.json() as string[][];
    if (!raw.length) break;
    for (const c of raw) candles.push({ time: Number(c[0]), close: parseFloat(c[4]) });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(100);
  }
  return candles;
}

type Result = { pnl: number; wins: number; losses: number };

function simulate(
  btc: Candle[], atom: Candle[],
  signal: (i: number) => boolean,
): Result {
  const atomMap = new Map(atom.map(c => [c.time, c]));
  let pnl = 0, wins = 0, losses = 0;
  let pos: { entry: number; tp: number; sl: number; hold: number; chasing: boolean } | null = null;

  for (let i = 2; i < btc.length; i++) {
    const atomC = atomMap.get(btc[i].time);
    if (!atomC) continue;
    const atomPrice = atomC.close;

    if (pos) {
      if (pos.chasing) {
        const exit   = atomPrice * (1 - CHASE_OFFSET);
        const tradePnl = (exit - pos.entry) / pos.entry * ALLOCATION;
        pnl += tradePnl;
        wins   += tradePnl > 0 ? 1 : 0;
        losses += tradePnl <= 0 ? 1 : 0;
        pos = null;
      } else {
        pos.hold++;
        if      (atomPrice >= pos.tp)  { pnl += (pos.tp - pos.entry) / pos.entry * ALLOCATION; wins++;   pos = null; }
        else if (atomPrice <= pos.sl)  { pnl += (pos.sl - pos.entry) / pos.entry * ALLOCATION; losses++; pos = null; }
        else if (pos.hold >= MAX_HOLD) { pos.chasing = true; }
      }
    }

    if (!pos && signal(i)) {
      const entry = atomPrice * (1 + TAKER_FEE);
      pos = { entry, tp: entry * (1 + TP_PCT), sl: entry * (1 - SL_PCT), hold: 0, chasing: false };
    }
  }

  return { pnl, wins, losses };
}

function print(label: string, r: Result) {
  const total = r.wins + r.losses;
  const wr    = total > 0 ? (r.wins / total * 100).toFixed(1) : "0.0";
  const sign  = r.pnl >= 0 ? "+" : "";
  console.log(
    `  ${label.padEnd(38)} ` +
    `${String(total).padEnd(7)} ` +
    `${(wr + "%").padEnd(8)} ` +
    `${(sign + "$" + r.pnl.toFixed(2)).padEnd(12)} ` +
    `$${(ALLOCATION + r.pnl).toFixed(2)}`
  );
}

async function main() {
  console.log("\nFetching 15m candles (1 year)...");
  const btc  = await fetchKlines("BTCUSDT");
  const atom = await fetchKlines("ATOMUSDT");
  const atomMap = new Map(atom.map(c => [c.time, c]));
  console.log(`  BTC: ${btc.length}  ATOM: ${atom.length}\n`);

  // ── Signals ────────────────────────────────────────────────────────────────

  // Baseline
  const baseline = (i: number) => {
    const aC = atomMap.get(btc[i].time);
    const aPrev = atomMap.get(btc[i - 1].time);
    if (!aC || !aPrev) return false;
    return ret(btc[i-1].close, btc[i].close) > BTC_THRESH
        && ret(aPrev.close, aC.close) < ATOM_THRESH;
  };

  // Theory 1: BTC also positive on the PREVIOUS candle
  const theory1 = (i: number) => {
    const aC = atomMap.get(btc[i].time);
    const aPrev = atomMap.get(btc[i - 1].time);
    if (!aC || !aPrev) return false;
    const btcCur  = ret(btc[i-1].close, btc[i].close);
    const btcPrev = ret(btc[i-2].close, btc[i-1].close);
    const atomCur = ret(aPrev.close, aC.close);
    return btcCur > BTC_THRESH && btcPrev > 0 && atomCur < ATOM_THRESH;
  };

  // Theory 1b: BTC also above threshold on the previous candle (stricter)
  const theory1b = (i: number) => {
    const aC = atomMap.get(btc[i].time);
    const aPrev = atomMap.get(btc[i - 1].time);
    if (!aC || !aPrev) return false;
    const btcCur  = ret(btc[i-1].close, btc[i].close);
    const btcPrev = ret(btc[i-2].close, btc[i-1].close);
    const atomCur = ret(aPrev.close, aC.close);
    return btcCur > BTC_THRESH && btcPrev > BTC_THRESH && atomCur < ATOM_THRESH;
  };

  // Theory 2: Cumulative 2-candle BTC > 0.3% AND cumulative ATOM < 0.1%
  const theory2 = (i: number) => {
    const aC     = atomMap.get(btc[i].time);
    const aPrev  = atomMap.get(btc[i-1].time);
    const aPrev2 = atomMap.get(btc[i-2].time);
    if (!aC || !aPrev || !aPrev2) return false;
    const btcCum  = ret(btc[i-2].close, btc[i].close);   // 2-candle return
    const atomCum = ret(aPrev2.close, aC.close);
    const btcCur  = ret(btc[i-1].close, btc[i].close);   // current candle still must pump
    return btcCur > BTC_THRESH && btcCum > 0.003 && atomCum < ATOM_THRESH;
  };

  // Theory 2b: Growing gap — BTC cumulative MINUS ATOM cumulative > threshold
  const theory2b = (i: number) => {
    const aC     = atomMap.get(btc[i].time);
    const aPrev  = atomMap.get(btc[i-1].time);
    const aPrev2 = atomMap.get(btc[i-2].time);
    if (!aC || !aPrev || !aPrev2) return false;
    const btcCum  = ret(btc[i-2].close, btc[i].close);
    const atomCum = ret(aPrev2.close, aC.close);
    const btcCur  = ret(btc[i-1].close, btc[i].close);
    return btcCur > BTC_THRESH && (btcCum - atomCum) > 0.004;  // gap > 0.4%
  };

  console.log(`${"═".repeat(78)}`);
  console.log(`  Sustained BTC pump / ATOM lag — 15m — $${ALLOCATION} — 1 year`);
  console.log(`${"═".repeat(78)}`);
  console.log(`  ${"Signal".padEnd(38)} ${"Trades".padEnd(7)} ${"WR%".padEnd(8)} ${"PnL".padEnd(12)} Balance`);
  console.log(`  ${"─".repeat(72)}`);

  print("Baseline (BTC>0.2% + ATOM<0.1%)",          simulate(btc, atom, baseline));
  print("T1: + prev BTC candle > 0%",                simulate(btc, atom, theory1));
  print("T1b: + prev BTC candle > 0.2%",             simulate(btc, atom, theory1b));
  print("T2: + 2-candle BTC cum > 0.3%",             simulate(btc, atom, theory2));
  print("T2b: + 2-candle gap (BTC-ATOM) > 0.4%",    simulate(btc, atom, theory2b));

  console.log(`${"═".repeat(78)}\n`);
}

main().catch(console.error);
