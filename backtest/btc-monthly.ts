import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "https://api.binance.us/api/v3";
const KEY  = process.env.BINANCE_API_KEY!;

const months = [
  ["2025-12", "2025-12-01", "2025-12-31"],
  ["2026-01", "2026-01-01", "2026-01-31"],
  ["2026-02", "2026-02-01", "2026-02-28"],
  ["2026-03", "2026-03-01", "2026-03-31"],
  ["2026-04", "2026-04-01", "2026-04-30"],
  ["2026-05", "2026-05-01", "2026-05-31"],
  ["2026-06", "2026-06-01", "2026-06-07"],
];

(async () => {
  console.log("\nBTC monthly price action:\n");
  for (const [label, from, to] of months) {
    const start = new Date(from).getTime();
    const end   = new Date(to).getTime() + 86400000;
    const res   = await fetch(`${BASE}/klines?symbol=BTCUSDT&interval=1d&startTime=${start}&endTime=${end}&limit=50`, { headers: { "X-MBX-APIKEY": KEY } });
    const raw   = await res.json() as string[][];
    if (!raw.length) continue;
    const open  = parseFloat(raw[0][1]);
    const close = parseFloat(raw[raw.length - 1][4]);
    const high  = Math.max(...raw.map(c => parseFloat(c[2])));
    const low   = Math.min(...raw.map(c => parseFloat(c[3])));
    const pct   = ((close - open) / open * 100).toFixed(1);
    const flag  = parseFloat(pct) < 0 ? " ← DOWN" : "";
    console.log(`  ${label}  open=$${open.toFixed(0).padStart(7)}  close=$${close.toFixed(0).padStart(7)}  high=$${high.toFixed(0).padStart(7)}  low=$${low.toFixed(0).padStart(7)}  (${parseFloat(pct) >= 0 ? "+" : ""}${pct}%)${flag}`);
  }
})();
