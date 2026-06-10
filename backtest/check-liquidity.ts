import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US = "https://api.binance.us/api/v3";
const KEY     = process.env.BINANCE_API_KEY ?? "";

const pairs = [
  "XLMUSDT", "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT",
  "ADAUSDT", "DOGEUSDT", "XRPUSDT", "LTCUSDT", "LINKUSDT",
  "ATOMUSDT", "AVAXUSDT", "MATICUSDT", "DOTUSDT",
];

(async () => {
  const res = await fetch(`${BASE_US}/ticker/24hr`, { headers: { "X-MBX-APIKEY": KEY } });
  const all = await res.json() as any[];

  const results = pairs.map(p => {
    const t = all.find((x: any) => x.symbol === p);
    if (!t) return { symbol: p, vol: 0, volUsd: 0, trades: 0, spread: 0 };
    const vol    = parseFloat(t.volume);
    const price  = parseFloat(t.lastPrice);
    const bid    = parseFloat(t.bidPrice);
    const ask    = parseFloat(t.askPrice);
    const spread = ask > 0 ? (ask - bid) / ask * 100 : 0;
    return { symbol: p, vol, volUsd: vol * price, trades: parseInt(t.count), spread };
  }).sort((a, b) => b.volUsd - a.volUsd);

  console.log("\nBinance.US 24h liquidity\n");
  console.log("  Symbol      Vol (USD)      Trades    Bid-Ask spread");
  console.log("  " + "─".repeat(55));
  for (const r of results) {
    const usd = r.volUsd >= 1e6
      ? `$${(r.volUsd/1e6).toFixed(1)}M`
      : `$${(r.volUsd/1e3).toFixed(0)}K`;
    console.log(
      `  ${r.symbol.padEnd(12)}${usd.padStart(10)}   ${String(r.trades).padStart(8)}    ${r.spread.toFixed(4)}%`
    );
  }
})();
