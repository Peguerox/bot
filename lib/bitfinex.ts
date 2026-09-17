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

export type BitfinexTrade = { id: number; tsMs: number; amount: number; price: number };

// Real individual executed trades (not candles) for a window -- used to replay trade-tape-driven
// strategies (e.g. lib/solbtc-sizeconf-engine.ts) exactly, not approximate them off 1-min OHLC.
// Paginates forward via sort=1 + advancing `start` past the last returned trade's timestamp.
// Bounded to a reasonable number of pages since callers here compare recent live-bot windows
// (hours, not years) -- for multi-year historical fetches, use the scratchpad research scripts.
export async function getBitfinexTradesRange(symbol: string, startMs: number, endMs: number, maxPages = 50): Promise<BitfinexTrade[]> {
  const all: BitfinexTrade[] = [];
  let cursor = startMs;
  for (let page = 0; page < maxPages && cursor < endMs; page++) {
    const url = `${BASE}/trades/${symbol}/hist?start=${cursor}&end=${endMs}&limit=10000&sort=1`;
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 2000)); page--; continue; }
    if (!res.ok) throw new Error(`Bitfinex trades error: ${res.status}`);
    const raw = await res.json() as number[][];
    if (raw.length === 0) break;
    for (const [id, mts, amount, price] of raw) all.push({ id, tsMs: mts, amount, price });
    const last = raw[raw.length - 1][1];
    if (last <= cursor) break;
    cursor = last + 1;
    if (raw.length < 10000) break;
  }
  return all;
}
