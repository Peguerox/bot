import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US     = "https://api.binance.us/api/v3";
const BASE_GL     = "https://api.binance.com/api/v3";
const KEY         = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const TP_PCT = 0.008, SL_PCT = 0.0015, MAX_HOLD = 6, ALLOCATION = 25, ENTRY_SLIP = 0.0002;

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

function runSim(aligned: { high: number; low: number; close: number }[], usClose: number[], glClose: number[], thresh: number) {
  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chasePrice: number };
  let bal = ALLOCATION, peak = ALLOCATION, maxDD = 0, trades = 0, wins = 0, missed = 0, gW = 0, gL = 0;
  let pos: Pos | null = null, pending: number | null = null;
  for (let i = 1; i < aligned.length; i++) {
    const { high, low, close } = aligned[i];
    if (pending !== null) {
      if (low <= pending) { const e = pending; pos = { entry: e, tp: e*(1+TP_PCT), sl: e*(1-SL_PCT), hold: 0, chasing: false, chasePrice: 0 }; }
      else missed++;
      pending = null; continue;
    }
    if (pos) {
      const qty = bal / pos.entry;
      if (pos.chasing) {
        if (low <= pos.chasePrice) {
          const pnl = (pos.chasePrice - pos.entry) * qty; bal += pnl; trades++;
          if (pnl >= 0) { wins++; gW += pnl; } else gL += Math.abs(pnl);
          if (bal > peak) peak = bal; if ((peak-bal)/peak*100 > maxDD) maxDD = (peak-bal)/peak*100; pos = null;
        } else pos.chasePrice = close;
      } else {
        pos.hold++;
        if (low <= pos.sl) { const pnl = (pos.sl-pos.entry)*qty; bal+=pnl; trades++; gL+=Math.abs(pnl); if(bal>peak)peak=bal; if((peak-bal)/peak*100>maxDD)maxDD=(peak-bal)/peak*100; pos=null; }
        else if (high >= pos.tp) { const pnl = (pos.tp-pos.entry)*qty; bal+=pnl; trades++; wins++; gW+=pnl; if(bal>peak)peak=bal; if((peak-bal)/peak*100>maxDD)maxDD=(peak-bal)/peak*100; pos=null; }
        else if (pos.hold >= MAX_HOLD) { pos.chasing = true; pos.chasePrice = close; }
      }
      continue;
    }
    if ((glClose[i] - usClose[i]) / usClose[i] >= thresh) pending = close * (1 + ENTRY_SLIP);
  }
  const pnl = bal-ALLOCATION, wr = trades>0?wins/trades*100:0, pf = gL>0?gW/gL:Infinity;
  const fillRate = (trades+missed)>0?trades/(trades+missed)*100:0, days = aligned.length/60/24;
  return { pnl, pct: pnl/ALLOCATION*100, wr, pf, trades, fills: trades, fillRate, missed, maxDD, perDay: trades/days };
}

(async () => {
  process.stdout.write("Fetching XLM US...  "); const xlmUS = await fetchKlines(BASE_US, "XLMUSDT"); console.log(xlmUS.length);
  process.stdout.write("Fetching XLM GL...  "); const xlmGL = await fetchKlines(BASE_GL, "XLMUSDT"); console.log(xlmGL.length);
  const glMap = new Map(xlmGL.map(c => [c.time, c.close]));
  const aligned = xlmUS.filter(c => glMap.has(c.time));
  const usClose = aligned.map(c => c.close), glClose = aligned.map(c => glMap.get(c.time)!);
  console.log(`\nAligned: ${aligned.length} candles · TP=${TP_PCT*100}% SL=${SL_PCT*100}% MAX_HOLD=${MAX_HOLD} $${ALLOCATION} compounding\n`);
  console.log("  Threshold   Trades  /day   Fill%    WR%     PF     PnL$      Ret%   MaxDD%");
  console.log("  " + "─".repeat(72));
  for (const thresh of [0.0001, 0.0005, 0.001, 0.002, 0.003]) {
    const r = runSim(aligned, usClose, glClose, thresh);

    const pf = r.pf === Infinity ? "  ∞" : r.pf.toFixed(2);
    console.log(
      `  ${(thresh*100).toFixed(3)}%`.padEnd(12) +
      `${r.fills}`.padStart(8) + `  ${r.perDay.toFixed(1)}`.padStart(6) +
      `  ${r.fillRate.toFixed(0)}%`.padStart(6) +
      `  ${r.wr.toFixed(1)}%`.padStart(7) +
      `  ${pf}`.padStart(6) +
      `  +$${r.pnl.toFixed(2)}`.padStart(10) +
      `  +${r.pct.toFixed(0)}%`.padStart(7) +
      `  ${r.maxDD.toFixed(1)}%`.padStart(7)
    );
  }
})();
