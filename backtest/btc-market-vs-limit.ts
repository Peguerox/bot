import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US     = "https://api.binance.us/api/v3";
const BASE_GL     = "https://api.binance.com/api/v3";
const KEY         = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

const GL_THRESH   = 0.0005;
const TP_PCT      = 0.008;
const SL_PCT      = 0.0015;
const MAX_HOLD    = 6;
const ALLOCATION  = 25;
const CANCEL_DROP = 0.0015;

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

function runLimit(aligned: { high: number; low: number; close: number }[], usClose: number[], glClose: number[]) {
  const ENTRY_SLIP = 0.0002;
  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chasePrice: number };
  let bal = ALLOCATION, peak = ALLOCATION, maxDD = 0, trades = 0, wins = 0, gW = 0, gL = 0;
  let cancelDrops = 0, missed = 0, signals = 0;
  let pos: Pos | null = null, pending: number | null = null;

  for (let i = 1; i < aligned.length; i++) {
    const { high, low, close } = aligned[i];

    if (pending !== null) {
      if (low <= pending * (1 - CANCEL_DROP)) { cancelDrops++; pending = null; continue; }
      if (low <= pending) {
        pos = { entry: pending, tp: pending*(1+TP_PCT), sl: pending*(1-SL_PCT), hold: 0, chasing: false, chasePrice: 0 };
      } else { missed++; }
      pending = null; continue;
    }

    if (pos) {
      const qty = bal / pos.entry;
      if (pos.chasing) {
        if (low <= pos.chasePrice) {
          const pnl = (pos.chasePrice - pos.entry) * qty; bal += pnl; trades++;
          if (pnl >= 0) { wins++; gW += pnl; } else gL += Math.abs(pnl);
          if (bal > peak) peak = bal; if ((peak-bal)/peak*100 > maxDD) maxDD=(peak-bal)/peak*100; pos = null;
        } else pos.chasePrice = close;
      } else {
        pos.hold++;
        if (low <= pos.sl) { const pnl=(pos.sl-pos.entry)*qty; bal+=pnl; trades++; gL+=Math.abs(pnl); if(bal>peak)peak=bal; if((peak-bal)/peak*100>maxDD)maxDD=(peak-bal)/peak*100; pos=null; }
        else if (high >= pos.tp) { const pnl=(pos.tp-pos.entry)*qty; bal+=pnl; trades++; wins++; gW+=pnl; if(bal>peak)peak=bal; if((peak-bal)/peak*100>maxDD)maxDD=(peak-bal)/peak*100; pos=null; }
        else if (pos.hold >= MAX_HOLD) { pos.chasing = true; pos.chasePrice = close; }
      }
      continue;
    }

    const spread=(glClose[i]-usClose[i])/usClose[i], glRet=(glClose[i]-glClose[i-1])/glClose[i-1], usRet=(usClose[i]-usClose[i-1])/usClose[i-1];
    if (spread >= GL_THRESH && glRet > 0 && usRet < glRet) { signals++; pending = close * (1 + ENTRY_SLIP); }
  }

  const days = aligned.length/60/24;
  const pnl = bal - ALLOCATION, wr = trades>0?wins/trades*100:0, pf = gL>0?gW/gL:Infinity;
  return { pnl, pct: pnl/ALLOCATION*100, wr, pf, trades, wins, signals, cancelDrops, missed, maxDD, perDay: trades/days };
}

function runMarket(aligned: { high: number; low: number; close: number }[], usClose: number[], glClose: number[], marketSlip: number) {
  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chasePrice: number };
  let bal = ALLOCATION, peak = ALLOCATION, maxDD = 0, trades = 0, wins = 0, gW = 0, gL = 0, signals = 0;
  let pos: Pos | null = null;

  for (let i = 1; i < aligned.length; i++) {
    const { high, low, close } = aligned[i];

    if (pos) {
      const qty = bal / pos.entry;
      if (pos.chasing) {
        if (low <= pos.chasePrice) {
          const pnl = (pos.chasePrice - pos.entry) * qty; bal += pnl; trades++;
          if (pnl >= 0) { wins++; gW += pnl; } else gL += Math.abs(pnl);
          if (bal > peak) peak = bal; if ((peak-bal)/peak*100 > maxDD) maxDD=(peak-bal)/peak*100; pos = null;
        } else pos.chasePrice = close;
      } else {
        pos.hold++;
        if (low <= pos.sl) { const pnl=(pos.sl-pos.entry)*qty; bal+=pnl; trades++; gL+=Math.abs(pnl); if(bal>peak)peak=bal; if((peak-bal)/peak*100>maxDD)maxDD=(peak-bal)/peak*100; pos=null; }
        else if (high >= pos.tp) { const pnl=(pos.tp-pos.entry)*qty; bal+=pnl; trades++; wins++; gW+=pnl; if(bal>peak)peak=bal; if((peak-bal)/peak*100>maxDD)maxDD=(peak-bal)/peak*100; pos=null; }
        else if (pos.hold >= MAX_HOLD) { pos.chasing = true; pos.chasePrice = close; }
      }
      continue;
    }

    const spread=(glClose[i]-usClose[i])/usClose[i], glRet=(glClose[i]-glClose[i-1])/glClose[i-1], usRet=(usClose[i]-usClose[i-1])/usClose[i-1];
    if (spread >= GL_THRESH && glRet > 0 && usRet < glRet) {
      signals++;
      const entry = close * (1 + marketSlip);
      pos = { entry, tp: entry*(1+TP_PCT), sl: entry*(1-SL_PCT), hold: 0, chasing: false, chasePrice: 0 };
    }
  }

  const days = aligned.length/60/24;
  const pnl = bal - ALLOCATION, wr = trades>0?wins/trades*100:0, pf = gL>0?gW/gL:Infinity;
  return { pnl, pct: pnl/ALLOCATION*100, wr, pf, trades, wins, signals, maxDD, perDay: trades/days };
}

(async () => {
  process.stdout.write("Fetching BTC US... "); const btcUS = await fetchKlines(BASE_US, "BTCUSDT"); console.log(btcUS.length);
  process.stdout.write("Fetching BTC GL... "); const btcGL = await fetchKlines(BASE_GL, "BTCUSDT"); console.log(btcGL.length);

  const glMap = new Map(btcGL.map(c => [c.time, c.close]));
  const aligned = btcUS.filter(c => glMap.has(c.time));
  const usClose = aligned.map(c => c.close), glClose = aligned.map(c => glMap.get(c.time)!);

  console.log(`\nAligned: ${aligned.length} candles · ${(aligned.length/60/24).toFixed(1)} days`);
  console.log(`TP=${TP_PCT*100}%  SL=${SL_PCT*100}%  MAX_HOLD=${MAX_HOLD}  $${ALLOCATION} compounding\n`);

  const lim = runLimit(aligned, usClose, glClose);
  const pf_lim = lim.pf === Infinity ? "∞" : lim.pf.toFixed(2);
  console.log("  Entry method        Signals  Trades  /day   WR%    PF      PnL$      Ret%   MaxDD%");
  console.log("  " + "─".repeat(84));
  console.log(
    "  Limit +0.02% (now)".padEnd(20) +
    `${lim.signals}`.padStart(8) +
    `${lim.trades}`.padStart(8) +
    `  ${lim.perDay.toFixed(1)}`.padStart(6) +
    `  ${lim.wr.toFixed(1)}%`.padStart(6) +
    `  ${pf_lim}`.padStart(5) +
    `  +$${lim.pnl.toFixed(2)}`.padStart(9) +
    `  +${lim.pct.toFixed(0)}%`.padStart(6) +
    `  ${lim.maxDD.toFixed(1)}%`.padStart(7)
  );
  console.log(`  ${"(misses/cancels)".padEnd(19)} ${lim.missed} missed, ${lim.cancelDrops} cancel-drops`);
  console.log();

  for (const slip of [0.0002, 0.0003, 0.0005, 0.001]) {
    const r = runMarket(aligned, usClose, glClose, slip);
    const pf = r.pf === Infinity ? "∞" : r.pf.toFixed(2);
    const label = `Market +${(slip*100).toFixed(2)}%`;
    console.log(
      `  ${label}`.padEnd(20) +
      `${r.signals}`.padStart(8) +
      `${r.trades}`.padStart(8) +
      `  ${r.perDay.toFixed(1)}`.padStart(6) +
      `  ${r.wr.toFixed(1)}%`.padStart(6) +
      `  ${pf}`.padStart(5) +
      `  +$${r.pnl.toFixed(2)}`.padStart(9) +
      `  +${r.pct.toFixed(0)}%`.padStart(6) +
      `  ${r.maxDD.toFixed(1)}%`.padStart(7)
    );
  }
  console.log();
  console.log("  Note: market model fills on signal candle close; limit model fills next candle if price pulls back.");
})();
