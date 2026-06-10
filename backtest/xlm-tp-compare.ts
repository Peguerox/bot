// Compare TP values for Pure Lag XLM bot
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US     = "https://api.binance.us/api/v3";
const BASE_GL     = "https://api.binance.com/api/v3";
const KEY         = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

const GL_THRESH  = 0.0005;
const SL_PCT     = 0.0015;
const MAX_HOLD   = 6;
const ALLOCATION = 25;
const ENTRY_SLIP = 0.0002;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(base: string, symbol: string) {
  const candles: { time: number; high: number; low: number; close: number }[] = [];
  let from = Date.now() - LOOKBACK_MS, end = Date.now();
  while (from < end) {
    const res = await fetch(
      `${base}/klines?symbol=${symbol}&interval=1m&startTime=${from}&endTime=${end}&limit=1000`,
      { headers: { "X-MBX-APIKEY": KEY } }
    );
    if (res.status === 429) { await sleep(10000); continue; }
    const raw = await res.json() as any;
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) candles.push({
      time: Number(c[0]), high: parseFloat(c[2]),
      low:  parseFloat(c[3]), close: parseFloat(c[4]),
    });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(150);
  }
  return candles;
}

function runSim(
  aligned: { high: number; low: number; close: number }[],
  usClose: number[], glClose: number[],
  tpPct: number,
) {
  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chasePrice: number };
  let bal = ALLOCATION, peak = ALLOCATION, maxDD = 0;
  let trades = 0, wins = 0, missed = 0, gW = 0, gL = 0;
  let pos: Pos | null = null, pending: number | null = null;

  for (let i = 1; i < aligned.length; i++) {
    const { high, low, close } = aligned[i];

    if (pending !== null) {
      if (low <= pending) {
        const e = pending;
        pos = { entry: e, tp: e * (1 + tpPct), sl: e * (1 - SL_PCT), hold: 0, chasing: false, chasePrice: 0 };
      } else missed++;
      pending = null; continue;
    }

    if (pos) {
      const qty = bal / pos.entry;
      if (pos.chasing) {
        if (low <= pos.chasePrice) {
          const pnl = (pos.chasePrice - pos.entry) * qty;
          bal += pnl; trades++;
          if (pnl >= 0) { wins++; gW += pnl; } else gL += Math.abs(pnl);
          if (bal > peak) peak = bal;
          if ((peak - bal) / peak * 100 > maxDD) maxDD = (peak - bal) / peak * 100;
          pos = null;
        } else pos.chasePrice = close;
      } else {
        pos.hold++;
        if (low <= pos.sl) {
          const pnl = (pos.sl - pos.entry) * qty; bal += pnl; trades++; gL += Math.abs(pnl);
          if (bal > peak) peak = bal;
          if ((peak - bal) / peak * 100 > maxDD) maxDD = (peak - bal) / peak * 100;
          pos = null;
        } else if (high >= pos.tp) {
          const pnl = (pos.tp - pos.entry) * qty; bal += pnl; trades++; wins++; gW += pnl;
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
    const glRet  = i > 0 ? (glClose[i] - glClose[i-1]) / glClose[i-1] : 0;
    const usRet  = i > 0 ? (usClose[i] - usClose[i-1]) / usClose[i-1] : 0;
    if (spread >= GL_THRESH && glRet > 0 && usRet < glRet) {
      pending = close * (1 + ENTRY_SLIP);
    }
  }

  const pnl = bal - ALLOCATION;
  const wr  = trades > 0 ? wins / trades * 100 : 0;
  const pf  = gL > 0 ? gW / gL : Infinity;
  const days = aligned.length / 60 / 24;
  return { pnl, pct: pnl / ALLOCATION * 100, wr, pf, trades, wins, missed, maxDD, perDay: trades / days };
}

(async () => {
  process.stdout.write("Fetching XLM US... "); const xlmUS = await fetchKlines(BASE_US, "XLMUSDT"); console.log(xlmUS.length);
  process.stdout.write("Fetching XLM GL... "); const xlmGL = await fetchKlines(BASE_GL, "XLMUSDT"); console.log(xlmGL.length);

  const glMap   = new Map(xlmGL.map(c => [c.time, c.close]));
  const aligned = xlmUS.filter(c => glMap.has(c.time));
  const usClose = aligned.map(c => c.close);
  const glClose = aligned.map(c => glMap.get(c.time)!);

  console.log(`\nAligned: ${aligned.length} candles (~${(aligned.length/60/24).toFixed(1)} days)`);
  console.log(`Signal ≥0.05% + direction  SL=${SL_PCT*100}%  MAX_HOLD=${MAX_HOLD}  $${ALLOCATION} compounding\n`);

  console.log("  TP       Trades   /day   WR%    PF     TP hits   PnL$       Ret%    MaxDD%");
  console.log("  " + "─".repeat(75));

  for (const tp of [0.002, 0.003, 0.004, 0.005, 0.006, 0.008, 0.010]) {
    const r = runSim(aligned, usClose, glClose, tp);
    const pf = r.pf === Infinity ? "  ∞" : r.pf.toFixed(2);
    console.log(
      `  ${(tp*100).toFixed(1)}%`.padEnd(8) +
      `${r.trades}`.padStart(7) +
      `  ${r.perDay.toFixed(1)}`.padStart(6) +
      `  ${r.wr.toFixed(1)}%`.padStart(6) +
      `  ${pf}`.padStart(5) +
      `  ${r.wins}`.padStart(9) +
      `  +$${r.pnl.toFixed(2)}`.padStart(10) +
      `  +${r.pct.toFixed(0)}%`.padStart(7) +
      `  ${r.maxDD.toFixed(1)}%`.padStart(7)
    );
  }
})();
