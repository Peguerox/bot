/**
 * BTC pump / ATOM lag — 1-minute candles, 1 month
 * Run: npx ts-node --transpile-only backtest/btc-pump-atom-lag-1m.ts
 */

const BASE       = "https://api.binance.us/api/v3";
const API_KEY    = process.env.BINANCE_API_KEY ?? "";
const ALLOCATION = 200;
const LOOKBACK   = 30 * 24 * 60 * 60 * 1000;

const BTC_THRESHOLDS  = [0.003, 0.005, 0.007];
const ATOM_THRESHOLDS = [0.001, 0.002, 0.003];
const TP_LIST         = [0.006, 0.008, 0.010];
const SL              = 0.003;
const HOLD_LIST       = [3, 6];

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string, startMs: number, endMs: number) {
  const candles: { close: number }[] = [];
  let from = startMs;
  while (from < endMs) {
    const url = `${BASE}/klines?symbol=${symbol}&interval=1m&startTime=${from}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url, { headers: { "X-MBX-APIKEY": API_KEY } });
    if (res.status === 429) { await sleep(10_000); continue; }
    const raw = await res.json() as string[][];
    if (!raw.length) break;
    for (const c of raw) candles.push({ close: parseFloat(c[4]) });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(100);
  }
  return candles;
}

function runBacktest(
  btc: { close: number }[], atom: { close: number }[],
  btcT: number, atomT: number, tp: number, hold: number
) {
  let pnl = 0, wins = 0, losses = 0, expires = 0;
  let pos: { entry: number; tp: number; sl: number; hold: number } | null = null;

  for (let i = 1; i < btc.length; i++) {
    const atomPrice = atom[i].close;
    if (pos) {
      pos.hold++;
      const hitTP = atomPrice >= pos.tp, hitSL = atomPrice <= pos.sl, expired = pos.hold >= hold;
      if (hitTP || hitSL || expired) {
        const exit = hitTP ? pos.tp : hitSL ? pos.sl : atomPrice;
        pnl += (exit - pos.entry) / pos.entry * ALLOCATION;
        if (hitTP) wins++; else if (hitSL) losses++; else expires++;
        pos = null;
      }
    }
    if (!pos) {
      const btcRet  = (btc[i].close  - btc[i-1].close)  / btc[i-1].close;
      const atomRet = (atom[i].close - atom[i-1].close) / atom[i-1].close;
      if (btcRet > btcT && atomRet < atomT) {
        pos = { entry: atomPrice, tp: atomPrice*(1+tp), sl: atomPrice*(1-SL), hold: 0 };
      }
    }
  }

  const total = wins + losses + expires;
  return { pnl, total, wins, losses, expires, wr: total > 0 ? (wins/total*100).toFixed(1) : "0.0" };
}

async function main() {
  const now = Date.now(), startMs = now - LOOKBACK;
  process.stdout.write("Fetching 1m candles...\n");

  const [btcRaw, atomRaw] = await Promise.all([
    fetchKlines("BTCUSDT",  startMs, now),
    fetchKlines("ATOMUSDT", startMs, now),
  ]);

  const len  = Math.min(btcRaw.length, atomRaw.length);
  const btc  = btcRaw.slice(0, len);
  const atom = atomRaw.slice(0, len);
  process.stdout.write(`  BTC: ${btc.length}  ATOM: ${atom.length} candles\n\n`);

  type Row = { btcT: number; atomT: number; tp: number; hold: number; pnl: number; total: number; wr: string };
  const rows: Row[] = [];

  for (const btcT of BTC_THRESHOLDS)
    for (const atomT of ATOM_THRESHOLDS)
      for (const tp of TP_LIST)
        for (const hold of HOLD_LIST)
          rows.push({ btcT, atomT, tp, hold, ...runBacktest(btc, atom, btcT, atomT, tp, hold) });

  rows.sort((a, b) => b.pnl - a.pnl);

  console.log("═".repeat(80));
  console.log("  BTC pump / ATOM lag — 1m candles — $200 — 1 month");
  console.log("═".repeat(80));
  console.log(`  ${"BTC>".padEnd(7)} ${"ATOM<".padEnd(7)} ${"TP".padEnd(6)} ${"Hold".padEnd(6)} ${"Trades".padEnd(8)} ${"WR%".padEnd(7)} ${"PnL".padEnd(10)} Balance`);
  console.log("  " + "─".repeat(72));

  for (const r of rows.slice(0, 15)) {
    const sign = r.pnl >= 0 ? "+" : "";
    console.log(
      `  ${(r.btcT*100).toFixed(1).padEnd(7)}% ${(r.atomT*100).toFixed(1).padEnd(7)}% ` +
      `${(r.tp*100).toFixed(1).padEnd(6)}% ${(r.hold + "m").padEnd(6)} ` +
      `${String(r.total).padEnd(8)} ${r.wr.padEnd(7)} ` +
      `${(sign + "$" + r.pnl.toFixed(2)).padEnd(10)} $${(ALLOCATION + r.pnl).toFixed(2)}`
    );
  }

  const best = rows[0];
  console.log(`\n  Best: BTC>${(best.btcT*100).toFixed(1)}%  ATOM<${(best.atomT*100).toFixed(1)}%  TP=${best.tp*100}%  SL=${SL*100}%  Hold=${best.hold}min`);
  console.log(`  Trades: ${best.total}  WR: ${best.wr}%  PnL: $${best.pnl>=0?"+":""}${best.pnl.toFixed(2)}  Balance: $${(ALLOCATION+best.pnl).toFixed(2)}`);
  console.log("═".repeat(80));
}

main().catch(console.error);
