/**
 * Run: npx ts-node --transpile-only backtest/fee-check.ts
 * ATOM only, $50, current params, 6 months
 * Logic copied exactly from zscore-final.ts — only adds fee model on top
 */

const BASE = "https://api.binance.us/api/v3";
const KEY  = process.env.BINANCE_API_KEY ?? "";

const WINDOW = 20; const Z = 2.0; const TP = 0.008; const SL = 0.003;
const HOLD = 6; const ALLOC = 50; const COST = 0.0003; // 0.03% per side
const CHASE_OFFSET = 0.0005; // 0.05% trailing floor

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetch1m(symbol: string, startMs: number) {
  const out: { time: number; close: number }[] = [];
  let from = startMs;
  const end = Date.now();
  while (from < end) {
    const res = await fetch(`${BASE}/klines?symbol=${symbol}&interval=1m&startTime=${from}&endTime=${end}&limit=1000`, { headers: { "X-MBX-APIKEY": KEY } });
    if (res.status === 429) { await sleep(10000); continue; }
    const raw = await res.json() as string[][];
    if (!raw.length) break;
    for (const c of raw) out.push({ time: Number(c[0]), close: parseFloat(c[4]) });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(100);
  }
  return out;
}

// Exact copy from zscore-final.ts
function calcZScore(btc: number[], alt: number[], i: number): number {
  if (i < WINDOW + 1) return 0;
  const spreads: number[] = [];
  for (let j = i - WINDOW; j <= i; j++)
    spreads.push(Math.log(alt[j]/alt[j-1]) - Math.log(btc[j]/btc[j-1]));
  if (spreads.length < WINDOW) return 0;
  const mean = spreads.reduce((a,b) => a+b,0) / spreads.length;
  const std  = Math.sqrt(spreads.reduce((a,b) => a+(b-mean)**2,0) / spreads.length);
  return std === 0 ? 0 : (spreads[spreads.length-1] - mean) / std;
}

function run(btc: number[], alt: number[], withCost: boolean) {
  let pnl=0, wins=0, losses=0, chases=0, gw=0, gl=0;
  let bal=ALLOC, peak=ALLOC, maxDD=0;
  type Pos = { entry: number; sl: number; tp: number; hold: number; chasing: boolean; chaseFloor: number };
  let pos: Pos | null = null;

  const close = (tradePnl: number, isChase: boolean) => {
    pnl += tradePnl; bal += tradePnl;
    if (isChase) chases++;
    if (tradePnl >= 0) { wins++; gw += tradePnl; }
    else               { losses++; gl += Math.abs(tradePnl); }
    if (bal > peak) peak = bal;
    const dd = (bal-peak)/peak*100; if (dd < maxDD) maxDD = dd;
    pos = null;
  };

  for (let i = WINDOW+1; i < btc.length; i++) {
    const price = alt[i];

    if (pos) {
      if (!pos.chasing) {
        pos.hold++;
        const hitTP = price >= pos.tp;
        const hitSL = price <= pos.sl;

        if (hitTP || hitSL) {
          const rawExit  = hitTP ? pos.tp : pos.sl;
          const exitFill = withCost ? rawExit * (1-COST) : rawExit;
          close((exitFill - pos.entry) / pos.entry * ALLOC, false);
        } else if (pos.hold >= HOLD) {
          pos.chasing    = true;
          pos.chaseFloor = price * (1 - CHASE_OFFSET);
        }

      } else {
        const newFloor = price * (1 - CHASE_OFFSET);
        if (newFloor > pos.chaseFloor) pos.chaseFloor = newFloor;
        if (price <= pos.chaseFloor) {
          const exitFill = withCost ? price * (1-COST) : price;
          close((exitFill - pos.entry) / pos.entry * ALLOC, true);
        }
      }
    }

    if (!pos && calcZScore(btc, alt, i) <= -Z) {
      const entryFill = withCost ? price * (1+COST) : price;
      pos = { entry: entryFill, tp: entryFill*(1+TP), sl: entryFill*(1-SL), hold: 0, chasing: false, chaseFloor: 0 };
    }
  }

  const trades = wins + losses;
  const wr     = trades > 0 ? (wins/trades*100).toFixed(1) : "0";
  const pf     = gl > 0 ? (gw/gl).toFixed(2) : "∞";
  return { pnl, trades, wins, losses, chases, wr, pf, maxDD };
}

(async () => {
  const start = Date.now() - 180*24*60*60*1000;
  process.stdout.write("Fetching BTC...  ");
  const btcRaw = await fetch1m("BTCUSDT", start);
  process.stdout.write(`${btcRaw.length} candles\nFetching ATOM... `);
  const altRaw = await fetch1m("ATOMUSDT", start);
  console.log(`${altRaw.length} candles\n`);

  // Align by timestamp — exact same as zscore-final.ts
  const altMap = new Map(altRaw.map(c => [c.time, c.close]));
  const btc: number[] = [], alt: number[] = [];
  for (const c of btcRaw) {
    const a = altMap.get(c.time);
    if (a !== undefined) { btc.push(c.close); alt.push(a); }
  }
  console.log(`Aligned: ${btc.length} candles\n`);

  const maker  = run(btc, alt, false);
  const market = run(btc, alt, true);

  console.log(`ATOM/USDT · $${ALLOC} · TP ${TP*100}% · SL ${SL*100}% · Hold ${HOLD} · 6 months\n`);
  console.log(`  0% maker fees    PnL $${maker.pnl.toFixed(2).padStart(7)}  trades ${maker.trades}  WR ${maker.wr}%  PF ${maker.pf}  MaxDD ${maker.maxDD.toFixed(1)}%`);
  console.log(`  0.03%/side mkt   PnL $${market.pnl.toFixed(2).padStart(7)}  trades ${market.trades}  WR ${market.wr}%  PF ${market.pf}  MaxDD ${market.maxDD.toFixed(1)}%`);
  console.log(`\n  Fee drag: $${(maker.pnl-market.pnl).toFixed(2)}  |  Chase exits: ${market.chases}/${market.trades} (${(market.chases/market.trades*100).toFixed(0)}%)`);
})();
