// One-off manual utility — reports open BTCUSDT orders and BTC/USDT free balance on Binance.US.
// Runs through Trigger.dev's infrastructure since Binance.US only accepts calls from whitelisted IPs.
import { task } from "@trigger.dev/sdk/v3";
import { getFreeBalance } from "../lib/binance";

async function getOpenOrders(symbol: string) {
  const crypto = await import("crypto");
  const BASE = "https://api.binance.us/api/v3";
  const API_KEY = process.env.BINANCE_API_KEY_EU ?? process.env.BINANCE_API_KEY!;
  const API_SECRET = process.env.BINANCE_API_SECRET_EU ?? process.env.BINANCE_API_SECRET!;
  const qs = new URLSearchParams({ symbol, timestamp: String(Date.now()) });
  const sig = crypto.createHmac("sha256", API_SECRET).update(qs.toString()).digest("hex");
  qs.append("signature", sig);
  const res = await fetch(`${BASE}/openOrders?${qs}`, { headers: { "X-MBX-APIKEY": API_KEY } });
  return res.json();
}

export const adminCheckBtcOcoOrders = task({
  id: "admin-check-btc-oco-orders",
  run: async () => {
    const openOrders = await getOpenOrders("BTCUSDT");
    const usdtFree = await getFreeBalance("USDT");
    const btcFree = await getFreeBalance("BTC");
    return { ok: true, openOrders, usdtFree, btcFree };
  },
});
