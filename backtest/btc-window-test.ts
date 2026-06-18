import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US     = "https://api.binance.us/api/v3";
const BASE_GL     = "https://api.binance.com/api/v3";
const KEY         = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

const GL_THRESH   = 0.001;    // 0.10% — match live bot
const TP_PCT      = 0.008;
const SL_PCT      = 0.0015;
const MAX_HOLD    = 6;
const ALLOCATION  = 25;
const ENTRY_SLIP  = 0.0002;
const CANCEL_DROP = 0.0015;

// 11am–12pm ET = 15:00–16:00 UTC (summer, EDT)
const WIN_START = 15;
const WIN_END   = 16;

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

function runSim(label: string, aligned: { time: number; open: number; high: number; low: number; close: number }[], usClose: number[], glClose: number[], windowOnly: boolean) {
  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chasePrice: number };
  let bal = ALLOCATION, peak = ALLOCATION, maxDD = 0;
  let trades = 0, wins = 0, losses = 0, chaseExits = 0;
  let cancelDrops = 0, missed = 0, gW = 0, gL = 0, slHits = 0, tpHits = 0;
  let pos: Pos | null = null, pending: number | null = null;

  for (let i = 1; i < aligned.length; i++) {
    const { time, high, low, close } = aligned[i];
    const hourUTC = new Date(time).getUTCHours();
    const inWindow = !windowOnly || (hourUTC >= WIN_START && hourUTC < WIN_END);

    if (pending !== null) {
      const orderPrice = pending;
      if (low <= orderPrice * (1 - CANCEL_DROP)) { cancelDrops++; pending = null; continue; }
      if (low <= orderPrice) {
        pos = { entry: orderPrice, tp: orderPrice * (1 + TP_PCT), sl: orderPrice * (1 - SL_PCT), hold: 0, chasing: false, chasePrice: 0 };
      } else { missed++; }
      pending = null; continue;
    }

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
          bal += pnl; trades++; losses++; slHits++; gL += Math.abs(pnl);
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

    if (!inWindow) continue;

    const spread = (glClose[i] - usClose[i]) / usClose[i];
    const glRet  = (glClose[i] - glClose[i-1]) / glClose[i-1];
    const usRet  = (usClose[i] - usClose[i-1]) / usClose[i-1];
    if (spread >= GL_THRESH && glRet > 0 && usRet < glRet) {
      pending = close * (1 + ENTRY_SLIP);
    }
  }

  const pnl = bal - ALLOCATION;
  const wr  = trades > 0 ? wins / trades * 100 : 0;
  const pf  = gL > 0 ? gW / gL : Infinity;
  const pfStr = pf === Infinity ? "∞" : pf.toFixed(2);
  const days = aligned.length / 60 / 24;

  console.log(`\n─── ${label} ───`);
  console.log(`Trades: ${trades}  (${(trades/days).toFixed(1)}/day)  |  Fill rate: ${trades > 0 ? Math.round(trades/(trades+missed+cancelDrops)*100) : 0}%`);
  console.log(`Win rate: ${wr.toFixed(1)}%  |  TP: ${tpHits}  SL: ${slHits}  Chase: ${chaseExits}`);
  console.log(`PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}  (${(pnl/ALLOCATION*100).toFixed(1)}%)  |  PF: ${pfStr}  |  Max DD: ${maxDD.toFixed(2)}%`);
  console.log(`End bal: $${bal.toFixed(2)}`);
}

(async () => {
  process.stdout.write("Fetching BTC US... "); const btcUS = await fetchKlines(BASE_US, "BTCUSDT"); console.log(btcUS.length, "candles");
  process.stdout.write("Fetching BTC GL... "); const btcGL = await fetchKlines(BASE_GL, "BTCUSDT"); console.log(btcGL.length, "candles");

  const glMap   = new Map(btcGL.map(c => [c.time, c.close]));
  const aligned = btcUS.filter(c => glMap.has(c.time)).map(c => ({ ...c, close: c.close }));
  const usClose = aligned.map(c => c.close);
  const glClose = aligned.map(c => glMap.get(c.time)!);

  console.log(`\nAligned: ${aligned.length} candles · ${(aligned.length/60/24).toFixed(1)} days`);
  console.log(`Signal: BTC global ≥ ${GL_THRESH*100}% above US + global rising + US lagging`);
  console.log(`TP +${TP_PCT*100}%  SL -${SL_PCT*100}%  MaxHold ${MAX_HOLD}min  $${ALLOCATION} allocation`);

  runSim("Full day (baseline)", aligned, usClose, glClose, false);
  runSim("11am–12pm ET only (15:00–16:00 UTC)", aligned, usClose, glClose, true);
})();
