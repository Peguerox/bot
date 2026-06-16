// Read-only: actual account trading fee + order filters for USDTUSD on Binance.US
import dotenv from "dotenv";
import crypto from "crypto";
dotenv.config({ path: ".env.local" });

const KEY = process.env.BINANCE_API_KEY_EU ?? process.env.BINANCE_API_KEY ?? "";
const SECRET = process.env.BINANCE_API_SECRET_EU ?? process.env.BINANCE_API_SECRET ?? "";

(async () => {
  // 1) Account trading fee (signed, read-only)
  const qs = new URLSearchParams({ symbol: "USDTUSD", timestamp: String(Date.now()) });
  qs.append("signature", crypto.createHmac("sha256", SECRET).update(qs.toString()).digest("hex"));
  const feeRes = await fetch(`https://api.binance.us/sapi/v1/asset/query/trading-fee?${qs}`, {
    headers: { "X-MBX-APIKEY": KEY },
  });
  console.log("\n── ACCOUNT FEE for USDTUSD ──");
  if (feeRes.ok) {
    console.log(JSON.stringify(await feeRes.json(), null, 2));
  } else {
    console.log(`HTTP ${feeRes.status}: ${await feeRes.text()}`);
  }

  // 2) Pair filters
  const infoRes = await fetch("https://api.binance.us/api/v3/exchangeInfo?symbol=USDTUSD");
  const info = await infoRes.json() as any;
  const s = info.symbols?.[0];
  console.log("\n── PAIR RULES ──");
  if (s) {
    console.log(`status: ${s.status}`);
    for (const f of s.filters) {
      if (f.filterType === "PRICE_FILTER") console.log(`tick size: ${f.tickSize}`);
      if (f.filterType === "LOT_SIZE") console.log(`min qty: ${f.minQty}, step: ${f.stepSize}`);
      if (f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL") console.log(`min notional: ${f.minNotional}`);
    }
  } else console.log(JSON.stringify(info).slice(0, 300));

  // 3) Current book
  const bookRes = await fetch("https://api.binance.us/api/v3/ticker/bookTicker?symbol=USDTUSD");
  const b = await bookRes.json() as any;
  console.log("\n── BOOK RIGHT NOW ──");
  console.log(`bid ${b.bidPrice} (${b.bidQty})  |  ask ${b.askPrice} (${b.askQty})`);
  console.log();
})();
