// Time-based entry on 1m candles | top 3 times from pattern scan
// Buy at open of target candle | TP 0.20% SL 0.10% MAX_HOLD 6m
// Binance global | 1 week | BTC + XRP + SOL
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_GL  = "https://data-api.binance.vision/api/v3";
const LOOKBACK = 90 * 24 * 60 * 60 * 1000;
const TP = 0.002, SL = 0.001, MAX_HOLD = 6;
const ALLOC = 25;

const COINS: [string, string[]][] = [
  ["BTCUSDT", ["13:43"]],
  ["XRPUSDT", ["13:43"]],
  ["SOLUSDT", ["13:43"]],
];

type C = { t: number; o: number; h: number; l: number; c: number };

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol: string): Promise<C[]> {
  const out: C[] = [];
  let from = Date.now() - LOOKBACK;
  while (from < Date.now()) {
    const res = await fetch(`${BASE_GL}/klines?symbol=${symbol}&interval=1m&startTime=${from}&limit=1000`);
    if (res.status === 429) { await sleep(5000); continue; }
    const raw = await res.json() as any[];
    if (!Array.isArray(raw) || !raw.length) break;
    for (const c of raw) out.push({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4] });
    from = +raw[raw.length - 1][0] + 1;
    await sleep(80);
  }
  return out;
}

function sim(candles: C[], timeUTC: string) {
  const [th, tm] = timeUTC.split(":").map(Number);
  let wins = 0, losses = 0, expires = 0, pnl = 0, trades = 0;
  for (let i = 0; i < candles.length - MAX_HOLD - 1; i++) {
    const d = new Date(candles[i].t);
    if (d.getUTCHours() !== th || d.getUTCMinutes() !== tm) continue;
    const entry = candles[i].o;
    const tp = entry * (1 + TP), sl = entry * (1 - SL);
    let result = "EXPIRE", exitPx = candles[i + MAX_HOLD].c;
    for (let j = i + 1; j <= i + MAX_HOLD; j++) {
      if (candles[j].l <= sl) { result = "SL"; exitPx = sl; break; }
      if (candles[j].h >= tp) { result = "TP"; exitPx = tp; break; }
    }
    const tradePnl = (exitPx - entry) / entry * ALLOC;
    if (result === "TP") wins++;
    else if (result === "SL") losses++;
    else expires++;
    pnl += tradePnl;
    trades++;
  }
  const totalInvested = trades * ALLOC;
  const retPct = totalInvested > 0 ? pnl / totalInvested * 100 : 0;
  return { wins, losses, expires, pnl, trades, retPct };
}

(async () => {
  console.log(`\nTIME ENTRY 1m | 3 months | Binance Global | TP ${TP*100}% SL ${SL*100}% MAX_HOLD ${MAX_HOLD}m | $${ALLOC}/trade\n`);
  console.log(`${"Coin".padEnd(10)} ${"Time UTC".padEnd(10)} ${"ET".padEnd(9)} ${"W".padStart(4)} ${"L".padStart(4)} ${"EXP".padStart(5)} ${"WR%".padStart(6)} ${"Trades".padStart(7)} ${"Ret% of invested".padStart(18)}`);
  console.log("─".repeat(75));

  const coinTotals: { coin: string; wins: number; losses: number; expires: number; pnl: number; trades: number }[] = [];

  for (const [coin, times] of COINS) {
    const candles = await fetchKlines(coin);
    let coinWins = 0, coinLosses = 0, coinExpires = 0, coinPnl = 0, coinTrades = 0;
    for (const time of times) {
      const r = sim(candles, time);
      const [h, m] = time.split(":").map(Number);
      const et = `${String((h - 4 + 24) % 24).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
      const n = r.wins + r.losses + r.expires;
      coinWins += r.wins; coinLosses += r.losses; coinExpires += r.expires; coinPnl += r.pnl; coinTrades += r.trades;
      console.log(
        coin.padEnd(10) + time.padEnd(10) + (et + " ET").padEnd(9) +
        String(r.wins).padStart(4) + String(r.losses).padStart(5) + String(r.expires).padStart(6) +
        (n ? (r.wins / n * 100).toFixed(0).padStart(5) + "%" : "     -") +
        String(r.trades).padStart(7) +
        (r.retPct >= 0 ? "+" : "") + `${r.retPct.toFixed(2)}%`.padStart(17)
      );
    }
    coinTotals.push({ coin, wins: coinWins, losses: coinLosses, expires: coinExpires, pnl: coinPnl, trades: coinTrades });
    console.log();
    await sleep(150);
  }

  console.log("── TOTAL PER COIN ──");
  console.log(`${"Coin".padEnd(10)} ${"W".padStart(4)} ${"L".padStart(4)} ${"EXP".padStart(5)} ${"WR%".padStart(6)} ${"Trades".padStart(7)} ${"Ret% of invested".padStart(18)}`);
  console.log("─".repeat(57));
  for (const t of coinTotals.sort((a, b) => b.pnl - a.pnl)) {
    const n = t.wins + t.losses + t.expires;
    const retPct = t.trades > 0 ? t.pnl / (t.trades * ALLOC) * 100 : 0;
    console.log(
      t.coin.padEnd(10) +
      String(t.wins).padStart(4) + String(t.losses).padStart(5) + String(t.expires).padStart(6) +
      (t.wins / n * 100).toFixed(0).padStart(5) + "%" +
      String(t.trades).padStart(7) +
      (retPct >= 0 ? "+" : "") + `${retPct.toFixed(2)}%`.padStart(17)
    );
  }
  console.log();
})();
