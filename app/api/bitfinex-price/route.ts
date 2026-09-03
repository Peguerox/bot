import { NextResponse } from "next/server";

// Proxies Bitfinex's public ticker so the dashboard can poll it — Bitfinex's API doesn't send
// CORS headers, so a direct browser fetch is silently blocked. Server-to-server calls aren't
// subject to CORS, so this route does the fetch instead.
export async function GET() {
  const res = await fetch("https://api-pub.bitfinex.com/v2/ticker/tSOLUSD");
  const data = await res.json();
  return NextResponse.json({ lastPrice: data[6] });
}
