// Z-score correlation break strategy — ported from Python backtest
// BTC leads BNB/ATOM → buy when alt lags BTC by > 2 standard deviations

const CORR_WINDOW = 20;
const Z_THRESH    = 2.0;
const TP_PCT      = 0.008;  // 0.8% take profit
const SL_PCT      = 0.003;  // 0.3% stop loss
const MAX_HOLD    = 6;      // 6 candles = 6 minutes on 1m

export type Candle = { close: number };

export type Signal = {
  side: "long";
  entry: number;
  sl: number;
  tp: number;
  z: number;
};

export type Position = {
  id: string;
  pair: string;
  entry: number;
  sl: number;
  tp: number;
  qty: number;
  hold_count: number;
  entry_time: string;
};

export type CloseResult = {
  pnl: number;
  result: "TP" | "SL" | "EXPIRE";
  exit_price: number;
};

function logReturn(a: number, b: number) {
  return Math.log(b / a);
}

export function calcZScore(btcCandles: Candle[], altCandles: Candle[]): number {
  const n = Math.min(btcCandles.length, altCandles.length);
  const spreads: number[] = [];

  for (let i = 1; i < n; i++) {
    const btcRet = logReturn(btcCandles[i - 1].close, btcCandles[i].close);
    const altRet = logReturn(altCandles[i - 1].close, altCandles[i].close);
    spreads.push(altRet - btcRet);
  }

  const window = spreads.slice(-CORR_WINDOW);
  if (window.length < CORR_WINDOW) return 0;

  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const std  = Math.sqrt(
    window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length
  );

  if (std === 0) return 0;
  return (spreads[spreads.length - 1] - mean) / std;
}

export function checkSignal(z: number, price: number, allocation: number): Signal | null {
  if (z >= -Z_THRESH) return null;
  return {
    side:  "long",
    entry: price,
    sl:    price * (1 - SL_PCT),
    tp:    price * (1 + TP_PCT),
    z,
  };
}

export function checkClose(pos: Position, currentPrice: number): CloseResult | null {
  const newHold = pos.hold_count + 1;
  const hitTP   = currentPrice >= pos.tp;
  const hitSL   = currentPrice <= pos.sl;
  const expired = newHold >= MAX_HOLD;

  if (!hitTP && !hitSL && !expired) return null;

  const pnl    = (currentPrice - pos.entry) * pos.qty;
  const result = hitTP ? "TP" : hitSL ? "SL" : "EXPIRE";
  return { pnl, result, exit_price: currentPrice };
}

export { TP_PCT, SL_PCT, MAX_HOLD, Z_THRESH };
