// Backtest: Pure Lag · XLM
// Signal: (XLM global close - XLM.US close) / XLM.US close >= 0.1%
// Exactly mirrors live-bot-xlm-purelag.ts parameters
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US     = "https://api.binance.us/api/v3";
const BASE_GL     = "https://api.binance.com/api/v3";
const KEY         = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

// ── Exact live bot parameters ─────────────────────────────────────────────────
const GL_THRESH  = 0.001;   // global must be >= 0.1% above US price
const TP_PCT     = 0.008;   // 0.8% take profit
const SL_PCT     = 0.0015;  // 0.15% stop loss
const MAX_HOLD   = 6;       // 6 candles max hold, then start chasing
const ALLOCATION = 25;
const ENTRY_SLIP = 0.0002;  // +0.02% limit buy offset (maker, 0% fee on Binance.US)

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

(async () => {
  process.stdout.write("Fetching XLM 1m Binance.US...     "); const xlmUS = await fetchKlines(BASE_US, "XLMUSDT"); console.log(`${xlmUS.length} candles`);
  process.stdout.write("Fetching XLM 1m Binance global... "); const xlmGL = await fetchKlines(BASE_GL, "XLMUSDT"); console.log(`${xlmGL.length} candles`);

  // Align on shared timestamps
  const glMap   = new Map(xlmGL.map(c => [c.time, c.close]));
  const aligned = xlmUS.filter(c => glMap.has(c.time));
  const usClose = aligned.map(c => c.close);
  const glClose = aligned.map(c => glMap.get(c.time)!);

  console.log(`\nAligned candles: ${aligned.length}  (~${(aligned.length / 60 / 24).toFixed(1)} days)\n`);

  // ── Simulation ──────────────────────────────────────────────────────────────
  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chasePrice: number };

  // Fixed sizing: always risk exactly ALLOCATION ($25), matching live bot behavior
  let totalPnl = 0, peakPnl = 0, maxDD = 0;
  let trades = 0, wins = 0, losses = 0, expires = 0, missed = 0;
  let gW = 0, gL = 0;
  let pos: Pos | null = null;
  let pending: number | null = null; // limit buy price waiting for next candle

  const dailyTrades: Map<string, number> = new Map();

  for (let i = 1; i < aligned.length; i++) {
    const { high, low, close, time } = aligned[i];
    const day = new Date(time).toISOString().slice(0, 10);

    // ── Try to fill pending limit buy ────────────────────────────────────────
    if (pending !== null) {
      if (low <= pending) {
        const entry = pending;
        pos = { entry, tp: entry * (1 + TP_PCT), sl: entry * (1 - SL_PCT), hold: 0, chasing: false, chasePrice: 0 };
        dailyTrades.set(day, (dailyTrades.get(day) ?? 0) + 1);
      } else {
        missed++;
      }
      pending = null;
      continue;
    }

    // ── Manage open position ─────────────────────────────────────────────────
    if (pos) {
      const qty = ALLOCATION / pos.entry; // fixed sizing: always $25 in
      if (pos.chasing) {
        if (low <= pos.chasePrice) {
          const pnl = (pos.chasePrice - pos.entry) * qty;
          totalPnl += pnl; trades++;
          if (pnl >= 0) { wins++; gW += pnl; } else { losses++; gL += Math.abs(pnl); }
          if (totalPnl > peakPnl) peakPnl = totalPnl;
          const dd = totalPnl - peakPnl;
          if (dd < maxDD) maxDD = dd;
          pos = null;
        } else {
          pos.chasePrice = close;
        }
      } else {
        pos.hold++;
        if (low <= pos.sl) {
          const pnl = (pos.sl - pos.entry) * qty;
          totalPnl += pnl; trades++; losses++; gL += Math.abs(pnl);
          if (totalPnl > peakPnl) peakPnl = totalPnl;
          const dd = totalPnl - peakPnl;
          if (dd < maxDD) maxDD = dd;
          pos = null;
        } else if (high >= pos.tp) {
          const pnl = (pos.tp - pos.entry) * qty;
          totalPnl += pnl; trades++; wins++; gW += pnl;
          if (totalPnl > peakPnl) peakPnl = totalPnl;
          const dd = totalPnl - peakPnl;
          if (dd < maxDD) maxDD = dd;
          pos = null;
        } else if (pos.hold >= MAX_HOLD) {
          expires++;
          pos.chasing = true;
          pos.chasePrice = close;
        }
      }
      continue;
    }

    // ── Signal: XLM global price >= 0.1% above XLM.US price ────────────────
    const spread = (glClose[i] - usClose[i]) / usClose[i];
    if (spread >= GL_THRESH) {
      pending = close * (1 + ENTRY_SLIP);
    }
  }

  // ── Results ─────────────────────────────────────────────────────────────────
  const pct      = totalPnl / ALLOCATION * 100;
  const wr       = trades > 0 ? wins / trades * 100 : 0;
  const pf       = gL > 0 ? gW / gL : Infinity;
  const fillRate = (trades + missed) > 0 ? trades / (trades + missed) * 100 : 0;
  const days     = aligned.length / 60 / 24;

  const tradesByDay = [...dailyTrades.values()];
  const avgPerDay   = tradesByDay.length > 0 ? tradesByDay.reduce((a, b) => a + b, 0) / days : 0;
  const maxPerDay   = tradesByDay.length > 0 ? Math.max(...tradesByDay) : 0;
  const minPerDay   = tradesByDay.length > 0 ? Math.min(...tradesByDay) : 0;
  const zeroDays    = Math.round(days) - dailyTrades.size;

  const signals = trades + missed;

  console.log(`Pure Lag · XLM/USDT · 1m · ${Math.round(days)} days`);
  console.log(`Signal: XLM global ≥ ${GL_THRESH*100}% above XLM.US (cross-exchange spread)`);
  console.log(`Entry +${ENTRY_SLIP*100}% limit · TP=${TP_PCT*100}% · SL=${SL_PCT*100}% · MAX_HOLD=${MAX_HOLD} · $${ALLOCATION} fixed`);
  console.log(`─────────────────────────────────────────────────────────`);
  console.log(`PnL:        ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)} (${totalPnl >= 0 ? "+" : ""}${pct.toFixed(1)}% on $${ALLOCATION})`);
  console.log(`Max drawdown: $${maxDD.toFixed(2)}`);
  console.log(`─────────────────────────────────────────────────────────`);
  console.log(`Signals:    ${signals}  (${(signals/days).toFixed(1)}/day)`);
  console.log(`Fills:      ${trades} (${fillRate.toFixed(0)}% fill rate, ${missed} missed)`);
  console.log(`Win rate:   ${wr.toFixed(1)}%  (${wins}W / ${losses}L)`);
  console.log(`Profit fac: ${pf === Infinity ? "∞" : pf.toFixed(2)}`);
  console.log(`Expires→chase: ${expires}`);
  console.log(`─────────────────────────────────────────────────────────`);
  console.log(`Avg trades/day: ${avgPerDay.toFixed(1)}`);
  console.log(`Max trades/day: ${maxPerDay}`);
  console.log(`Min trades/day: ${minPerDay}  (${zeroDays} days with 0 trades)`);

  console.log(`\nDaily breakdown:`);
  const sortedDays = [...dailyTrades.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [d, n] of sortedDays) {
    console.log(`  ${d}: ${n} trade${n !== 1 ? "s" : ""}`);
  }
})();
