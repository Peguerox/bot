// Shared live microstructure feature computation -- single source of truth used by BOTH the
// data logger (server/jump-trail-bitfinex.ts, Worker 2) that generated the training data AND any
// live predictor built on a model trained from that data (e.g. server/btc-predictor-bitfinex.ts,
// Worker 1). Keeping this in one place is deliberate: if live inference computed features even
// slightly differently than training did, predictions would be silently wrong (train/serve skew)
// in a way that's very hard to notice from the outside.
export const HISTORY_MS = 65_000; // slightly more than the 60s max label/prediction horizon
export const SLIPPAGE_NOTIONAL_USD = 500;

export type BookLevel = { count: number; amount: number };
export type Trade = { ts: number; price: number; amount: number };
export type HistEntry = { ts: number; mid: number; spreadPct: number; imbalance: number };

export type FeatureState = {
  book: Map<number, BookLevel>;
  bookReady: boolean;
  trades: Trade[];
  history: HistEntry[];
  prevLevelKey: Set<string>;
  binanceBid: number | null;
  binanceAsk: number | null;
  binanceBidQty: number | null;
  binanceAskQty: number | null;
  prevVelocity1s: number | null;
};

export function createFeatureState(): FeatureState {
  return {
    book: new Map(), bookReady: false, trades: [], history: [],
    prevLevelKey: new Set(),
    binanceBid: null, binanceAsk: null, binanceBidQty: null, binanceAskQty: null,
    prevVelocity1s: null,
  };
}

export function applyBookRow(state: FeatureState, row: [number, number, number]) {
  const [price, count, amount] = row;
  if (count === 0) state.book.delete(price);
  else state.book.set(price, { count, amount });
}

export function bestBidAsk(state: FeatureState): { bid: number | null; ask: number | null } {
  let bid: number | null = null, ask: number | null = null;
  for (const [price, lvl] of state.book) {
    if (lvl.amount > 0 && (bid === null || price > bid)) bid = price;
    if (lvl.amount < 0 && (ask === null || price < ask)) ask = price;
  }
  return { bid, ask };
}

function sortedLevels(state: FeatureState, side: "bid" | "ask"): { price: number; size: number }[] {
  const rows = [...state.book.entries()]
    .filter(([, lvl]) => (side === "bid" ? lvl.amount > 0 : lvl.amount < 0))
    .map(([price, lvl]) => ({ price, size: Math.abs(lvl.amount) }));
  rows.sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
  return rows;
}

function depthSum(levels: { size: number }[], n: number): number {
  return levels.slice(0, n).reduce((s, l) => s + l.size, 0);
}

function estimateSlippagePct(levels: { price: number; size: number }[], bestPrice: number, notionalUsd: number): number | null {
  let remaining = notionalUsd, cost = 0, filled = 0;
  for (const l of levels) {
    const levelNotional = l.price * l.size;
    const take = Math.min(remaining, levelNotional);
    const takeSize = take / l.price;
    cost += take;
    filled += takeSize;
    remaining -= take;
    if (remaining <= 0) break;
  }
  if (filled === 0 || remaining > 0) return null; // book too thin to fill
  const avgPrice = cost / filled;
  return (avgPrice - bestPrice) / bestPrice * 100;
}

export function findHistAt(state: FeatureState, msAgo: number, now: number): HistEntry | null {
  const target = now - msAgo;
  let best: HistEntry | null = null, bestDiff = Infinity;
  for (const h of state.history) {
    const diff = Math.abs(h.ts - target);
    if (diff < bestDiff) { bestDiff = diff; best = h; }
  }
  return bestDiff <= 1_500 ? best : null;
}

function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function computeFeatures(state: FeatureState, now: number): { mid: number; features: Record<string, unknown> } | null {
  const { bid, ask } = bestBidAsk(state);
  if (bid === null || ask === null) return null;
  const mid = (bid + ask) / 2;
  const spreadPct = (ask - bid) / mid * 100;

  const bidLevels = sortedLevels(state, "bid");
  const askLevels = sortedLevels(state, "ask");
  const bidDepthTop3 = depthSum(bidLevels, 3), bidDepthTop10 = depthSum(bidLevels, 10);
  const askDepthTop3 = depthSum(askLevels, 3), askDepthTop10 = depthSum(askLevels, 10);
  const imbalance = (bidDepthTop10 - askDepthTop10) / (bidDepthTop10 + askDepthTop10 || 1);

  const bidSize0 = bidLevels[0]?.size ?? 0, askSize0 = askLevels[0]?.size ?? 0;
  const microprice = (bidSize0 + askSize0) > 0
    ? (bid * askSize0 + ask * bidSize0) / (bidSize0 + askSize0)
    : mid;
  const micropriceDivergencePct = (microprice - mid) / mid * 100;

  const levelKey = new Set<string>([...state.book.entries()].map(([p, l]) => `${p}:${l.amount}`));
  let churn = 0;
  for (const k of levelKey) if (!state.prevLevelKey.has(k)) churn++;
  for (const k of state.prevLevelKey) if (!levelKey.has(k)) churn++;
  state.prevLevelKey = levelKey;

  const recentTrades5s = state.trades.filter((t) => t.ts >= now - 5_000);
  const trades60s = state.trades.filter((t) => t.ts >= now - 60_000);
  const lastTrade = state.trades[state.trades.length - 1] ?? null;
  const buyVol5s = recentTrades5s.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const sellVol5s = recentTrades5s.filter((t) => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
  const vwap5sNotional = recentTrades5s.reduce((s, t) => s + t.price * Math.abs(t.amount), 0);
  const vwap5sVolume = recentTrades5s.reduce((s, t) => s + Math.abs(t.amount), 0);
  const vwap5s = vwap5sVolume > 0 ? vwap5sNotional / vwap5sVolume : null;
  const avgTradeSize60s = trades60s.length > 0
    ? trades60s.reduce((s, t) => s + Math.abs(t.amount), 0) / trades60s.length
    : null;
  const maxTradeSize5s = recentTrades5s.length > 0 ? Math.max(...recentTrades5s.map((t) => Math.abs(t.amount))) : 0;
  const largeTradeFlag = avgTradeSize60s !== null && avgTradeSize60s > 0 && maxTradeSize5s > 5 * avgTradeSize60s;

  const vel1s = findHistAt(state, 1_000, now);
  const vel5s = findHistAt(state, 5_000, now);
  const vel15s = findHistAt(state, 15_000, now);
  const vel30s = findHistAt(state, 30_000, now);
  const vel60s = findHistAt(state, 60_000, now);
  const velocity1sPct = vel1s ? (mid - vel1s.mid) / vel1s.mid * 100 : null;
  const acceleration = velocity1sPct !== null && state.prevVelocity1s !== null ? velocity1sPct - state.prevVelocity1s : null;
  if (velocity1sPct !== null) state.prevVelocity1s = velocity1sPct;

  const recentHist = state.history.slice(-15);
  const returns1s: number[] = [];
  for (let i = 1; i < recentHist.length; i++) returns1s.push((recentHist[i].mid - recentHist[i - 1].mid) / recentHist[i - 1].mid * 100);
  const realizedVol15s = stdev(returns1s);
  const spreadVol15s = stdev(recentHist.map((h) => h.spreadPct));
  const imbalanceTrend5s = vel5s ? imbalance - vel5s.imbalance : null;

  const slippageBuyPct = estimateSlippagePct(askLevels, ask, SLIPPAGE_NOTIONAL_USD);
  const slippageSellPct = estimateSlippagePct(bidLevels, bid, SLIPPAGE_NOTIONAL_USD);

  let binance: Record<string, unknown> | null = null;
  if (state.binanceBid !== null && state.binanceAsk !== null) {
    const bMid = (state.binanceBid + state.binanceAsk) / 2;
    const bImb = state.binanceBidQty !== null && state.binanceAskQty !== null && (state.binanceBidQty + state.binanceAskQty) > 0
      ? (state.binanceBidQty - state.binanceAskQty) / (state.binanceBidQty + state.binanceAskQty)
      : null;
    binance = {
      mid: bMid,
      bestBid: state.binanceBid,
      bestAsk: state.binanceAsk,
      spreadPct: (state.binanceAsk - state.binanceBid) / bMid * 100,
      imbalance: bImb,
      venueGapPct: (bMid - mid) / mid * 100,
    };
  }

  return {
    mid,
    features: {
      bestBid: bid, bestAsk: ask, spreadPct,
      bidDepthTop3, bidDepthTop10, askDepthTop3, askDepthTop10,
      imbalance, bidLevelCount: bidLevels.length, askLevelCount: askLevels.length,
      bidSlope: bidDepthTop10 > 0 ? bidDepthTop3 / bidDepthTop10 : null,
      askSlope: askDepthTop10 > 0 ? askDepthTop3 / askDepthTop10 : null,
      bookChurn: churn,
      microprice, micropriceDivergencePct,
      lastTradePrice: lastTrade?.price ?? null,
      lastTradeSize: lastTrade ? Math.abs(lastTrade.amount) : null,
      lastTradeSide: lastTrade ? (lastTrade.amount > 0 ? "buy" : "sell") : null,
      timeSinceLastTradeMs: lastTrade ? now - lastTrade.ts : null,
      tradeRate1s: state.trades.filter((t) => t.ts >= now - 1_000).length,
      buyVol5s, sellVol5s, vwap5s, largeTradeFlag,
      velocity1sPct,
      velocity5sPct: vel5s ? (mid - vel5s.mid) / vel5s.mid * 100 : null,
      velocity15sPct: vel15s ? (mid - vel15s.mid) / vel15s.mid * 100 : null,
      velocity30sPct: vel30s ? (mid - vel30s.mid) / vel30s.mid * 100 : null,
      velocity60sPct: vel60s ? (mid - vel60s.mid) / vel60s.mid * 100 : null,
      acceleration, realizedVol15s, spreadVol15s, imbalanceTrend5s,
      slippageBuyPct, slippageSellPct,
      binance,
    },
  };
}

export function updateHistory(state: FeatureState, now: number, mid: number, spreadPct: number, imbalance: number) {
  state.history.push({ ts: now, mid, spreadPct, imbalance });
  state.history = state.history.filter((h) => now - h.ts <= HISTORY_MS);
  state.trades = state.trades.filter((t) => now - t.ts <= HISTORY_MS);
}
