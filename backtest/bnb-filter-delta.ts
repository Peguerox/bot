import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE        = "https://api.binance.us/api/v3";
const KEY         = process.env.BINANCE_API_KEY ?? "";
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

const BTC_THRESH = 0.001;
const TP_PCT     = 0.008;
const SL_PCT     = 0.0015;
const MAX_HOLD   = 6;
const ALLOC      = 25;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string, startMs: number) {
  const candles: { time: number; high: number; low: number; close: number }[] = [];
  let from = startMs;
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
      time:  Number(c[0]),
      high:  parseFloat(c[2]),
      low:   parseFloat(c[3]),
      close: parseFloat(c[4]),
    });
    from = Number(raw[raw.length - 1][0]) + 1;
    await sleep(150);
  }
  return candles;
}

(async () => {
  const start = Date.now() - LOOKBACK_MS;

  process.stdout.write("Fetching BTC... ");
  const btcRaw = await fetchKlines("BTCUSDT", start);
  console.log(`${btcRaw.length} candles`);

  process.stdout.write("Fetching BNB... ");
  const bnbRaw = await fetchKlines("BNBUSDT", start);
  console.log(`${bnbRaw.length} candles\n`);

  const btcMap  = new Map(btcRaw.map(c => [c.time, c]));
  const aligned = bnbRaw.filter(c => btcMap.has(c.time));
  const btcAl   = aligned.map(c => btcMap.get(c.time)!);

  // Separate signal buckets
  // Bucket A: BNB < 0.05%
  // Bucket B: 0.05% ≤ BNB < 0.1%  (the marginal trades)

  type TradeResult = { pnl: number; win: boolean };
  const bucketA: TradeResult[] = [];
  const bucketB: TradeResult[] = [];

  // Run simulation tracking which bucket each trade came from
  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chasePrice: number; bucket: "A" | "B" };
  let pos: Pos | null = null;
  let bal = ALLOC;

  for (let i = 1; i < aligned.length; i++) {
    const { high, low, close } = aligned[i];

    if (pos) {
      let exitPrice: number | null = null;

      if (pos.chasing) {
        if (low <= pos.chasePrice) exitPrice = pos.chasePrice;
        else pos.chasePrice = close;
      } else {
        pos.hold++;
        if (low <= pos.sl)       exitPrice = pos.sl;
        else if (high >= pos.tp) exitPrice = pos.tp;
        else if (pos.hold >= MAX_HOLD) { pos.chasing = true; pos.chasePrice = close; }
      }

      if (exitPrice !== null) {
        const qty = bal / pos.entry;
        const pnl = (exitPrice - pos.entry) * qty;
        bal += pnl;
        const result = { pnl, win: pnl >= 0 };
        if (pos.bucket === "A") bucketA.push(result);
        else bucketB.push(result);
        pos = null;
      }
      continue;
    }

    const btcRet  = (btcAl[i].close - btcAl[i - 1].close) / btcAl[i - 1].close;
    const coinRet = (close - aligned[i - 1].close) / aligned[i - 1].close;

    if (btcRet >= BTC_THRESH && coinRet < 0.001) {
      const bucket = coinRet < 0.0005 ? "A" : "B";
      pos = { entry: close, tp: close * (1 + TP_PCT), sl: close * (1 - SL_PCT), hold: 0, chasing: false, chasePrice: 0, bucket };
    }
  }

  function stats(label: string, trades: TradeResult[]) {
    if (!trades.length) { console.log(`${label}: no trades`); return; }
    const wins     = trades.filter(t => t.win).length;
    const grossWin = trades.filter(t => t.win).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = trades.filter(t => !t.win).reduce((s, t) => s + Math.abs(t.pnl), 0);
    const wr = (wins / trades.length * 100).toFixed(1);
    const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgPnl = totalPnl / trades.length;
    console.log(`${label}`);
    console.log(`  Trades: ${trades.length}  |  WR: ${wr}%  |  PF: ${pf}`);
    console.log(`  Total PnL: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(4)}  |  Avg per trade: ${avgPnl >= 0 ? "+" : ""}$${avgPnl.toFixed(4)}`);
  }

  console.log(`BTC≥0.1% · 1 month · Binance.US — isolating marginal trades\n`);
  stats(`Bucket A  BNB < 0.05%            (tight filter)`, bucketA);
  console.log();
  stats(`Bucket B  0.05% ≤ BNB < 0.10%   (marginal trades)`, bucketB);
  console.log(`\nConclusion: ${
    bucketB.length === 0 ? "no marginal trades" :
    (bucketB.filter(t => t.win).length / bucketB.length) > 0.5
      ? "marginal trades ARE profitable — keep BNB<0.1%"
      : "marginal trades are NOT profitable — tighten to BNB<0.05%"
  }`);
})();
