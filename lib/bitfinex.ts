// Public-data-only Bitfinex client — no API key needed, used for paper bots and backtests.
const BASE = "https://api-pub.bitfinex.com/v2";

export type BitfinexCandle = { time: number; close: number };
export type BitfinexOHLCV = { time: number; open: number; close: number; high: number; low: number; volume: number };

// Bitfinex candle order is [MTS, OPEN, CLOSE, HIGH, LOW, VOLUME] — not OHLC like Binance.
// sort=-1 with no start/end bound returns the most recent candles first (sort=1 with no bound
// does the opposite — oldest-first from the beginning of the pair's history, which silently
// returns years-old data instead of "the last N candles").
export async function getBitfinexCandles(symbol: string, limit: number): Promise<BitfinexCandle[]> {
  const res = await fetch(`${BASE}/candles/trade:1m:${symbol}/hist?limit=${limit}&sort=-1`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Bitfinex candles error: ${res.status}`);
  const raw = await res.json() as number[][];
  return raw.map((c) => ({ time: c[0], close: c[2] })).reverse(); // back to ascending (oldest → newest)
}

// Same as above but any timeframe ("1m", "5m", "15m", ...) and full OHLCV, not just close.
export async function getBitfinexCandlesOHLCV(symbol: string, timeframe: string, limit: number): Promise<BitfinexOHLCV[]> {
  const res = await fetch(`${BASE}/candles/trade:${timeframe}:${symbol}/hist?limit=${limit}&sort=-1`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Bitfinex candles error: ${res.status}`);
  const raw = await res.json() as number[][];
  return raw
    .map((c) => ({ time: c[0], open: c[1], close: c[2], high: c[3], low: c[4], volume: c[5] }))
    .reverse(); // back to ascending (oldest → newest)
}

export async function getBitfinexPrice(symbol: string): Promise<number> {
  const res = await fetch(`${BASE}/ticker/${symbol}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Bitfinex ticker error: ${res.status}`);
  const data = await res.json() as number[];
  return data[6]; // LAST_PRICE
}

// Real bid/ask, for worst-case-consistent entry/exit pricing (entry at ask, exit checks at bid).
export async function getBitfinexBidAsk(symbol: string): Promise<{ bid: number; ask: number }> {
  const res = await fetch(`${BASE}/ticker/${symbol}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Bitfinex ticker error: ${res.status}`);
  const data = await res.json() as number[];
  return { bid: data[0], ask: data[2] };
}
