import { schedules } from "@trigger.dev/sdk/v3";
import { getKlines, getPrice } from "../lib/binance";
import { calcZScore, checkSignal, checkClose } from "../lib/strategy";
import { PAIRS, getOpenPosition, openPosition, closePosition, incrementHold, startChasing, updateChasePrice, logRun } from "../lib/db";

const CHASE_OFFSET = 0.0005; // 0.05% below current price

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
          if (openPos.status === "chasing") {
            // Check if our limit order filled: price came down to chase level
            if (currentPrice <= openPos.chase_price) {
              const pnl = (openPos.chase_price - openPos.entry_price) * openPos.quantity;
              await closePosition(openPos.id, {
                exit_price: openPos.chase_price,
                pnl,
                result:     "CHASE_FILL",
              });
              log.push({ pair: name, action: "CHASE_FILL",
                         exit: openPos.chase_price, pnl: pnl.toFixed(4) });
            } else {
              // Price ran up — move limit to 0.05% below new price
              const newChasePrice = currentPrice * (1 - CHASE_OFFSET);
              await updateChasePrice(openPos.id, newChasePrice);
              log.push({ pair: name, action: "CHASE_UP",
                         price: currentPrice, chasePrice: newChasePrice.toFixed(4) });
            }
          } else {
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
              if (close.result === "EXPIRE") {
                // Start chasing instead of market close
                const chasePrice = currentPrice * (1 - CHASE_OFFSET);
                await startChasing(openPos.id, chasePrice);
                log.push({ pair: name, action: "START_CHASE",
                           price: currentPrice, chasePrice: chasePrice.toFixed(4) });
              } else {
                await closePosition(openPos.id, {
                  exit_price: close.exit_price,
                  pnl:        close.pnl,
                  result:     close.result,
                });
                log.push({ pair: name, action: "CLOSE", result: close.result,
                           pnl: close.pnl.toFixed(4), exit: close.exit_price });
              }
            } else {
              await incrementHold(openPos.id);
              log.push({ pair: name, action: "HOLD",
                         hold: openPos.hold_count + 1, price: currentPrice });
            }
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
