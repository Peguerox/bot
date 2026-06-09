import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { getKlines } from "../lib/binance";
import { calcZScore } from "../lib/strategy";

const CANDLES = 50;
const SYMBOL  = "XLMUSDT";
const Z_THRESH = 1.5;

(async () => {
  const [btc, xlm] = await Promise.all([
    getKlines("BTCUSDT", "1m", CANDLES).then(c => c.slice(0, -1)),
    getKlines(SYMBOL,    "1m", CANDLES).then(c => c.slice(0, -1)),
  ]);

  const z     = calcZScore(btc, xlm);
  const price = xlm[xlm.length - 1].close;

  console.log(`Candles loaded: BTC=${btc.length}  XLM=${xlm.length}`);
  console.log(`Z-score now:    ${z.toFixed(4)}`);
  console.log(`Price:          ${price}`);
  console.log(`Signal fires at Z <= -${Z_THRESH}`);
  console.log(`Signal NOW?     ${z <= -Z_THRESH ? "YES 🔥" : "no"}`);

  // Show recent spreads
  const spreads: number[] = [];
  for (let i = 1; i < btc.length; i++) {
    const bRet = Math.log(btc[i].close / btc[i-1].close);
    const aRet = Math.log(xlm[i].close / xlm[i-1].close);
    spreads.push(aRet - bRet);
  }
  const win = spreads.slice(-20);
  const mean = win.reduce((a, b) => a + b, 0) / win.length;
  const std  = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / win.length);
  console.log(`\n20-candle window mean: ${(mean * 10000).toFixed(2)} bps`);
  console.log(`20-candle window std:  ${(std  * 10000).toFixed(2)} bps`);
  console.log(`Last spread:           ${(spreads[spreads.length-1] * 10000).toFixed(2)} bps`);
  console.log(`\nLast 10 spreads (bps):`);
  spreads.slice(-10).forEach((s, i) => {
    const zi = std === 0 ? 0 : (s - mean) / std;
    console.log(`  ${i+1}: ${(s*10000).toFixed(2).padStart(8)} bps   Z=${zi.toFixed(2).padStart(6)}  ${zi <= -Z_THRESH ? "<-- SIGNAL" : ""}`);
  });
})();
