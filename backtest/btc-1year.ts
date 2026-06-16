import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US     = "https://api.binance.us/api/v3";
const BASE_GL     = "https://api.binance.com/api/v3";
const KEY         = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000;

const GL_THRESH = 0.0005;
const TP_PCT    = 0.004;
const SL_PCT    = 0.0015;
const MAX_HOLD  = 6;
const ALLOC     = 25;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(base: string, symbol: string) {
  const candles: { time: number; high: number; low: number; close: number }[] = [];
  let from = Date.now() - LOOKBACK_MS, end = Date.now();
  let fetched = 0;
  while (from < end) {
    const res = await fetch(`${base}/klines?symbol=${symbol}&interval=1m&startTime=${from}&endTime=${end}&limit=1000`, { headers: { "X-MBX-APIKEY": KEY } });
    if (res.status === 429) { await sleep(10000); continue; }
    const raw = await res.json() as any;
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) candles.push({ time: Number(c[0]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]) });
    from = Number(raw[raw.length - 1][0]) + 1;
    fetched += raw.length;
    if (fetched % 50000 < 1000) process.stdout.write(` ${Math.round(fetched/1000)}k`);
    await sleep(150);
  }
  return candles;
}

function runSim(aligned: { time: number; high: number; low: number; close: number }[], usClose: number[], glClose: number[]) {
  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chasePrice: number };

  let bal = ALLOC, peak = ALLOC, maxDD = 0;
  let trades = 0, wins = 0, losses = 0, tpHits = 0, chaseExits = 0, gW = 0, gL = 0;
  let pos: Pos | null = null;

  // Monthly tracking
  const months: Record<string, { trades: number; wins: number; gW: number; gL: number; startBal: number; endBal: number }> = {};
  let curMonth = "";

  for (let i = 1; i < aligned.length; i++) {
    const { time, high, low, close } = aligned[i];
    const monthKey = new Date(time).toISOString().slice(0, 7); // "2024-06"

    if (monthKey !== curMonth) {
      if (curMonth && months[curMonth]) months[curMonth].endBal = bal;
      curMonth = monthKey;
      if (!months[monthKey]) months[monthKey] = { trades: 0, wins: 0, gW: 0, gL: 0, startBal: bal, endBal: bal };
    }

    if (pos) {
      const qty = ALLOC / pos.entry; // fixed $25 per trade, no compounding
      if (pos.chasing) {
        if (low <= pos.chasePrice) {
          const pnl = (pos.chasePrice - pos.entry) * qty;
          bal += pnl; trades++; chaseExits++;
          months[curMonth].trades++;
          if (pnl >= 0) { wins++; gW += pnl; months[curMonth].wins++; months[curMonth].gW += pnl; }
          else { losses++; gL += Math.abs(pnl); months[curMonth].gL += Math.abs(pnl); }
          if (bal > peak) peak = bal;
          if ((peak - bal) / peak * 100 > maxDD) maxDD = (peak - bal) / peak * 100;
          pos = null;
        } else pos.chasePrice = close;
      } else {
        pos.hold++;
        if (low <= pos.sl) {
          const pnl = (pos.sl - pos.entry) * qty;
          bal += pnl; trades++; losses++; gL += Math.abs(pnl);
          months[curMonth].trades++; months[curMonth].gL += Math.abs(pnl);
          if (bal > peak) peak = bal;
          if ((peak - bal) / peak * 100 > maxDD) maxDD = (peak - bal) / peak * 100;
          pos = null;
        } else if (high >= pos.tp) {
          const pnl = (pos.tp - pos.entry) * qty;
          bal += pnl; trades++; wins++; tpHits++; gW += pnl;
          months[curMonth].trades++; months[curMonth].wins++; months[curMonth].gW += pnl;
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
      const entry = close * 1.0002; // 0.02% taker fee on entry
      pos = { entry, tp: entry * (1 + TP_PCT), sl: entry * (1 - SL_PCT), hold: 0, chasing: false, chasePrice: 0 };
    }
  }
  if (curMonth && months[curMonth]) months[curMonth].endBal = bal;

  const days = aligned.length / 60 / 24;
  const pnl  = bal - ALLOC;
  const wr   = trades > 0 ? wins / trades * 100 : 0;
  const pf   = gL > 0 ? gW / gL : Infinity;
  return { bal, pnl, pct: pnl / ALLOC * 100, wr, pf, trades, wins, losses, tpHits, chaseExits, maxDD, perDay: trades / days, days, gW, gL, months };
}

(async () => {
  process.stdout.write("Fetching BTC US (1yr)...");
  const btcUS = await fetchKlines(BASE_US, "BTCUSDT");
  console.log(` ${btcUS.length} candles`);

  process.stdout.write("Fetching BTC GL (1yr)...");
  const btcGL = await fetchKlines(BASE_GL, "BTCUSDT");
  console.log(` ${btcGL.length} candles`);

  const glMap   = new Map(btcGL.map(c => [c.time, c.close]));
  const aligned = btcUS.filter(c => glMap.has(c.time)).map(c => ({ ...c, close: c.close }));
  const usClose = aligned.map(c => c.close);
  const glClose = aligned.map(c => glMap.get(c.time)!);

  const r  = runSim(aligned, usClose, glClose);
  const pf = r.pf === Infinity ? "∞" : r.pf.toFixed(2);

  console.log();
  console.log("═══════════════════════════════════════════════════════");
  console.log(" BTC Pure Lag · Current Settings · 1-Year Backtest");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  TP +${TP_PCT*100}%  SL -${SL_PCT*100}%  MaxHold ${MAX_HOLD}  Market entry  $${ALLOC}`);
  console.log("───────────────────────────────────────────────────────");
  console.log(`  Period      ${r.days.toFixed(1)} days`);
  console.log(`  Trades      ${r.trades}  (${r.perDay.toFixed(1)}/day)`);
  console.log(`  Win Rate    ${r.wr.toFixed(1)}%   Prof Factor ${pf}`);
  console.log(`  TP hits     ${r.tpHits}   Chase exits ${r.chaseExits}`);
  console.log(`  PnL         ${r.pnl >= 0 ? "+" : ""}$${r.pnl.toFixed(2)}  (${r.pct >= 0 ? "+" : ""}${r.pct.toFixed(0)}%)`);
  console.log(`  Max DD      ${r.maxDD.toFixed(2)}%`);
  console.log("───────────────────────────────────────────────────────");
  console.log("  Monthly breakdown:");
  console.log("  Month       Trades   WR%    PnL$      Ret%");
  console.log("  " + "─".repeat(47));

  for (const [month, m] of Object.entries(r.months)) {
    const mPnl = m.endBal - m.startBal;
    const mPct = m.startBal > 0 ? mPnl / m.startBal * 100 : 0;
    const mWr  = m.trades > 0 ? m.wins / m.trades * 100 : 0;
    const sign = mPnl >= 0 ? "+" : "";
    const flag = mPnl < 0 ? " ✗" : "";
    console.log(
      `  ${month}`.padEnd(13) +
      `${m.trades}`.padStart(7) +
      `  ${mWr.toFixed(0)}%`.padStart(6) +
      `  ${sign}$${Math.abs(mPnl).toFixed(2)}`.padStart(10) +
      `  ${sign}${mPct.toFixed(1)}%`.padStart(8) +
      flag
    );
  }

  console.log("───────────────────────────────────────────────────────");
  console.log(`  Start $${ALLOC}  →  End $${r.bal.toFixed(2)}`);
  console.log("═══════════════════════════════════════════════════════");
})();
