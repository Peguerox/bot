import { schedules } from "@trigger.dev/sdk/v3";
import { getTvBotState, updateTvBotState, recordTvBotTrade, logTvBotRun } from "../lib/tv-bot-db";

type Signal = "STRONG_BUY" | "BUY" | "NEUTRAL" | "SELL" | "STRONG_SELL";

type SrcKey = "overall" | "ma" | "osc";
type SignalConfig = {
  sources: SrcKey[];
  combo:   "any" | "all";
  buy:     Partial<Record<SrcKey, "buy" | "strong">>;
  sell:    Partial<Record<SrcKey, "sell" | "strong">>;
};

const DEFAULT_SIGNAL_CONFIG: SignalConfig = {
  sources: ["overall"],
  combo:   "all",
  buy:     { overall: "buy" },
  sell:    { overall: "sell" },
};

function toSignal(val: number | null): Signal {
  if (val == null) return "NEUTRAL";
  if (val >= 0.5)  return "STRONG_BUY";
  if (val >= 0.1)  return "BUY";
  if (val > -0.1)  return "NEUTRAL";
  if (val > -0.5)  return "SELL";
  return "STRONG_SELL";
}

function evalSignals(
  cfg: SignalConfig,
  raw: number | null, ma: number | null, osc: number | null,
  dir: "buy" | "sell",
): boolean {
  const vals: Record<SrcKey, number | null> = { overall: raw, ma, osc };
  const results = cfg.sources.map(src => {
    const threshold = cfg[dir][src];
    const sig = toSignal(vals[src]);
    if (dir === "buy")  return threshold === "strong" ? sig === "STRONG_BUY"  : sig === "STRONG_BUY"  || sig === "BUY";
    else                return threshold === "strong" ? sig === "STRONG_SELL" : sig === "STRONG_SELL" || sig === "SELL";
  });
  return cfg.combo === "all" ? results.every(Boolean) : results.some(Boolean);
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
  if (!price || price <= 0) throw new Error(`Invalid price for ${symbol}: ${JSON.stringify(priceJson)}`);
  return { raw, ma, osc, price };
}

async function runBot(id: number) {
  const log: object[] = [];

  let state;
  try {
    state = await getTvBotState(id);
  } catch (err) {
    try { await logTvBotRun(id, { actions: [{ action: "ERROR", stage: "state", error: String(err) }] }); } catch {}
    return;
  }
  if (!state.enabled) return;

  try {
    const { raw, ma, osc, price } = await fetchSignal(state.exchange, state.symbol, state.timeframe);
    const cfg      = (state.signal_config as SignalConfig | null) ?? DEFAULT_SIGNAL_CONFIG;
    const signal   = toSignal(raw);
    const wantBuy  = evalSignals(cfg, raw, ma, osc, "buy");
    const wantSell = evalSignals(cfg, raw, ma, osc, "sell");

    log.push({ action: "CHECK", signal, raw, ma, osc, price, pos: state.pos, wantBuy, wantSell });

    if (state.mode === "paper") {
      if (state.pos === "flat" && wantBuy) {
        const qty = state.usdt / price;
        await updateTvBotState(id, {
          pos: "long", usdt: 0, sol_qty: qty,
          entry_price: price, entry_signal: signal,
        });
        await recordTvBotTrade({ bot_id: id, side: "BUY", price, qty, signal });
        log.push({ action: "BUY", price, qty, signal });

      } else if (state.pos === "long" && wantSell) {
        const entryPrice = Number(state.entry_price);
        const solQty     = Number(state.sol_qty);
        const out        = solQty * price;
        const cost       = entryPrice * solQty;
        const pnlPct     = cost > 0 ? (out / cost - 1) * 100 : 0;
        const isWin      = pnlPct > 0;
        const newPeak    = Math.max(Number(state.peak), out);
        const newMaxDD   = Math.max(Number(state.max_dd), newPeak > 0 ? (newPeak - out) / newPeak * 100 : 0);
        await updateTvBotState(id, {
          pos: "flat", usdt: out, sol_qty: 0,
          entry_price: 0, entry_signal: "NEUTRAL",
          round_trips: Number(state.round_trips) + 1,
          wins:        Number(state.wins) + (isWin ? 1 : 0),
          peak:        newPeak,
          max_dd:      newMaxDD,
        });
        await recordTvBotTrade({ bot_id: id, side: "SELL", price, qty: solQty, signal, pnl_pct: pnlPct });
        log.push({ action: "SELL", price, pnlPct, signal });
      }
    }

    // mode === "live" — real Binance orders go here when ready

  } catch (err) {
    log.push({ action: "ERROR", stage: "trading", error: String(err) });
  }

  try {
    await logTvBotRun(id, { actions: log });
  } catch {}
}

export const tvSignalBot = schedules.task({
  id:          "live-bot-tv-signal-1m",
  cron:        "* * * * *",
  maxDuration: 55,

  run: async () => {
    await Promise.allSettled([runBot(1), runBot(2)]);
    return { ok: true };
  },
});
