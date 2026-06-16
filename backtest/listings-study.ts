// Listings study — every Binance.US listing in the last 2 years:
// what happens in the first hour / day / week after a coin starts trading?
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE_US = "https://api.binance.us/api/v3";
const KEY = process.env.BINANCE_API_KEY ?? "";
const DAY_MS = 24 * 60 * 60 * 1000;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function getJson(url: string): Promise<any> {
  for (;;) {
    const res = await fetch(url, { headers: { "X-MBX-APIKEY": KEY } });
    if (res.status === 429) { await sleep(10000); continue; }
    return res.json();
  }
}

(async () => {
  console.log("\nLISTINGS STUDY — Binance.US, all USDT pairs listed in the last 2 years\n");

  const info = await getJson(`${BASE_US}/exchangeInfo`);
  const symbols: string[] = info.symbols
    .filter((s: any) => s.status === "TRADING" && s.quoteAsset === "USDT")
    .map((s: any) => s.symbol);
  console.log(`${symbols.length} USDT pairs trading. Finding listing dates...`);

  type Listing = { symbol: string; listed: number };
  const listings: Listing[] = [];
  const cutoff = Date.now() - 730 * DAY_MS;

  let done = 0;
  for (const sym of symbols) {
    const raw = await getJson(`${BASE_US}/klines?symbol=${sym}&interval=1d&startTime=0&limit=2`);
    if (Array.isArray(raw) && raw.length) {
      const first = Number(raw[0][0]);
      if (first >= cutoff) listings.push({ symbol: sym, listed: first });
    }
    if (++done % 50 === 0) process.stdout.write(`${done}/${symbols.length} `);
    await sleep(60);
  }
  console.log(`\n${listings.length} listings in the last 2 years\n`);
  listings.sort((a, b) => a.listed - b.listed);

  type Row = {
    symbol: string; date: string;
    h1: number; h4: number; h24: number; h72: number; h168: number;
    peak24: number; peakHr: number;
  };
  const rows: Row[] = [];

  for (const l of listings) {
    const raw = await getJson(`${BASE_US}/klines?symbol=${l.symbol}&interval=1h&startTime=${l.listed}&limit=168`);
    await sleep(60);
    if (!Array.isArray(raw) || raw.length < 24) continue;
    const open = parseFloat(raw[0][1]);
    if (open <= 0) continue;
    const closeAt = (h: number) => raw[Math.min(h, raw.length - 1)] ? parseFloat(raw[Math.min(h, raw.length - 1)][4]) : NaN;
    let peak = -Infinity, peakHr = 0;
    for (let h = 0; h < Math.min(24, raw.length); h++) {
      const hi = parseFloat(raw[h][2]);
      if (hi > peak) { peak = hi; peakHr = h; }
    }
    rows.push({
      symbol: l.symbol,
      date: new Date(l.listed).toISOString().slice(0, 10),
      h1: (closeAt(0) - open) / open * 100,        // close of first hour
      h4: (closeAt(3) - open) / open * 100,
      h24: (closeAt(23) - open) / open * 100,
      h72: (closeAt(71) - open) / open * 100,
      h168: (closeAt(167) - open) / open * 100,
      peak24: (peak - open) / open * 100,
      peakHr,
    });
  }

  console.log("  Symbol        Listed       +1h%     +4h%    +24h%    +72h%     +1w%   Peak24%  PeakHr");
  console.log("  " + "─".repeat(92));
  for (const r of rows) {
    const f = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(1);
    console.log(
      `  ${r.symbol}`.padEnd(15) +
      `${r.date}` +
      `${f(r.h1)}`.padStart(8) +
      `${f(r.h4)}`.padStart(9) +
      `${f(r.h24)}`.padStart(9) +
      `${f(r.h72)}`.padStart(9) +
      `${f(r.h168)}`.padStart(9) +
      `${f(r.peak24)}`.padStart(9) +
      `${r.peakHr}h`.padStart(7)
    );
  }

  const avg = (k: keyof Row) => rows.reduce((a, r) => a + (r[k] as number), 0) / rows.length;
  const med = (k: keyof Row) => {
    const v = rows.map(r => r[k] as number).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  const posPct = (k: keyof Row) => rows.filter(r => (r[k] as number) > 0).length / rows.length * 100;

  console.log("\n  ── SUMMARY (" + rows.length + " listings) ──");
  console.log("  Horizon    Avg%     Median%   %Positive");
  console.log("  " + "─".repeat(44));
  for (const k of ["h1", "h4", "h24", "h72", "h168", "peak24"] as (keyof Row)[]) {
    console.log(
      `  ${k}`.padEnd(11) +
      `${avg(k) >= 0 ? "+" : ""}${avg(k).toFixed(1)}%`.padStart(7) +
      `${med(k) >= 0 ? "+" : ""}${med(k).toFixed(1)}%`.padStart(10) +
      `${posPct(k).toFixed(0)}%`.padStart(10)
    );
  }
  const avgPeakHr = rows.reduce((a, r) => a + r.peakHr, 0) / rows.length;
  console.log(`\n  Avg hour of first-24h peak: ${avgPeakHr.toFixed(1)}h after listing`);
  console.log();
})();
