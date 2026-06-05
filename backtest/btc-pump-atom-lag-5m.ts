/**
 * Simple BTC pump / ATOM lag strategy — 5-minute candles, 1 month
 *
 * Signal: BTC 5m return > BTC_THRESH  AND  ATOM 5m return < ATOM_THRESH
 * → Buy ATOM, exit via TP / SL / expire
 *
 * Run: npx ts-node --transpile-only backtest/btc-pump-atom-lag-5m.ts
 */

const BASE       = "https://api.binance.us/api/v3";
const API_KEY    = process.env.BINANCE_API_KEY ?? "";
const ALLOCATION = 200;
const LOOKBACK   = 365 * 24 * 60 * 60 * 1000; // 1 year

// Parameter grid
const BTC_THRESHOLDS  = [0.002];
const ALT_THRESHOLDS  = [0.0005];
const TP_LIST         = [0.008, 0.010];
const SL              = 0.003;
const HOLD_LIST       = [6];                             // 90min (best from previous run)

const PAIRS = [
  { symbol: "ATOMUSDT", name: "ATOM" },
  { symbol: "BNBUSDT",  name: "BNB"  },
  { symbol: "SOLUSDT",  name: "SOL"  },
  { symbol: "ETHUSDT",  name: "ETH"  },
  { symbol: "XRPUSDT",  name: "XRP"  },
];

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string, interval: string, startMs: number, endMs: number) {
  const candles: { time: number; open: number; close: number }[] = [];
  let from = startMs;
  while (from < endMs) {
    const url = `${BASE}/klines?symbol=${symbol}&interval=${interval}` +
                `&startTime=${from}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url, { headers: { "X-MBX-APIKEY": API_KEY } });
    if (res.status === 429) { await sleep(10_000); continue; }
    if (!res.ok) throw new Error(`${res.status} ${symbol}`);
    const raw = await res.json() as string[][];
    if (!raw.length) break;
    for (const c of raw) candles.push({
      time:  Number(c[0]),
      open:  parseFloat(c[1]),
      close: parseFloat(c[4]),
    });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(100);
  }
  return candles;
}

function ret(a: number, b: number) { return (b - a) / a; }

const CHASE_OFFSET = 0.0005; // 0.05% below price — same as live bot

function runBacktest(
  btc: { close: number }[],
  atom: { close: number }[],
  btcThresh: number,
  atomThresh: number,
  tpPct: number,
  maxHold: number,
) {
  let pnl = 0, wins = 0, losses = 0;
  let pos: { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chasePrice: number } | null = null;

  for (let i = 1; i < btc.length; i++) {
    const atomPrice = atom[i].close;

    // Manage open position
    if (pos) {

      // Chasing mode — trail limit sell, respect SL floor
      if (pos.chasing) {
        if (atomPrice <= pos.sl) {
          // Price dropped below SL during chase — exit at SL
          const tradePnl = (pos.sl - pos.entry) / pos.entry * ALLOCATION;
          pnl += tradePnl;
          wins += tradePnl > 0 ? 1 : 0;
          losses += tradePnl <= 0 ? 1 : 0;
          pos = null;
        } else {
          // Re-place limit sell 0.05% below current price — fills this candle
          const chaseExit = atomPrice * (1 - CHASE_OFFSET);
          const tradePnl  = (chaseExit - pos.entry) / pos.entry * ALLOCATION;
          pnl += tradePnl;
          wins += tradePnl > 0 ? 1 : 0;
          losses += tradePnl <= 0 ? 1 : 0;
          pos = null;
        }

      // Normal hold mode
      } else {
        pos.hold++;
        const hitTP   = atomPrice >= pos.tp;
        const hitSL   = atomPrice <= pos.sl;
        const expired = pos.hold >= maxHold;

        if (hitTP) {
          const tradePnl = (pos.tp - pos.entry) / pos.entry * ALLOCATION;
          pnl += tradePnl;
          wins++;
          pos = null;
        } else if (hitSL) {
          const tradePnl = (pos.sl - pos.entry) / pos.entry * ALLOCATION;
          pnl += tradePnl;
          losses++;
          pos = null;
        } else if (expired) {
          // Start chasing — exit next candle at chase price
          pos.chasing    = true;
          pos.chasePrice = atomPrice * (1 - CHASE_OFFSET);
        }
      }
    }

    // Check for signal
    if (!pos) {
      const btcReturn  = ret(btc[i-1].close,  btc[i].close);
      const atomReturn = ret(atom[i-1].close, atom[i].close);

      if (btcReturn > btcThresh && atomReturn < atomThresh) {
        const entry = atomPrice;
        pos = { entry, tp: entry * (1 + tpPct), sl: entry * (1 - SL), hold: 0, chasing: false, chasePrice: 0 };
      }
    }
  }

  const total = wins + losses;
  const wr    = total > 0 ? (wins / total * 100).toFixed(1) : "0.0";
  return { pnl, total, wins, losses, wr };
}

async function main() {
  const now     = Date.now();
  const startMs = now - LOOKBACK;

  console.log(`\nFetching 15m candles (last 1 year)...`);
  const btcRaw = await fetchKlines("BTCUSDT", "15m", startMs, now);
  console.log(`  BTC: ${btcRaw.length} candles`);

  const pairData: { name: string; btc: { close: number }[]; alt: { close: number }[] }[] = [];
  for (const pair of PAIRS) {
    const altRaw = await fetchKlines(pair.symbol, "15m", startMs, now);
    const altMap = new Map(altRaw.map(c => [c.time, c]));
    const btc: { close: number }[] = [], alt: { close: number }[] = [];
    for (const c of btcRaw) {
      const a = altMap.get(c.time);
      if (a) { btc.push(c); alt.push(a); }
    }
    console.log(`  ${pair.name}: ${alt.length} candles`);
    pairData.push({ name: pair.name, btc, alt });
  }

  console.log();
  console.log(`${"═".repeat(72)}`);
  console.log(`  BTC pump / ALT lag — 15m — $${ALLOCATION} — 1 year`);
  console.log(`${"═".repeat(72)}`);
  console.log(`  ${"Coin".padEnd(6)} ${"BTC>".padEnd(6)} ${"ALT<".padEnd(6)} ${"TP".padEnd(5)} ${"Trades".padEnd(8)} ${"WR%".padEnd(7)} ${"PnL".padEnd(10)} Balance`);
  console.log(`  ${"─".repeat(66)}`);

  type Summary = { name: string; btcT: number; altT: number; tp: number; total: number; wins: number; losses: number; wr: string; pnl: number };
  const summaries: Summary[] = [];

  for (const { name, btc, alt } of pairData) {
    let best = { btcT: 0, altT: 0, tp: 0, total: 0, wins: 0, losses: 0, wr: "0", pnl: -Infinity };
    for (const btcT of BTC_THRESHOLDS)
      for (const altT of ALT_THRESHOLDS)
        for (const tp of TP_LIST)
          for (const hold of HOLD_LIST) {
            const r = runBacktest(btc, alt, btcT, altT, tp, hold);
            if (r.pnl > best.pnl) best = { btcT, altT, tp, total: r.total, wins: r.wins, losses: r.losses, wr: r.wr, pnl: r.pnl };
          }

    summaries.push({ name, ...best });
    const sign = best.pnl >= 0 ? "+" : "";
    console.log(
      `  ${name.padEnd(6)} ` +
      `${(best.btcT*100).toFixed(1).padEnd(6)}% ` +
      `${(best.altT*100).toFixed(1).padEnd(6)}% ` +
      `${(best.tp*100).toFixed(1).padEnd(5)}% ` +
      `${String(best.total).padEnd(8)} ` +
      `${best.wr.padEnd(7)} ` +
      `${(sign + "$" + best.pnl.toFixed(2)).padEnd(10)} ` +
      `$${(ALLOCATION + best.pnl).toFixed(2)}`
    );
  }

  summaries.sort((a, b) => b.pnl - a.pnl);
  const winner = summaries[0];
  console.log(`\n  ★  Best: ${winner.name}  BTC>${(winner.btcT*100).toFixed(1)}%  ALT<${(winner.altT*100).toFixed(1)}%  TP=${winner.tp*100}%  SL=${SL*100}%`);
  console.log(`     WR: ${winner.wr}%  PnL: +$${winner.pnl.toFixed(2)}  Balance: $${(ALLOCATION + winner.pnl).toFixed(2)}`);
  console.log(`${"═".repeat(72)}\n`);
}

main().catch(console.error);
