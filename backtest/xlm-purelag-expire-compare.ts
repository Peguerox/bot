// Compare MAX_HOLD settings for Pure Lag XLM bot (compounding)
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US     = "https://api.binance.us/api/v3";
const BASE_GL     = "https://api.binance.com/api/v3";
const KEY         = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

const GL_THRESH  = 0.001;
const TP_PCT     = 0.008;
const SL_PCT     = 0.0015;
const ALLOCATION = 25;
const ENTRY_SLIP = 0.0002;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(base: string, symbol: string) {
  const candles: { time: number; open: number; high: number; low: number; close: number }[] = [];
  let from = Date.now() - LOOKBACK_MS;
  const end = Date.now();
  while (from < end) {
    const res = await fetch(
      `${base}/klines?symbol=${symbol}&interval=1m&startTime=${from}&endTime=${end}&limit=1000`,
      { headers: { "X-MBX-APIKEY": KEY } }
    );
    if (res.status === 429) { await sleep(10000); continue; }
    const raw = await res.json() as any;
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) candles.push({
      time: Number(c[0]), open: parseFloat(c[1]), high: parseFloat(c[2]),
      low:  parseFloat(c[3]), close: parseFloat(c[4]),
    });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(150);
  }
  return candles;
}

type Candle = { high: number; low: number; close: number };

function runSim(
  aligned: Candle[],
  usClose: number[],
  glClose: number[],
  maxHold: number, // Infinity = never expire
) {
  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chasePrice: number };

  let bal = ALLOCATION, peak = ALLOCATION, maxDD = 0;
  let trades = 0, wins = 0, losses = 0, expires = 0, missed = 0;
  let gW = 0, gL = 0;
  let pos: Pos | null = null;
  let pending: number | null = null;

  for (let i = 1; i < aligned.length; i++) {
    const { high, low, close } = aligned[i];

    if (pending !== null) {
      if (low <= pending) {
        const entry = pending;
        pos = { entry, tp: entry * (1 + TP_PCT), sl: entry * (1 - SL_PCT), hold: 0, chasing: false, chasePrice: 0 };
      } else {
        missed++;
      }
      pending = null;
      continue;
    }

    if (pos) {
      const qty = bal / pos.entry;
      if (pos.chasing) {
        if (low <= pos.chasePrice) {
          const pnl = (pos.chasePrice - pos.entry) * qty;
          bal += pnl; trades++;
          if (pnl >= 0) { wins++; gW += pnl; } else { losses++; gL += Math.abs(pnl); }
          if (bal > peak) peak = bal;
          const dd = (peak - bal) / peak * 100;
          if (dd > maxDD) maxDD = dd;
          pos = null;
        } else {
          pos.chasePrice = close;
        }
      } else {
        pos.hold++;
        if (low <= pos.sl) {
          const pnl = (pos.sl - pos.entry) * qty;
          bal += pnl; trades++; losses++; gL += Math.abs(pnl);
          if (bal > peak) peak = bal;
          const dd = (peak - bal) / peak * 100;
          if (dd > maxDD) maxDD = dd;
          pos = null;
        } else if (high >= pos.tp) {
          const pnl = (pos.tp - pos.entry) * qty;
          bal += pnl; trades++; wins++; gW += pnl;
          if (bal > peak) peak = bal;
          const dd = (peak - bal) / peak * 100;
          if (dd > maxDD) maxDD = dd;
          pos = null;
        } else if (pos.hold >= maxHold) {
          expires++;
          pos.chasing = true;
          pos.chasePrice = close;
        }
      }
      continue;
    }

    const spread = (glClose[i] - usClose[i]) / usClose[i];
    if (spread >= GL_THRESH) {
      pending = close * (1 + ENTRY_SLIP);
    }
  }

  const pnl    = bal - ALLOCATION;
  const pct    = pnl / ALLOCATION * 100;
  const wr     = trades > 0 ? wins / trades * 100 : 0;
  const pf     = gL > 0 ? gW / gL : Infinity;
  const days   = aligned.length / 60 / 24;
  const fillRate = (trades + missed) > 0 ? trades / (trades + missed) * 100 : 0;
  return { pnl, pct, bal, wr, pf, trades, wins, losses, expires, missed, fillRate, maxDD, days };
}

function pad(s: string, n: number) { return s.padStart(n); }

(async () => {
  process.stdout.write("Fetching XLM 1m Binance.US...     "); const xlmUS = await fetchKlines(BASE_US, "XLMUSDT"); console.log(`${xlmUS.length} candles`);
  process.stdout.write("Fetching XLM 1m Binance global... "); const xlmGL = await fetchKlines(BASE_GL, "XLMUSDT"); console.log(`${xlmGL.length} candles`);

  const glMap   = new Map(xlmGL.map(c => [c.time, c.close]));
  const aligned = xlmUS.filter(c => glMap.has(c.time));
  const usClose = aligned.map(c => c.close);
  const glClose = aligned.map(c => glMap.get(c.time)!);

  console.log(`\nAligned: ${aligned.length} candles (~${(aligned.length/60/24).toFixed(1)} days)\n`);
  console.log(`TP=${TP_PCT*100}%  SL=${SL_PCT*100}%  Entry+${ENTRY_SLIP*100}%  Signal≥${GL_THRESH*100}%  $${ALLOCATION} compounding\n`);

  const headers = ["MAX_HOLD", "Trades", "Fill%", "WR%", "PF", "Expires", "PnL$", "Ret%", "MaxDD%"];
  console.log(headers.map((h, i) => h.padStart([9,7,6,6,6,8,8,7,8][i])).join("  "));
  console.log("─".repeat(80));

  const cases: Array<{ label: string; maxHold: number }> = [
    { label: "No expire (∞)", maxHold: Infinity },
    { label: "20 candles",    maxHold: 20 },
    { label: "10 candles",    maxHold: 10 },
    { label: "6 candles ◄ live", maxHold: 6 },
    { label: "3 candles",    maxHold: 3 },
    { label: "1 candle",     maxHold: 1 },
  ];

  for (const { label, maxHold } of cases) {
    const r = runSim(aligned, usClose, glClose, maxHold);
    const pnlStr = `${r.pnl >= 0 ? "+" : ""}$${r.pnl.toFixed(2)}`;
    const pctStr = `${r.pct >= 0 ? "+" : ""}${r.pct.toFixed(0)}%`;
    const pfStr  = r.pf === Infinity ? "∞" : r.pf.toFixed(2);
    console.log(
      `  ${label.padEnd(18)}` +
      pad(String(r.trades), 6) +
      pad(`${r.fillRate.toFixed(0)}%`, 7) +
      pad(`${r.wr.toFixed(1)}%`, 7) +
      pad(pfStr, 6) +
      pad(String(r.expires), 9) +
      pad(pnlStr, 10) +
      pad(pctStr, 8) +
      pad(`${r.maxDD.toFixed(1)}%`, 8)
    );
  }

  console.log("\n── Detail: No expire (hold until TP or SL) ──────────────────");
  const noExp = runSim(aligned, usClose, glClose, Infinity);
  const avgHoldMin = noExp.expires === 0 ? "< 6" : "varies";
  console.log(`  Trades: ${noExp.trades}  (${(noExp.trades/noExp.days).toFixed(1)}/day)`);
  console.log(`  Wins: ${noExp.wins}  Losses: ${noExp.losses}`);
  console.log(`  End bal: $${noExp.bal.toFixed(2)}  on $${ALLOCATION} start`);
  console.log(`  Max DD: ${noExp.maxDD.toFixed(2)}%`);

  console.log("\n── Detail: 6 candles (current live) ──────────────────────────");
  const live = runSim(aligned, usClose, glClose, 6);
  console.log(`  Trades: ${live.trades}  (${(live.trades/live.days).toFixed(1)}/day)`);
  console.log(`  Wins: ${live.wins}  Losses: ${live.losses}  Expires: ${live.expires}`);
  console.log(`  End bal: $${live.bal.toFixed(2)}  on $${ALLOCATION} start`);
  console.log(`  Max DD: ${live.maxDD.toFixed(2)}%`);
})();
