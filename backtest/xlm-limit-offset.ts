import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE        = "https://api.binance.us/api/v3";
const KEY         = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

const CORR_WINDOW = 20;
const Z_THRESH    = 1.5;
const TP_PCT      = 0.008;
const SL_PCT      = 0.0015;
const MAX_HOLD    = 6;
const ALLOCATION  = 25;

// Limit buy above close = maker order = 0 fee on Binance.US
// offset is the ONLY cost — what % above close we set our limit
const OFFSETS = [0, 0.0001, 0.0002, 0.0003, 0.0005, 0.001, 0.002, 0.005];

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string) {
  const candles: { open: number; high: number; low: number; close: number }[] = [];
  let from = Date.now() - LOOKBACK_MS;
  const end = Date.now();
  while (from < end) {
    const res = await fetch(
      `${BASE}/klines?symbol=${symbol}&interval=1m&startTime=${from}&endTime=${end}&limit=1000`,
      { headers: { "X-MBX-APIKEY": KEY } }
    );
    if (res.status === 429) { await sleep(10000); continue; }
    const raw = await res.json() as any;
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) candles.push({
      open: parseFloat(c[1]), high: parseFloat(c[2]),
      low:  parseFloat(c[3]), close: parseFloat(c[4]),
    });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(150);
  }
  return candles;
}

function calcZ(btc: number[], alt: number[], i: number) {
  if (i < CORR_WINDOW + 1) return 0;
  const sp: number[] = [];
  for (let j = i - CORR_WINDOW; j <= i; j++)
    sp.push(Math.log(alt[j] / alt[j-1]) - Math.log(btc[j] / btc[j-1]));
  const m = sp.reduce((a, b) => a + b, 0) / sp.length;
  const s = Math.sqrt(sp.reduce((a, b) => a + (b - m) ** 2, 0) / sp.length);
  return s === 0 ? 0 : (sp[sp.length - 1] - m) / s;
}

function run(aligned: { high: number; low: number; close: number }[], btcClose: number[], altClose: number[], offset: number) {
  let bal = ALLOCATION, peak = ALLOCATION, maxDD = 0;
  let trades = 0, wins = 0, missed = 0, gW = 0, gL = 0;

  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chasePrice: number };
  let pos: Pos | null = null;
  let pending: number | null = null; // limit price waiting to fill next candle

  for (let i = CORR_WINDOW + 1; i < aligned.length; i++) {
    const { high, low, close } = aligned[i];

    // ── 1. Check fill of pending limit buy in THIS candle ──────────────────
    if (pending !== null) {
      if (low <= pending) {
        // Filled: maker limit → entry at our limit price, 0 fee
        const entry = pending;
        pos = { entry, tp: entry * (1 + TP_PCT), sl: entry * (1 - SL_PCT), hold: 0, chasing: false, chasePrice: 0 };
      } else {
        missed++;
      }
      pending = null;
      continue; // TP/SL checked from next candle onwards
    }

    // ── 2. Manage open position ────────────────────────────────────────────
    if (pos) {
      if (pos.chasing) {
        if (low <= pos.chasePrice) {
          const pnl = (pos.chasePrice - pos.entry) * (bal / pos.entry);
          bal += pnl; trades++;
          if (pnl >= 0) { wins++; gW += pnl; } else gL += Math.abs(pnl);
          if (bal > peak) peak = bal;
          if ((bal - peak) / peak * 100 < maxDD) maxDD = (bal - peak) / peak * 100;
          pos = null;
        } else {
          pos.chasePrice = close;
        }
      } else {
        pos.hold++;
        if (low <= pos.sl) {
          const pnl = (pos.sl - pos.entry) * (bal / pos.entry);
          bal += pnl; trades++; gL += Math.abs(pnl);
          if (bal > peak) peak = bal;
          if ((bal - peak) / peak * 100 < maxDD) maxDD = (bal - peak) / peak * 100;
          pos = null;
        } else if (high >= pos.tp) {
          const pnl = (pos.tp - pos.entry) * (bal / pos.entry);
          bal += pnl; trades++; wins++; gW += pnl;
          if (bal > peak) peak = bal;
          if ((bal - peak) / peak * 100 < maxDD) maxDD = (bal - peak) / peak * 100;
          pos = null;
        } else if (pos.hold >= MAX_HOLD) {
          pos.chasing = true;
          pos.chasePrice = close;
        }
      }
      continue;
    }

    // ── 3. Look for entry signal ────────────────────────────────────────────
    const z = calcZ(btcClose, altClose, i);
    if (z <= -Z_THRESH) {
      pending = close * (1 + offset); // place limit buy above close
    }
  }

  const signals  = trades + missed;
  const fillRate = signals > 0 ? trades / signals * 100 : 0;
  const wr       = trades > 0 ? wins / trades * 100 : 0;
  const pf       = gL > 0 ? gW / gL : Infinity;
  return { pnl: bal - ALLOCATION, trades, missed, fillRate, wr, pf, maxDD };
}

(async () => {
  process.stdout.write("Fetching BTC 1m (Binance.US)... ");
  const btcRaw = await fetchKlines("BTCUSDT");
  console.log(`${btcRaw.length} candles`);

  process.stdout.write("Fetching XLM 1m (Binance.US)... ");
  const xlmRaw = await fetchKlines("XLMUSDT");
  console.log(`${xlmRaw.length} candles\n`);

  const len      = Math.min(btcRaw.length, xlmRaw.length);
  const btcClose = btcRaw.slice(0, len).map(c => c.close);
  const altClose = xlmRaw.slice(0, len).map(c => c.close);
  const aligned  = xlmRaw.slice(0, len);

  console.log(`XLM Z-lag · Limit buy above close · Binance.US · 1m · 1 month`);
  console.log(`Maker order = 0 fee · TP=${TP_PCT*100}%  SL=${SL_PCT*100}%  Z=${Z_THRESH}  $${ALLOCATION}`);
  console.log(`Fill = price dips back to limit in the next 1m candle\n`);
  console.log(`${"Offset".padEnd(10)} ${"Fills".padStart(6)} ${"Missed".padStart(7)} ${"Fill%".padStart(6)} ${"WR%".padStart(6)} ${"PF".padStart(5)} ${"PnL".padStart(9)} ${"Ret%".padStart(7)} ${"MaxDD".padStart(7)}`);
  console.log("─".repeat(72));

  for (const offset of OFFSETS) {
    const r = run(aligned, btcClose, altClose, offset);
    const sign = r.pnl >= 0 ? "+" : "";
    console.log(
      `+${(offset * 100).toFixed(3)}%`.padEnd(10) +
      `${r.trades}`.padStart(6) +
      `${r.missed}`.padStart(7) +
      `${r.fillRate.toFixed(1)}%`.padStart(6) +
      `${r.wr.toFixed(1)}%`.padStart(6) +
      `${r.pf === Infinity ? "∞" : r.pf.toFixed(2)}`.padStart(5) +
      `${sign}$${r.pnl.toFixed(2)}`.padStart(9) +
      `${sign}${(r.pnl / ALLOCATION * 100).toFixed(1)}%`.padStart(7) +
      `${r.maxDD.toFixed(2)}%`.padStart(7)
    );
  }

  console.log(`\n  Fill logic: limit order placed after signal candle closes.`);
  console.log(`  Fills if the NEXT candle's LOW touches the limit price.`);
  console.log(`  Missed = price ran up immediately, limit never touched.`);
})();
