// Public-data-only Bitfinex client — no API key needed, used for paper bots and backtests.
const BASE = "https://api-pub.bitfinex.com/v2";

export type BitfinexCandle = { time: number; close: number };

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

export async function getBitfinexPrice(symbol: string): Promise<number> {
  const res = await fetch(`${BASE}/ticker/${symbol}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Bitfinex ticker error: ${res.status}`);
  const data = await res.json() as number[];
  return data[6]; // LAST_PRICE
}
