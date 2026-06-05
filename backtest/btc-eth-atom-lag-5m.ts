/**
 * BTC + ETH pump / ATOM lag — 5m candles — 1 year
 *
 * Signal: BTC 5m return > BTC_THRESH
 *     AND ETH 5m return > ETH_THRESH  (market-wide confirmation)
 *     AND ATOM 5m return < ATOM_THRESH (ATOM still lagging)
 * → Buy ATOM, exit via TP / SL / expire + chase
 *
 * Run: npx ts-node --transpile-only backtest/btc-eth-atom-lag-5m.ts
 */

const BASE       = "https://api.binance.us/api/v3";
const API_KEY    = process.env.BINANCE_API_KEY ?? "";
const ALLOCATION = 200;
const LOOKBACK   = 365 * 24 * 60 * 60 * 1000;
const TAKER_FEE  = 0.0002; // 0.02% taker on Binance.US

const BTC_THRESH  = 0.002;               // BTC must be up > 0.2%
const ETH_THRESHOLDS = [0.001, 0.0015, 0.002]; // ETH confirmation grid
const ATOM_THRESH = 0.001;              // ATOM still lagging < 0.1%
const TP_PCT      = 0.010;              // 1% TP
const SL_PCT      = 0.003;              // 0.3% SL
const MAX_HOLD    = 6;                  // 6 candles = 90 min on 15m
const CHASE_OFFSET = 0.0005;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

type Candle = { time: number; close: number };

async function fetchKlines(symbol: string, startMs: number, endMs: number): Promise<Candle[]> {
  const candles: Candle[] = [];
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

function ret(a: number, b: number) { return (b - a) / a; }

function runBacktest(
  btc: Candle[], eth: Candle[], atom: Candle[],
  ethThresh: number,
): { pnl: number; total: number; wins: number; losses: number; wr: string } {
  // Align all three by time
  const ethMap  = new Map(eth.map(c  => [c.time, c]));
  const atomMap = new Map(atom.map(c => [c.time, c]));

  let pnl = 0, wins = 0, losses = 0;
  let pos: { entry: number; tp: number; sl: number; hold: number; chasing: boolean } | null = null;

  for (let i = 1; i < btc.length; i++) {
    const btcC  = btc[i];
    const ethC  = ethMap.get(btcC.time);
    const atomC = atomMap.get(btcC.time);
    if (!ethC || !atomC) continue;

    const atomPrice = atomC.close;

    if (pos) {
      if (pos.chasing) {
        const chaseExit = atomPrice * (1 - CHASE_OFFSET);
        const tradePnl  = (chaseExit - pos.entry) / pos.entry * ALLOCATION;
        pnl   += tradePnl;
        wins  += tradePnl > 0 ? 1 : 0;
        losses += tradePnl <= 0 ? 1 : 0;
        pos = null;
      } else {
        pos.hold++;
        if      (atomPrice >= pos.tp) { pnl += (pos.tp - pos.entry) / pos.entry * ALLOCATION; wins++;   pos = null; }
        else if (atomPrice <= pos.sl) { pnl += (pos.sl - pos.entry) / pos.entry * ALLOCATION; losses++; pos = null; }
        else if (pos.hold >= MAX_HOLD) { pos.chasing = true; }
      }
    }

    if (!pos) {
      const btcRet  = ret(btc[i - 1].close,  btcC.close);
      const ethRet  = ret(ethMap.get(btc[i - 1].time)?.close ?? ethC.close, ethC.close);
      const atomRet = ret(atomMap.get(btc[i - 1].time)?.close ?? atomC.close, atomC.close);

      if (btcRet > BTC_THRESH && ethRet > ethThresh && atomRet < ATOM_THRESH) {
        const entry = atomPrice * (1 + TAKER_FEE);
        pos = { entry, tp: entry * (1 + TP_PCT), sl: entry * (1 - SL_PCT), hold: 0, chasing: false };
      }
    }
  }

  const total = wins + losses;
  const wr    = total > 0 ? (wins / total * 100).toFixed(1) : "0.0";
  return { pnl, total, wins, losses, wr };
}

async function main() {
  const now     = Date.now();
  const startMs = now - LOOKBACK;

  console.log("\nFetching 5m candles (1 year)...");
  const btc  = await fetchKlines("BTCUSDT",  startMs, now);
  console.log(`  BTC:  ${btc.length} candles`);
  const eth  = await fetchKlines("ETHUSDT",  startMs, now);
  console.log(`  ETH:  ${eth.length} candles`);
  const atom = await fetchKlines("ATOMUSDT", startMs, now);
  console.log(`  ATOM: ${atom.length} candles`);

  // Baseline — no ETH filter
  const base = runBacktest(btc, eth, atom, 0);

  console.log(`\n${"═".repeat(72)}`);
  console.log(`  BTC+ETH pump / ATOM lag — 15m — $${ALLOCATION} — 1 year — 0.02% fee`);
  console.log(`  BTC>${(BTC_THRESH*100).toFixed(1)}%  ATOM<${(ATOM_THRESH*100).toFixed(1)}%`);
  console.log(`  TP=${TP_PCT*100}%  SL=${SL_PCT*100}%  Hold=${MAX_HOLD} candles (${MAX_HOLD*15}min)`);
  console.log(`${"═".repeat(72)}`);
  console.log(`  ${"ETH filter".padEnd(14)} ${"Trades".padEnd(8)} ${"WR%".padEnd(8)} ${"PnL".padEnd(12)} Balance`);
  console.log(`  ${"─".repeat(56)}`);

  // Baseline row
  const s = (v: string, w: number) => v.padEnd(w);
  const sign = (n: number) => n >= 0 ? "+" : "";
  console.log(`  ${s("none (baseline)", 14)} ${s(String(base.total), 8)} ${s(base.wr + "%", 8)} ${s(sign(base.pnl) + "$" + base.pnl.toFixed(2), 12)} $${(ALLOCATION + base.pnl).toFixed(2)}`);

  for (const ethT of ETH_THRESHOLDS) {
    const r = runBacktest(btc, eth, atom, ethT);
    const label = `ETH>${(ethT*100).toFixed(2)}%`;
    console.log(`  ${s(label, 14)} ${s(String(r.total), 8)} ${s(r.wr + "%", 8)} ${s(sign(r.pnl) + "$" + r.pnl.toFixed(2), 12)} $${(ALLOCATION + r.pnl).toFixed(2)}`);
  }

  console.log(`${"═".repeat(72)}\n`);
}

main().catch(console.error);
