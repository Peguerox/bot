import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US = "https://api.binance.us/api/v3";
const BASE_GL = "https://api.binance.com/api/v3";
const KEY = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

// New proposed settings
const TP_PCT    = 0.0015;  // 0.15%
const SL_PCT    = 0.0015;  // 0.15%
const GL_THRESH = 0.0015;  // 0.15%
const MAX_HOLD  = 6;
const ALLOC     = 25;

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

function sim(aligned: { high: number; low: number; close: number }[], usClose: number[], glClose: number[], tp: number, sl: number, thresh: number) {
  let bal = ALLOC, peak = ALLOC, maxDD = 0, trades = 0, wins = 0, tpHits = 0, chaseExits = 0, gW = 0, gL = 0;
  let pos: { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chasePrice: number } | null = null;

  for (let i = 2; i < aligned.length; i++) {
    const { high, low, close } = aligned[i];

    if (pos) {
      const qty = ALLOC / pos.entry;
      if (pos.chasing) {
        if (low <= pos.chasePrice) {
          const pnl = (pos.chasePrice - pos.entry) * qty; bal += pnl; trades++; chaseExits++;
          if (pnl >= 0) { wins++; gW += pnl; } else gL += Math.abs(pnl);
          if (bal > peak) peak = bal; if ((peak-bal)/peak*100 > maxDD) maxDD=(peak-bal)/peak*100; pos = null;
        } else pos.chasePrice = close;
      } else {
        pos.hold++;
        if (low <= pos.sl) { const pnl=(pos.sl-pos.entry)*qty; bal+=pnl; trades++; gL+=Math.abs(pnl); if(bal>peak)peak=bal; if((peak-bal)/peak*100>maxDD)maxDD=(peak-bal)/peak*100; pos=null; }
        else if (high >= pos.tp) { const pnl=(pos.tp-pos.entry)*qty; bal+=pnl; trades++; wins++; tpHits++; gW+=pnl; if(bal>peak)peak=bal; if((peak-bal)/peak*100>maxDD)maxDD=(peak-bal)/peak*100; pos=null; }
        else if (pos.hold >= MAX_HOLD) { pos.chasing = true; pos.chasePrice = close; }
      }
      continue;
    }

    const spread = (glClose[i-1]-usClose[i-1])/usClose[i-1];
    const glRet  = (glClose[i-1]-glClose[i-2])/glClose[i-2];
    const usRet  = (usClose[i-1]-usClose[i-2])/usClose[i-2];
    if (spread >= thresh && glRet > 0 && usRet < glRet) {
      const entry = close * 1.0002;
      pos = { entry, tp: entry*(1+tp), sl: entry*(1-sl), hold: 0, chasing: false, chasePrice: 0 };
    }
  }

  const days = aligned.length/60/24;
  const pnl = bal-ALLOC, wr = trades>0?wins/trades*100:0, pf = gL>0?gW/gL:Infinity;
  return { pnl, pct: pnl/ALLOC*100, wr, pf, trades, tpHits, chaseExits, maxDD, perDay: trades/days };
}

(async () => {
  process.stdout.write("Fetching BTC US... "); const btcUS = await fetchKlines(BASE_US, "BTCUSDT"); console.log(btcUS.length);
  process.stdout.write("Fetching BTC GL... "); const btcGL = await fetchKlines(BASE_GL, "BTCUSDT"); console.log(btcGL.length);
  const glMap = new Map(btcGL.map(c => [c.time, c.close]));
  const aligned = btcUS.filter(c => glMap.has(c.time));
  const usClose = aligned.map(c => c.close);
  const glClose = aligned.map(c => glMap.get(c.time)!);

  console.log("\n  Comparing current vs proposed settings (30d, last-candle signal)\n");
  console.log("  Settings              Trades  /day  TP hits  WR%    PF      PnL$    Ret%   MaxDD%");
  console.log("  " + "─".repeat(82));

  // Current live settings
  const cur = sim(aligned, usClose, glClose, 0.004, 0.0015, 0.001);
  const curPf = cur.pf === Infinity ? " inf" : cur.pf.toFixed(2);
  console.log(
    "  TP0.4% SL0.15% T0.10%".padEnd(22) +
    `${cur.trades}`.padStart(7) + `  ${cur.perDay.toFixed(1)}`.padStart(6) +
    `  ${cur.tpHits}`.padStart(8) + `  ${cur.wr.toFixed(1)}%`.padStart(6) +
    `  ${curPf}`.padStart(6) + `  +$${cur.pnl.toFixed(2)}`.padStart(8) +
    `  +${cur.pct.toFixed(0)}%`.padStart(5) + `  ${cur.maxDD.toFixed(1)}%`.padStart(7) + "  ← current"
  );

  // New symmetric settings
  const r = sim(aligned, usClose, glClose, TP_PCT, SL_PCT, GL_THRESH);
  const pf = r.pf === Infinity ? " inf" : r.pf.toFixed(2);
  console.log(
    "  TP0.15% SL0.15% T0.15%".padEnd(22) +
    `${r.trades}`.padStart(7) + `  ${r.perDay.toFixed(1)}`.padStart(6) +
    `  ${r.tpHits}`.padStart(8) + `  ${r.wr.toFixed(1)}%`.padStart(6) +
    `  ${pf}`.padStart(6) + `  +$${r.pnl.toFixed(2)}`.padStart(8) +
    `  +${r.pct.toFixed(0)}%`.padStart(5) + `  ${r.maxDD.toFixed(1)}%`.padStart(7) + "  ← proposed"
  );

  console.log();
  console.log(`  Proposed: signal fires at 0.15% spread → TP at 0.15% above entry`);
  console.log(`  On BTC @$62k: signal when global is $93 ahead → TP at $93 above entry`);
  console.log(`  The catch-up move should naturally reach TP when spread closes`);
})();
