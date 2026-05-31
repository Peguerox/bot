import { schedules } from "@trigger.dev/sdk/v3";
import { getKlines, getPrice } from "../lib/binance";
import { calcZScore, checkSignal, checkClose } from "../lib/strategy";
import { PAIRS, getOpenPosition, openPosition, closePosition, incrementHold, logRun } from "../lib/db";

export const tradingBot = schedules.task({
  id:       "trading-bot-1m",
  cron:     "* * * * *",   // every 1 minute
  maxDuration: 55,          // must finish before next run
  run: async () => {
    const CANDLES = 50;     // enough for 20-bar z-score + buffer
    const log: object[] = [];

    // Fetch BTC candles once — shared across all pairs
    const btcCandles = await getKlines("BTCUSDT", "1m", CANDLES);

    for (const { symbol, name, allocation } of PAIRS) {
      try {
        const altCandles  = await getKlines(symbol, "1m", CANDLES);
        const currentPrice = altCandles[altCandles.length - 1].close;
        const z            = calcZScore(btcCandles, altCandles);
        const openPos      = await getOpenPosition(name);

        // ── Manage open position ─────────────────────────────
        if (openPos) {
          const close = checkClose(
            {
              id:         openPos.id,
              pair:       openPos.pair,
              entry:      openPos.entry_price,
              sl:         openPos.sl,
              tp:         openPos.tp,
              qty:        openPos.quantity,
              hold_count: openPos.hold_count,
              entry_time: openPos.entry_time,
            },
            currentPrice
          );

          if (close) {
            await closePosition(openPos.id, {
              exit_price: close.exit_price,
              pnl:        close.pnl,
              result:     close.result,
            });
            log.push({ pair: name, action: "CLOSE", result: close.result,
                       pnl: close.pnl.toFixed(4), exit: currentPrice });
          } else {
            await incrementHold(openPos.id);
            log.push({ pair: name, action: "HOLD",
                       hold: openPos.hold_count + 1, price: currentPrice });
          }
        }

        // ── Check for new signal ─────────────────────────────
        if (!openPos) {
          const signal = checkSignal(z, currentPrice, allocation);
          if (signal) {
            const qty = allocation / signal.entry;
            await openPosition(name, { ...signal, qty });
            log.push({ pair: name, action: "OPEN", entry: signal.entry,
                       sl: signal.sl.toFixed(4), tp: signal.tp.toFixed(4),
                       z: z.toFixed(3) });
          } else {
            log.push({ pair: name, action: "WATCH", z: z.toFixed(3), price: currentPrice });
          }
        }
      } catch (err) {
        log.push({ pair: name, action: "ERROR", error: String(err) });
      }
    }

    await logRun({ actions: log });
    console.log("Bot run complete:", JSON.stringify(log, null, 2));
    return { ok: true, actions: log };
  },
});
