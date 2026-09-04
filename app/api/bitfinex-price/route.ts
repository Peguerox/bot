import { NextRequest, NextResponse } from "next/server";

// Proxies Bitfinex's public ticker so the dashboard can poll it — Bitfinex's API doesn't send
// CORS headers, so a direct browser fetch is silently blocked. Server-to-server calls aren't
// subject to CORS, so this route does the fetch instead. Symbol is a query param (defaults to
// tSOLUSD for backwards compat with callers that don't pass one) -- was hardcoded to SOL only,
// which silently showed SOL's price on the ETH panel after that bot switched pairs.
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") || "tSOLUSD";
  const res = await fetch(`https://api-pub.bitfinex.com/v2/ticker/${symbol}`);
  const data = await res.json();
  return NextResponse.json({ lastPrice: data[6] });
}
