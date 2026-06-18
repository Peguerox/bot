import { NextRequest, NextResponse } from "next/server";

const PRICE_BASE: Record<string, string> = {
  BINANCE:   "https://api.binance.com/api/v3/ticker/price?symbol=",
  BINANCEUS: "https://api.binance.us/api/v3/ticker/price?symbol=",
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const exchange  = searchParams.get("exchange")  ?? "BINANCEUS";
  const symbol    = searchParams.get("symbol")    ?? "SOLUSD";
  const timeframe = searchParams.get("timeframe") ?? "60";

  const ticker = `${exchange}:${symbol}`;
  const isDailyPlus = timeframe === "1D" || timeframe === "1W";
  const col = (c: string) => isDailyPlus ? c : `${c}|${timeframe}`;

  try {
    const [tvRes, priceRes] = await Promise.all([
      fetch("https://scanner.tradingview.com/crypto/scan", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbols: { tickers: [ticker], query: { types: [] } },
          columns: [col("Recommend.All"), col("Recommend.MA"), col("Recommend.Other")],
        }),
        next: { revalidate: 0 },
      }),
      fetch(`${PRICE_BASE[exchange] ?? PRICE_BASE.BINANCEUS}${symbol}`, { next: { revalidate: 0 } }),
    ]);

    const tvJson    = await tvRes.json();
    const priceJson = await priceRes.json();

    const [raw, ma, osc] = tvJson.data?.[0]?.d ?? [null, null, null];
    const price = parseFloat(priceJson.price ?? "0");

    return NextResponse.json({ raw, ma, osc, price });
  } catch (e: unknown) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
