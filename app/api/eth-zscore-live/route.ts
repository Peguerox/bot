import { NextResponse } from "next/server";

// Computes the CURRENT live z-score using the same continuous rolling 25-min window logic as
// server/zscore-trail-bitfinex.ts (window = trailing 25 completed 1-min Binance closes, current =
// latest close), so the dashboard can show how close price actually is to the z<=-2.0 entry
// trigger in real time -- was previously only visible in the BUY log line after the fact.
const WINDOW_MIN = 25;

export async function GET() {
  const res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=1m&limit=${WINDOW_MIN + 2}`,
    { cache: "no-store" }
  );
  const data = await res.json();
  if (!Array.isArray(data)) {
    console.error("Binance klines non-array response:", res.status, JSON.stringify(data));
    return NextResponse.json({ z: null, current: null, mean: null, std: null, error: data }, { status: 502 });
  }
  const closes: number[] = data.map((k: any) => parseFloat(k[4]));
  // drop the still-forming last candle, keep the trailing WINDOW_MIN closed ones as the window
  const closed = closes.slice(0, -1);
  const current = closed[closed.length - 1];
  const window = closed.slice(-1 - WINDOW_MIN, -1);

  if (window.length < WINDOW_MIN) {
    return NextResponse.json({ z: null, current: null, mean: null, std: null });
  }

  const mean = window.reduce((s, v) => s + v, 0) / window.length;
  const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
  const std = Math.sqrt(variance);
  const z = std > 0 ? (current - mean) / std : 0;

  return NextResponse.json({ z, current, mean, std });
}
