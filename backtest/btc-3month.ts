import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US     = "https://api.binance.us/api/v3";
const BASE_GL     = "https://api.binance.com/api/v3";
const KEY         = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

// Current live settings
const GL_THRESH = 0.0005;  // 0.05% spread threshold
const TP_PCT    = 0.004;   // 0.4% take profit  (just changed from 0.8%)
const SL_PCT    = 0.0015;  // 0.15% stop loss
const MAX_HOLD  = 6;       // 6 candles then chase
const ALLOC     = 25;      // $25 compounding

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(base: string, symbol: string) {
  const candles: { time: number; high: number; low: number; close: number }[] = [];
  let from = Date.now() - LOOKBACK_MS, end = Date.now();
  while (from < end) {
    const res = await fetch(`${base}/klines?symbol=${symbol}&interval=1m&startTime=${from}&endTime=${end}&limit=1000`, { headers: { "X-MBX-APIKEY": KEY } });
    if (res.status === 429) { await sleep(10000); continue; }
    const raw = await res.json() as any;
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) candles.push({ time: Number(c[0]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]) });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(150);
  }
  return candles;
}

function runSim(aligned: { high: number; low: number; close: number }[], usClose: number[], glClose: number[]) {
  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chasePrice: number };
  let bal = ALLOC, peak = ALLOC, maxDD = 0;
  let trades = 0, wins = 0, losses = 0, chaseExits = 0, tpHits = 0, gW = 0, gL = 0, signals = 0;
  let pos: Pos | null = null;

  for (let i = 1; i < aligned.length; i++) {
    const { high, low, close } = aligned[i];

    if (pos) {
      const qty = bal / pos.entry;
      if (pos.chasing) {
        if (low <= pos.chasePrice) {
          const pnl = (pos.chasePrice - pos.entry) * qty;
          bal += pnl; trades++; chaseExits++;
          if (pnl >= 0) { wins++; gW += pnl; } else { losses++; gL += Math.abs(pnl); }
          if (bal > peak) peak = bal;
          if ((peak - bal) / peak * 100 > maxDD) maxDD = (peak - bal) / peak * 100;
          pos = null;
        } else pos.chasePrice = close;
      } else {
        pos.hold++;
        if (low <= pos.sl) {
          const pnl = (pos.sl - pos.entry) * qty;
          bal += pnl; trades++; losses++; gL += Math.abs(pnl);
          if (bal > peak) peak = bal;
          if ((peak - bal) / peak * 100 > maxDD) maxDD = (peak - bal) / peak * 100;
          pos = null;
        } else if (high >= pos.tp) {
          const pnl = (pos.tp - pos.entry) * qty;
          bal += pnl; trades++; wins++; tpHits++; gW += pnl;
          if (bal > peak) peak = bal;
          if ((peak - bal) / peak * 100 > maxDD) maxDD = (peak - bal) / peak * 100;
          pos = null;
        } else if (pos.hold >= MAX_HOLD) {
          pos.chasing = true; pos.chasePrice = close;
        }
      }
      continue;
    }

    const spread = (glClose[i] - usClose[i]) / usClose[i];
    const glRet  = (glClose[i] - glClose[i-1]) / glClose[i-1];
    const usRet  = (usClose[i] - usClose[i-1]) / usClose[i-1];
    if (spread >= GL_THRESH && glRet > 0 && usRet < glRet) {
      signals++;
      // Market order — 0.02% taker fee on entry only (exits are limit/maker)
      const entry = close * 1.0002;
      pos = { entry, tp: entry * (1 + TP_PCT), sl: entry * (1 - SL_PCT), hold: 0, chasing: false, chasePrice: 0 };
    }
  }

  const days = aligned.length / 60 / 24;
  const pnl  = bal - ALLOC;
  const wr   = trades > 0 ? wins / trades * 100 : 0;
  const pf   = gL > 0 ? gW / gL : Infinity;
  return { bal, pnl, pct: pnl / ALLOC * 100, wr, pf, trades, wins, losses, tpHits, chaseExits, signals, maxDD, perDay: trades / days, days, gW, gL };
}

(async () => {
  process.stdout.write("Fetching BTC US (90d, ~130k candles)... ");
  const btcUS = await fetchKlines(BASE_US, "BTCUSDT");
  console.log(btcUS.length, "candles");

  process.stdout.write("Fetching BTC GL (90d, ~130k candles)... ");
  const btcGL = await fetchKlines(BASE_GL, "BTCUSDT");
  console.log(btcGL.length, "candles");

  const glMap   = new Map(btcGL.map(c => [c.time, c.close]));
  const aligned = btcUS.filter(c => glMap.has(c.time));
  const usClose = aligned.map(c => c.close);
  const glClose = aligned.map(c => glMap.get(c.time)!);

  const r  = runSim(aligned, usClose, glClose);
  const pf = r.pf === Infinity ? "∞" : r.pf.toFixed(2);

  console.log();
  console.log("═══════════════════════════════════════════════════════");
  console.log(" BTC Pure Lag · Current Settings · 90-day Backtest");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Signal      spread ≥ ${GL_THRESH*100}% + global rising + US lagging`);
  console.log(`  Entry       market order (0.02% taker fee, exits are limit/maker)`);
  console.log(`  TP          +${TP_PCT*100}%   SL  -${SL_PCT*100}%`);
  console.log(`  Max Hold    ${MAX_HOLD} candles, then chase at close`);
  console.log(`  Allocation  $${ALLOC} compounding`);
  console.log("───────────────────────────────────────────────────────");
  console.log(`  Period      ${r.days.toFixed(1)} days`);
  console.log(`  Signals     ${r.signals}`);
  console.log(`  Trades      ${r.trades}  (${r.perDay.toFixed(1)}/day)`);
  console.log("───────────────────────────────────────────────────────");
  console.log(`  Win Rate    ${r.wr.toFixed(1)}%  (${r.wins}W / ${r.losses}L)`);
  console.log(`   ↳ TP hits  ${r.tpHits}`);
  console.log(`   ↳ Chase    ${r.chaseExits}`);
  console.log(`  Prof Factor ${pf}`);
  console.log(`  Gross W     $${r.gW.toFixed(2)}`);
  console.log(`  Gross L     $${r.gL.toFixed(2)}`);
  console.log("───────────────────────────────────────────────────────");
  console.log(`  Start bal   $${ALLOC.toFixed(2)}`);
  console.log(`  End bal     $${r.bal.toFixed(2)}`);
  console.log(`  PnL         ${r.pnl >= 0 ? "+" : ""}$${r.pnl.toFixed(2)}  (${r.pnl >= 0 ? "+" : ""}${r.pct.toFixed(0)}%)`);
  console.log(`  Max DD      ${r.maxDD.toFixed(2)}%`);
  console.log("═══════════════════════════════════════════════════════");
})();
