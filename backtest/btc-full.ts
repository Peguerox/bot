// BTC Pure Lag — full backtest with exact live bot settings
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US     = "https://api.binance.us/api/v3";
const BASE_GL     = "https://api.binance.com/api/v3";
const KEY         = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

// ── Exact live bot settings ───────────────────────────────────────────────────
const GL_THRESH   = 0.0005;   // 0.05% spread + direction filter
const TP_PCT      = 0.008;    // 0.8% take profit
const SL_PCT      = 0.0015;   // 0.15% stop loss
const MAX_HOLD    = 6;        // 6 candles before chase
const ALLOCATION  = 25;       // $25 compounding
const ENTRY_SLIP  = 0.0002;   // limit buy 0.02% above close
const CANCEL_DROP = 0.0015;   // cancel pending if price drops 0.15% below order

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(base: string, symbol: string) {
  const candles: { time: number; open: number; high: number; low: number; close: number }[] = [];
  let from = Date.now() - LOOKBACK_MS, end = Date.now();
  while (from < end) {
    const res = await fetch(`${base}/klines?symbol=${symbol}&interval=1m&startTime=${from}&endTime=${end}&limit=1000`, { headers: { "X-MBX-APIKEY": KEY } });
    if (res.status === 429) { await sleep(10000); continue; }
    const raw = await res.json() as any;
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) candles.push({
      time: Number(c[0]), open: parseFloat(c[1]),
      high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]),
    });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(150);
  }
  return candles;
}

function runSim(aligned: { open: number; high: number; low: number; close: number }[], usClose: number[], glClose: number[]) {
  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chasePrice: number };
  let bal = ALLOCATION, peak = ALLOCATION, maxDD = 0;
  let trades = 0, wins = 0, losses = 0, chaseExits = 0;
  let cancelDrops = 0, missed = 0, gW = 0, gL = 0;
  let pos: Pos | null = null, pending: number | null = null;
  const equity: number[] = [ALLOCATION];

  for (let i = 1; i < aligned.length; i++) {
    const { high, low, close } = aligned[i];

    // ── Pending entry: check fill, cancel-on-drop, or timeout ─────────────────
    if (pending !== null) {
      const orderPrice = pending;
      const cancelLevel = orderPrice * (1 - CANCEL_DROP);
      if (low <= cancelLevel) {
        // Price dropped 0.15% below order before filling → cancel
        cancelDrops++;
        pending = null; continue;
      }
      if (low <= orderPrice) {
        pos = { entry: orderPrice, tp: orderPrice * (1 + TP_PCT), sl: orderPrice * (1 - SL_PCT), hold: 0, chasing: false, chasePrice: 0 };
      } else {
        missed++;
      }
      pending = null; continue;
    }

    // ── Position management ───────────────────────────────────────────────────
    if (pos) {
      const qty = bal / pos.entry;
      if (pos.chasing) {
        // Chase: limit sell at current close, fill if price touches it next candle
        if (low <= pos.chasePrice) {
          const pnl = (pos.chasePrice - pos.entry) * qty;
          bal += pnl; trades++; chaseExits++;
          if (pnl >= 0) { wins++; gW += pnl; } else { losses++; gL += Math.abs(pnl); }
          if (bal > peak) peak = bal;
          if ((peak - bal) / peak * 100 > maxDD) maxDD = (peak - bal) / peak * 100;
          equity.push(bal);
          pos = null;
        } else pos.chasePrice = close;
      } else {
        pos.hold++;
        if (low <= pos.sl) {
          const pnl = (pos.sl - pos.entry) * qty;
          bal += pnl; trades++; losses++; gL += Math.abs(pnl);
          if (bal > peak) peak = bal;
          if ((peak - bal) / peak * 100 > maxDD) maxDD = (peak - bal) / peak * 100;
          equity.push(bal);
          pos = null;
        } else if (high >= pos.tp) {
          const pnl = (pos.tp - pos.entry) * qty;
          bal += pnl; trades++; wins++; gW += pnl;
          if (bal > peak) peak = bal;
          if ((peak - bal) / peak * 100 > maxDD) maxDD = (peak - bal) / peak * 100;
          equity.push(bal);
          pos = null;
        } else if (pos.hold >= MAX_HOLD) {
          pos.chasing = true; pos.chasePrice = close;
        }
      }
      continue;
    }

    // ── Signal check ──────────────────────────────────────────────────────────
    const spread = (glClose[i] - usClose[i]) / usClose[i];
    const glRet  = (glClose[i] - glClose[i-1]) / glClose[i-1];
    const usRet  = (usClose[i] - usClose[i-1]) / usClose[i-1];
    if (spread >= GL_THRESH && glRet > 0 && usRet < glRet) {
      pending = close * (1 + ENTRY_SLIP);
    }
  }

  const pnl      = bal - ALLOCATION;
  const wr       = trades > 0 ? wins / trades * 100 : 0;
  const pf       = gL > 0 ? gW / gL : Infinity;
  const signals  = trades + missed + cancelDrops;
  const fillRate = signals > 0 ? trades / signals * 100 : 0;
  const days     = aligned.length / 60 / 24;
  const tpHits   = wins - chaseExits < 0 ? wins : wins - chaseExits;
  return { bal, pnl, pct: pnl / ALLOCATION * 100, wr, pf, trades, wins, losses, tpHits, chaseExits, cancelDrops, missed, fillRate, maxDD, perDay: trades / days, days, equity };
}

(async () => {
  process.stdout.write("Fetching BTC US... "); const btcUS = await fetchKlines(BASE_US, "BTCUSDT"); console.log(btcUS.length, "candles");
  process.stdout.write("Fetching BTC GL... "); const btcGL = await fetchKlines(BASE_GL, "BTCUSDT"); console.log(btcGL.length, "candles");

  const glMap   = new Map(btcGL.map(c => [c.time, c.close]));
  const aligned = btcUS.filter(c => glMap.has(c.time));
  const usClose = aligned.map(c => c.close);
  const glClose = aligned.map(c => glMap.get(c.time)!);
  const days    = (aligned.length / 60 / 24).toFixed(1);

  console.log(`\nAligned: ${aligned.length} candles · ${days} days\n`);

  const r = runSim(aligned, usClose, glClose);
  const pf = r.pf === Infinity ? "∞" : r.pf.toFixed(2);

  console.log("═══════════════════════════════════════════════════════");
  console.log(" BTC Pure Lag · Live Bot Settings · 30-day Backtest");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Signal      spread ≥ ${GL_THRESH*100}% + global rising + US lagging`);
  console.log(`  Entry       limit buy at close + ${ENTRY_SLIP*100}%`);
  console.log(`  Cancel      drop ${CANCEL_DROP*100}% below order while pending`);
  console.log(`  TP          +${TP_PCT*100}%   SL  -${SL_PCT*100}%`);
  console.log(`  Max Hold    ${MAX_HOLD} candles, then chase at close`);
  console.log(`  Allocation  $${ALLOCATION} compounding`);
  console.log("───────────────────────────────────────────────────────");
  console.log(`  Period      ${r.days.toFixed(1)} days`);
  console.log(`  Signals     ${r.trades + r.missed + r.cancelDrops}`);
  console.log(`  Filled      ${r.trades}  (${r.fillRate.toFixed(0)}% fill rate)`);
  console.log(`  Canceled↓   ${r.cancelDrops}  (drop before fill)`);
  console.log(`  Missed      ${r.missed}  (price never came back)`);
  console.log("───────────────────────────────────────────────────────");
  console.log(`  Trades/day  ${r.perDay.toFixed(1)}`);
  console.log(`  Win Rate    ${r.wr.toFixed(1)}%  (${r.wins}W / ${r.losses}L)`);
  console.log(`   ↳ TP hits  ${r.tpHits}`);
  console.log(`   ↳ Chase exit ${r.chaseExits}`);
  console.log(`  Prof Factor ${pf}`);
  console.log("───────────────────────────────────────────────────────");
  console.log(`  Start bal   $${ALLOCATION.toFixed(2)}`);
  console.log(`  End bal     $${r.bal.toFixed(2)}`);
  console.log(`  PnL         +$${r.pnl.toFixed(2)}  (+${r.pct.toFixed(0)}%)`);
  console.log(`  Max DD      ${r.maxDD.toFixed(2)}%`);
  console.log("═══════════════════════════════════════════════════════");
})();
