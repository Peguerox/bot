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

  // Track every trade with its exact BNB return at signal time
  type Trade = { bnbRetAtSignal: number; pnl: number; win: boolean };
  const allTrades: Trade[] = [];

  type Pos = { entry: number; tp: number; sl: number; hold: number; chasing: boolean; chasePrice: number; bnbRet: number };
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
        const pnl = (exitPrice - pos.entry) * (bal / pos.entry);
        bal += pnl;
        allTrades.push({ bnbRetAtSignal: pos.bnbRet, pnl, win: pnl >= 0 });
        pos = null;
      }
      continue;
    }

    const btcRet  = (btcAl[i].close - btcAl[i - 1].close) / btcAl[i - 1].close;
    const coinRet = (close - aligned[i - 1].close) / aligned[i - 1].close;
    if (btcRet >= BTC_THRESH && coinRet < 0.001) {
      pos = { entry: close, tp: close * (1 + TP_PCT), sl: close * (1 - SL_PCT), hold: 0, chasing: false, chasePrice: 0, bnbRet: coinRet };
    }
  }

  // Bucket by BNB move at signal
  const buckets = [
    { label: "BNB < 0.00%  (flat/down)", min: -Infinity, max: 0 },
    { label: "BNB 0–0.02%  (barely moved)", min: 0, max: 0.0002 },
    { label: "BNB 0.02–0.05%", min: 0.0002, max: 0.0005 },
    { label: "BNB 0.05–0.10%  (almost caught up)", min: 0.0005, max: 0.001 },
  ];

  console.log(`BTC≥0.1% · BNB<0.1% — breakdown by how much BNB already moved\n`);
  console.log(`${"BNB at signal".padEnd(36)} ${"Trades".padStart(6)}  ${"WR%".padStart(6)}  ${"PF".padStart(5)}  ${"Avg PnL".padStart(9)}`);
  console.log("─".repeat(68));

  for (const b of buckets) {
    const trades = allTrades.filter(t => t.bnbRetAtSignal >= b.min && t.bnbRetAtSignal < b.max);
    if (!trades.length) { console.log(`${b.label.padEnd(36)}    no trades`); continue; }
    const wins     = trades.filter(t => t.win).length;
    const grossWin = trades.filter(t => t.win).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = trades.filter(t => !t.win).reduce((s, t) => s + Math.abs(t.pnl), 0);
    const wr  = (wins / trades.length * 100).toFixed(1);
    const pf  = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
    const avg = (trades.reduce((s, t) => s + t.pnl, 0) / trades.length);
    console.log(
      `${b.label.padEnd(36)}` +
      ` ${String(trades.length).padStart(6)}` +
      `  ${(wr+"%").padStart(6)}` +
      `  ${String(pf).padStart(5)}` +
      `  ${(avg >= 0 ? "+" : "")+"$"+avg.toFixed(4).padStart(8)}`
    );
  }
})();
