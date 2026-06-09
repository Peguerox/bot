import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US     = "https://api.binance.us/api/v3";
const BASE_GL     = "https://api.binance.com/api/v3";
const KEY         = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

const CORR_WINDOW = 20;
const Z_THRESH    = 1.5;
const TP_PCT      = 0.008;
const SL_PCT      = 0.0015;
const MAX_HOLD    = 6;
const ALLOCATION  = 25;
const ENTRY_SLIP  = 0.0002; // +0.02% limit offset (our current setup)

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

// Z-score of (altReturn - leaderReturn) over 20 candles
function calcZ(leader: number[], alt: number[], i: number) {
  if (i < CORR_WINDOW + 1) return 0;
  const sp: number[] = [];
  for (let j = i - CORR_WINDOW; j <= i; j++)
    sp.push(Math.log(alt[j] / alt[j-1]) - Math.log(leader[j] / leader[j-1]));
  const m = sp.reduce((a, b) => a + b, 0) / sp.length;
  const s = Math.sqrt(sp.reduce((a, b) => a + (b-m)**2, 0) / sp.length);
  return s === 0 ? 0 : (sp[sp.length-1] - m) / s;
}

// Pure lag: leaderReturn >= threshold AND xlmReturn < threshold
function purelagSignal(leaderRet: number, xlmRet: number, thresh: number) {
  return leaderRet >= thresh && xlmRet < thresh;
}

function runZlag(
  xlmUS: { high: number; low: number; close: number }[],
  leaderClose: number[],
  xlmUSClose: number[],
) {
  let bal = ALLOCATION, peak = ALLOCATION, maxDD = 0;
  let trades = 0, wins = 0, missed = 0, gW = 0, gL = 0;
  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chasePrice: number };
  let pos: Pos | null = null;
  let pending: number | null = null;

  for (let i = CORR_WINDOW + 1; i < xlmUS.length; i++) {
    const { high, low, close } = xlmUS[i];

    if (pending !== null) {
      if (low <= pending) {
        const entry = pending;
        pos = { entry, tp: entry * (1 + TP_PCT), sl: entry * (1 - SL_PCT), hold: 0, chasing: false, chasePrice: 0 };
      } else { missed++; }
      pending = null;
      continue;
    }

    if (pos) {
      if (pos.chasing) {
        if (low <= pos.chasePrice) {
          const pnl = (pos.chasePrice - pos.entry) * (bal / pos.entry);
          bal += pnl; trades++;
          if (pnl >= 0) { wins++; gW += pnl; } else gL += Math.abs(pnl);
          if (bal > peak) peak = bal;
          if ((bal-peak)/peak*100 < maxDD) maxDD = (bal-peak)/peak*100;
          pos = null;
        } else { pos.chasePrice = close; }
      } else {
        pos.hold++;
        if (low <= pos.sl) {
          const pnl = (pos.sl - pos.entry) * (bal / pos.entry);
          bal += pnl; trades++; gL += Math.abs(pnl);
          if (bal > peak) peak = bal; if ((bal-peak)/peak*100 < maxDD) maxDD = (bal-peak)/peak*100; pos = null;
        } else if (high >= pos.tp) {
          const pnl = (pos.tp - pos.entry) * (bal / pos.entry);
          bal += pnl; trades++; wins++; gW += pnl;
          if (bal > peak) peak = bal; if ((bal-peak)/peak*100 < maxDD) maxDD = (bal-peak)/peak*100; pos = null;
        } else if (pos.hold >= MAX_HOLD) { pos.chasing = true; pos.chasePrice = close; }
      }
      continue;
    }

    const z = calcZ(leaderClose, xlmUSClose, i);
    if (z <= -Z_THRESH) pending = close * (1 + ENTRY_SLIP);
  }

  const pf = gL > 0 ? gW / gL : Infinity;
  const wr = trades > 0 ? wins / trades * 100 : 0;
  const fillRate = (trades + missed) > 0 ? trades / (trades + missed) * 100 : 0;
  return { pnl: bal - ALLOCATION, trades, missed, fillRate, wr, pf, maxDD };
}

function runPurelag(
  xlmUS: { high: number; low: number; close: number }[],
  leaderClose: number[],
  xlmUSClose: number[],
  thresh: number,
) {
  let bal = ALLOCATION, peak = ALLOCATION, maxDD = 0;
  let trades = 0, wins = 0, missed = 0, gW = 0, gL = 0;
  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chasePrice: number };
  let pos: Pos | null = null;
  let pending: number | null = null;

  for (let i = 1; i < xlmUS.length; i++) {
    const { high, low, close } = xlmUS[i];

    if (pending !== null) {
      if (low <= pending) {
        const entry = pending;
        pos = { entry, tp: entry * (1 + TP_PCT), sl: entry * (1 - SL_PCT), hold: 0, chasing: false, chasePrice: 0 };
      } else { missed++; }
      pending = null;
      continue;
    }

    if (pos) {
      if (pos.chasing) {
        if (low <= pos.chasePrice) {
          const pnl = (pos.chasePrice - pos.entry) * (bal / pos.entry);
          bal += pnl; trades++;
          if (pnl >= 0) { wins++; gW += pnl; } else gL += Math.abs(pnl);
          if (bal > peak) peak = bal; if ((bal-peak)/peak*100 < maxDD) maxDD = (bal-peak)/peak*100; pos = null;
        } else { pos.chasePrice = close; }
      } else {
        pos.hold++;
        if (low <= pos.sl) {
          const pnl = (pos.sl - pos.entry) * (bal / pos.entry);
          bal += pnl; trades++; gL += Math.abs(pnl);
          if (bal > peak) peak = bal; if ((bal-peak)/peak*100 < maxDD) maxDD = (bal-peak)/peak*100; pos = null;
        } else if (high >= pos.tp) {
          const pnl = (pos.tp - pos.entry) * (bal / pos.entry);
          bal += pnl; trades++; wins++; gW += pnl;
          if (bal > peak) peak = bal; if ((bal-peak)/peak*100 < maxDD) maxDD = (bal-peak)/peak*100; pos = null;
        } else if (pos.hold >= MAX_HOLD) { pos.chasing = true; pos.chasePrice = close; }
      }
      continue;
    }

    const leaderRet = (leaderClose[i] - leaderClose[i-1]) / leaderClose[i-1];
    const xlmRet    = (xlmUSClose[i]  - xlmUSClose[i-1])  / xlmUSClose[i-1];
    if (purelagSignal(leaderRet, xlmRet, thresh)) pending = close * (1 + ENTRY_SLIP);
  }

  const pf = gL > 0 ? gW / gL : Infinity;
  const wr = trades > 0 ? wins / trades * 100 : 0;
  const fillRate = (trades + missed) > 0 ? trades / (trades + missed) * 100 : 0;
  return { pnl: bal - ALLOCATION, trades, missed, fillRate, wr, pf, maxDD };
}

function printRow(label: string, r: ReturnType<typeof runZlag>) {
  const sign = r.pnl >= 0 ? "+" : "";
  console.log(
    `  ${label.padEnd(34)}` +
    `${r.trades}`.padStart(6) +
    `  ${r.fillRate.toFixed(0)}%`.padStart(5) +
    `  ${r.wr.toFixed(1)}%`.padStart(7) +
    `  ${r.pf === Infinity ? "∞" : r.pf.toFixed(2)}`.padStart(6) +
    `  ${sign}$${r.pnl.toFixed(2)}`.padStart(9) +
    `  ${sign}${(r.pnl/ALLOCATION*100).toFixed(0)}%`.padStart(7) +
    `  ${r.maxDD.toFixed(1)}%`.padStart(7)
  );
}

(async () => {
  process.stdout.write("Fetching XLM 1m Binance.US...  "); const xlmUS = await fetchKlines(BASE_US, "XLMUSDT"); console.log(`${xlmUS.length}`);
  process.stdout.write("Fetching XLM 1m Binance global... "); const xlmGL = await fetchKlines(BASE_GL, "XLMUSDT"); console.log(`${xlmGL.length}`);
  process.stdout.write("Fetching BTC 1m Binance.US...  "); const btcUS = await fetchKlines(BASE_US, "BTCUSDT"); console.log(`${btcUS.length}`);
  process.stdout.write("Fetching XRP 1m Binance.US...  "); const xrpUS = await fetchKlines(BASE_US, "XRPUSDT"); console.log(`${xrpUS.length}`);

  // Align all to XLM.US timestamps
  const xlmMap  = new Map(xlmUS.map(c => [c.time, c]));
  const btcMap  = new Map(btcUS.map(c => [c.time, c.close]));
  const xrpMap  = new Map(xrpUS.map(c => [c.time, c.close]));
  const xlmGLMap = new Map(xlmGL.map(c => [c.time, c.close]));

  const aligned    = xlmUS.filter(c => btcMap.has(c.time) && xrpMap.has(c.time) && xlmGLMap.has(c.time));
  const xlmUSClose = aligned.map(c => c.close);
  const btcClose   = aligned.map(c => btcMap.get(c.time)!);
  const xrpClose   = aligned.map(c => xrpMap.get(c.time)!);
  const xlmGLClose = aligned.map(c => xlmGLMap.get(c.time)!);

  console.log(`\nAligned candles: ${aligned.length}\n`);
  console.log(`XLM signal comparison · Binance.US · 1m · 1 month`);
  console.log(`Entry +0.02% limit (maker, 0 fee) · TP=0.8%  SL=0.15%  $${ALLOCATION}\n`);
  console.log(`  ${"Signal".padEnd(34)} ${"Fills".padStart(6)}  ${"Fill%".padStart(4)}  ${"WR%".padStart(6)}  ${"PF".padStart(5)}  ${"PnL".padStart(8)}  ${"Ret%".padStart(6)}  ${"MaxDD".padStart(6)}`);
  console.log("  " + "─".repeat(90));

  console.log(`\n  ── Z-LAG (current strategy) ─────────────────────────────────────────────────`);
  printRow("BTC/XLM Z-score (current bot)",   runZlag(aligned, btcClose,   xlmUSClose));
  printRow("XRP/XLM Z-score",                 runZlag(aligned, xrpClose,   xlmUSClose));
  printRow("XLM-global/XLM-US Z-score",       runZlag(aligned, xlmGLClose, xlmUSClose));

  console.log(`\n  ── PURE LAG (leader pumps, XLM flat) ────────────────────────────────────────`);
  printRow("BTC ≥0.1% → buy XLM.US",          runPurelag(aligned, btcClose,   xlmUSClose, 0.001));
  printRow("XRP ≥0.1% → buy XLM.US",          runPurelag(aligned, xrpClose,   xlmUSClose, 0.001));
  printRow("XLM global ≥0.1% → buy XLM.US",   runPurelag(aligned, xlmGLClose, xlmUSClose, 0.001));
  printRow("XLM global ≥0.05% → buy XLM.US",  runPurelag(aligned, xlmGLClose, xlmUSClose, 0.0005));
})();
