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

// Market buy: entry = close * (1 + entryCost)  — no fill check, always fills
const SCENARIOS = [
  { label: "Original (no cost)",        entryCost: 0.0000 },
  { label: "+ 0.05% (fee only)",        entryCost: 0.0005 },
  { label: "+ 0.10%",                   entryCost: 0.0010 },
  { label: "+ 0.13% (spread today)",    entryCost: 0.0013 },
  { label: "+ 0.15% (spread+fee)",      entryCost: 0.0015 },
  { label: "+ 0.20%",                   entryCost: 0.0020 },
];

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
    for (const c of raw) candles.push({ open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]) });
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
  const s = Math.sqrt(sp.reduce((a, b) => a + (b-m)**2, 0) / sp.length);
  return s === 0 ? 0 : (sp[sp.length-1] - m) / s;
}

function run(aligned: { high: number; low: number; close: number }[], btcClose: number[], altClose: number[], entryCost: number) {
  let bal = ALLOCATION, peak = ALLOCATION, maxDD = 0;
  let trades = 0, wins = 0, gW = 0, gL = 0;
  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chasePrice: number };
  let pos: Pos | null = null;

  for (let i = CORR_WINDOW + 1; i < aligned.length - 1; i++) {
    const next = aligned[i + 1];

    if (pos) {
      if (pos.chasing) {
        if (next.low <= pos.chasePrice) {
          const pnl = (pos.chasePrice - pos.entry) * (bal / pos.entry);
          bal += pnl; trades++;
          if (pnl >= 0) { wins++; gW += pnl; } else gL += Math.abs(pnl);
          if (bal > peak) peak = bal;
          if ((bal-peak)/peak*100 < maxDD) maxDD = (bal-peak)/peak*100;
          pos = null;
        } else {
          pos.chasePrice = next.close;
        }
        continue;
      }

      pos.hold++;
      if (next.low <= pos.sl) {
        const pnl = (pos.sl - pos.entry) * (bal / pos.entry);
        bal += pnl; trades++; gL += Math.abs(pnl);
        if (bal > peak) peak = bal;
        if ((bal-peak)/peak*100 < maxDD) maxDD = (bal-peak)/peak*100;
        pos = null;
      } else if (next.high >= pos.tp) {
        const pnl = (pos.tp - pos.entry) * (bal / pos.entry);
        bal += pnl; trades++; wins++; gW += pnl;
        if (bal > peak) peak = bal;
        if ((bal-peak)/peak*100 < maxDD) maxDD = (bal-peak)/peak*100;
        pos = null;
      } else if (pos.hold >= MAX_HOLD) {
        pos.chasing = true;
        pos.chasePrice = next.close;
      }
      continue;
    }

    const z = calcZ(btcClose, altClose, i);
    if (z <= -Z_THRESH) {
      const entry = aligned[i].close * (1 + entryCost);
      pos = { entry, tp: entry * (1 + TP_PCT), sl: entry * (1 - SL_PCT), hold: 0, chasing: false, chasePrice: 0 };
    }
  }

  const pf = gL > 0 ? gW / gL : Infinity;
  return { pnl: bal - ALLOCATION, trades, wr: trades > 0 ? wins/trades*100 : 0, pf, maxDD };
}

(async () => {
  process.stdout.write("Fetching BTC... ");
  const btcRaw = await fetchKlines("BTCUSDT");
  console.log(`${btcRaw.length} candles`);

  process.stdout.write("Fetching XLM... ");
  const xlmRaw = await fetchKlines("XLMUSDT");
  console.log(`${xlmRaw.length} candles\n`);

  const len      = Math.min(btcRaw.length, xlmRaw.length);
  const btcClose = btcRaw.slice(0, len).map(c => c.close);
  const altClose = xlmRaw.slice(0, len).map(c => c.close);
  const aligned  = xlmRaw.slice(0, len);

  console.log(`XLM Z-lag · Market buy cost simulation · Binance.US · 1m · 1 month`);
  console.log(`TP=${TP_PCT*100}%  SL=${SL_PCT*100}%  Z=${Z_THRESH}  $${ALLOCATION}\n`);
  console.log(`${"Scenario".padEnd(30)} ${"Trades".padStart(7)} ${"WR%".padStart(6)} ${"PF".padStart(5)} ${"PnL".padStart(10)} ${"Ret%".padStart(7)} ${"MaxDD".padStart(7)}`);
  console.log("─".repeat(74));

  for (const s of SCENARIOS) {
    const r = run(aligned, btcClose, altClose, s.entryCost);
    const sign = r.pnl >= 0 ? "+" : "";
    console.log(
      s.label.padEnd(30) +
      `${r.trades}`.padStart(7) +
      `${r.wr.toFixed(1)}%`.padStart(6) +
      `${r.pf === Infinity ? "∞" : r.pf.toFixed(2)}`.padStart(5) +
      `${sign}$${r.pnl.toFixed(2)}`.padStart(10) +
      `${sign}${(r.pnl/ALLOCATION*100).toFixed(1)}%`.padStart(7) +
      `${r.maxDD.toFixed(2)}%`.padStart(7)
    );
  }

  console.log(`\n  Today's spread on XLM/Binance.US: ~0.13%`);
  console.log(`  With market buy (spread+fee=0.15%): SL is effectively at breakeven`);
  console.log(`  Suggests: widen SL or find coin with tighter spread`);
})();
