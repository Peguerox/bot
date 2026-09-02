import { NextRequest, NextResponse } from "next/server";

// Buy-and-hold comparison for the summary table: given a venue + symbol + a start timestamp,
// returns the underlying asset's price at that time and now, so the dashboard can show what
// simply holding the asset would have returned over the exact same window a bot has been running.
type Venue = "global" | "us" | "bitfinex";

async function fetchPriceAt(venue: Venue, symbol: string, atMs: number): Promise<{ price: number | null; debug: string }> {
  if (venue === "bitfinex") {
    const res = await fetch(`https://api-pub.bitfinex.com/v2/candles/trade:1m:${symbol}/hist?start=${atMs}&limit=1&sort=1`, { cache: "no-store" });
    if (!res.ok) return { price: null, debug: `bitfinex candles ${res.status}: ${await res.text()}` };
    const raw = await res.json() as number[][];
    return { price: raw[0]?.[2] ?? null, debug: raw.length ? "ok" : "empty candle array" };
  }
  // Binance Global (api.binance.com) uses data-api.binance.vision for market data — same data,
  // but avoids the geo/region restrictions api.binance.com applies to some server IPs.
  const base = venue === "us" ? "https://api.binance.us/api/v3" : "https://data-api.binance.vision/api/v3";
  const res = await fetch(`${base}/klines?symbol=${symbol}&interval=1m&startTime=${atMs}&limit=1`, { cache: "no-store" });
  if (!res.ok) return { price: null, debug: `${base} klines ${res.status}: ${await res.text()}` };
  const raw = await res.json() as any[];
  return { price: raw[0] ? parseFloat(raw[0][4]) : null, debug: raw.length ? "ok" : "empty klines array" };
}

async function fetchCurrentPrice(venue: Venue, symbol: string): Promise<{ price: number | null; debug: string }> {
  if (venue === "bitfinex") {
    const res = await fetch(`https://api-pub.bitfinex.com/v2/ticker/${symbol}`, { cache: "no-store" });
    if (!res.ok) return { price: null, debug: `bitfinex ticker ${res.status}: ${await res.text()}` };
    const data = await res.json() as number[];
    return { price: data[6] ?? null, debug: "ok" };
  }
  const base = venue === "us" ? "https://api.binance.us/api/v3" : "https://data-api.binance.vision/api/v3";
  const res = await fetch(`${base}/ticker/price?symbol=${symbol}`, { cache: "no-store" });
  if (!res.ok) return { price: null, debug: `${base} ticker ${res.status}: ${await res.text()}` };
  const data = await res.json();
  return { price: parseFloat(data.price), debug: "ok" };
}

export async function GET(req: NextRequest) {
  const venue = req.nextUrl.searchParams.get("venue") as Venue | null;
  const symbol = req.nextUrl.searchParams.get("symbol");
  const sinceMs = req.nextUrl.searchParams.get("sinceMs");

  if (!venue || !symbol || !sinceMs || !["global", "us", "bitfinex"].includes(venue)) {
    return NextResponse.json({ ok: false, error: "missing/invalid venue, symbol, or sinceMs" }, { status: 400 });
  }

  try {
    const [start, current] = await Promise.all([
      fetchPriceAt(venue, symbol, +sinceMs),
      fetchCurrentPrice(venue, symbol),
    ]);
    if (start.price == null || current.price == null) {
      return NextResponse.json({ ok: false, error: "price lookup failed", startDebug: start.debug, currentDebug: current.debug }, { status: 502 });
    }
    const pctChange = (current.price - start.price) / start.price * 100;
    return NextResponse.json({ ok: true, startPrice: start.price, currentPrice: current.price, pctChange });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
