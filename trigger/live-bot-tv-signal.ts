import { schedules } from "@trigger.dev/sdk/v3";
import { getTvBotState, updateTvBotState, recordTvBotTrade, logTvBotRun } from "../lib/tv-bot-db";

type Signal = "STRONG_BUY" | "BUY" | "NEUTRAL" | "SELL" | "STRONG_SELL";

function toSignal(val: number | null): Signal {
  if (val == null) return "NEUTRAL";
  if (val >= 0.5)  return "STRONG_BUY";
  if (val >= 0.1)  return "BUY";
  if (val > -0.1)  return "NEUTRAL";
  if (val > -0.5)  return "SELL";
  return "STRONG_SELL";
}

const PRICE_BASE: Record<string, string> = {
  BINANCE:   "https://api.binance.com/api/v3/ticker/price?symbol=",
  BINANCEUS: "https://api.binance.us/api/v3/ticker/price?symbol=",
};

async function fetchSignal(exchange: string, symbol: string, timeframe: string) {
  const ticker      = `${exchange}:${symbol}`;
  const isDailyPlus = timeframe === "1D" || timeframe === "1W";
  const col         = (c: string) => isDailyPlus ? c : `${c}|${timeframe}`;

  const [tvRes, priceRes] = await Promise.all([
    fetch("https://scanner.tradingview.com/crypto/scan", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbols: { tickers: [ticker], query: { types: [] } },
        columns: [col("Recommend.All"), col("Recommend.MA"), col("Recommend.Other")],
      }),
    }),
    fetch(`${PRICE_BASE[exchange] ?? PRICE_BASE.BINANCEUS}${symbol}`),
  ]);

  const tvJson    = await tvRes.json();
  const priceJson = await priceRes.json();
  const [raw, ma, osc] = tvJson.data?.[0]?.d ?? [null, null, null];
  const price = parseFloat(priceJson.price ?? "0");
  return { raw, ma, osc, price };
}

async function runBot(id: number) {
  const log: object[] = [];

  let state;
  try {
    state = await getTvBotState(id);
  } catch (err) {
    await logTvBotRun(id, { actions: [{ action: "ERROR", stage: "state", error: String(err) }] });
    return;
  }
  if (!state.enabled) return;

  try {
    const { raw, ma, osc, price } = await fetchSignal(state.exchange, state.symbol, state.timeframe);
    const signal   = toSignal(raw);
    const wantBuy  = state.buy_on  === "strong" ? signal === "STRONG_BUY" : signal === "STRONG_BUY" || signal === "BUY";
    const wantSell = state.sell_on === "strong" ? signal === "STRONG_SELL" : signal === "STRONG_SELL" || signal === "SELL";

    log.push({ action: "CHECK", signal, raw, ma, osc, price, pos: state.pos });

    if (state.mode === "paper") {
      if (state.pos === "flat" && wantBuy && price > 0) {
        const qty = state.usdt / price;
        await updateTvBotState(id, {
          pos: "long", usdt: 0, sol_qty: qty,
          entry_price: price, entry_signal: signal,
        });
        await recordTvBotTrade({ bot_id: id, side: "BUY", price, qty, signal });
        log.push({ action: "BUY", price, qty, signal });

      } else if (state.pos === "long" && wantSell && price > 0) {
        const out      = state.sol_qty * price;
        const pnlPct   = (out / (state.entry_price * state.sol_qty) - 1) * 100;
        const isWin    = pnlPct > 0;
        const newPeak  = Math.max(state.peak, out);
        const newMaxDD = Math.max(state.max_dd, (newPeak - out) / newPeak * 100);
        await updateTvBotState(id, {
          pos: "flat", usdt: out, sol_qty: 0,
          entry_price: 0, entry_signal: "NEUTRAL",
          round_trips: state.round_trips + 1,
          wins:        state.wins + (isWin ? 1 : 0),
          peak:        newPeak,
          max_dd:      newMaxDD,
        });
        await recordTvBotTrade({ bot_id: id, side: "SELL", price, qty: state.sol_qty, signal, pnl_pct: pnlPct });
        log.push({ action: "SELL", price, pnlPct, signal });
      }
    }

    // mode === "live" — real Binance orders go here when ready

  } catch (err) {
    log.push({ action: "ERROR", stage: "trading", error: String(err) });
  }

  await logTvBotRun(id, { actions: log });
}

export const tvSignalBot = schedules.task({
  id:          "live-bot-tv-signal-1m",
  cron:        "* * * * *",
  maxDuration: 55,

  run: async () => {
    await Promise.all([runBot(1), runBot(2)]);
    return { ok: true };
  },
});
