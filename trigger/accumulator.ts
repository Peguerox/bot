import { schedules } from "@trigger.dev/sdk/v3";
import { getKlines, getPrice } from "../lib/binance";
import {
  getAccumulatorState,
  initAccumulatorState,
  updateAccumulatorState,
  logSwitch,
  getLastSolEntryBtc,
} from "../lib/accumulator-db";

const BB_PERIOD       = 10;   // BB(10) on BTCUSDT
const CANDLES_NEEDED  = 50;   // buffer beyond BB_PERIOD
const START_USD       = 1000; // paper trading allocation

// BB(10) pct_b > 0.5 is mathematically identical to price > 10-period MA
function getBBSignal(closes: number[]): boolean {
  const window = closes.slice(-BB_PERIOD);
  const mean   = window.reduce((a, b) => a + b, 0) / BB_PERIOD;
  return closes[closes.length - 1] > mean;  // true = uptrend = hold SOL
}

export const accumulatorBot = schedules.task({
  id:          "accumulator-bot-5m",
  cron:        "*/5 * * * *",   // every 5 minutes
  maxDuration: 55,
  run: async () => {
    // Fetch BTC 5m candles for the signal
    const btcCandles   = await getKlines("BTCUSDT", "5m", CANDLES_NEEDED);
    const solBtcPrice  = await getPrice("SOLBTC");
    // Drop the last candle — it's the current open (incomplete) candle.
    // Using it would cause signal flips on a half-baked close, causing extra switches.
    const closedCandles = btcCandles.slice(0, -1);
    const btcUsdPrice  = closedCandles[closedCandles.length - 1].close;
    const btcCloses    = closedCandles.map((c: { close: number }) => c.close);
    const uptrend      = getBBSignal(btcCloses);
    const targetAsset  = uptrend ? "SOL" : "BTC";

    // Load or initialise state
    let state = await getAccumulatorState();
    if (!state) {
      const startBtc = START_USD / btcUsdPrice;
      await initAccumulatorState(startBtc);
      // Build state locally — avoids re-fetch race condition after insert
      state = {
        id:         "",
        holding:    "BTC",
        quantity:   startBtc,
        btc_value:  startBtc,
        switches:   0,
        updated_at: new Date().toISOString(),
      };
      console.log(`Accumulator initialised: ${startBtc.toFixed(6)} BTC`);
    }

    const currentBtcValue =
      state!.holding === "BTC"
        ? state!.quantity
        : state!.quantity * solBtcPrice;

    // Switch if signal changed
    if (targetAsset !== state!.holding) {
      let newQty: number;
      let newBtcValue: number;

      if (targetAsset === "SOL") {
        newQty      = state!.quantity / solBtcPrice;  // BTC qty → SOL qty
        newBtcValue = state!.quantity;                // BTC value unchanged at switch
      } else {
        newQty      = state!.quantity * solBtcPrice;  // SOL qty → BTC qty
        newBtcValue = newQty;
      }

      // For SOL→BTC, btcValueBefore should be what we had when we entered SOL
      // (not the mark-to-market now, which equals newBtcValue and always shows $0 gain)
      const entryBtcValue = targetAsset === "BTC"
        ? (await getLastSolEntryBtc()) ?? currentBtcValue
        : currentBtcValue;

      await Promise.all([
        updateAccumulatorState({
          holding:  targetAsset,
          quantity: newQty,
          btcValue: newBtcValue,
          switches: state!.switches + 1,
        }),
        logSwitch({
          from:           state!.holding,
          to:             targetAsset,
          solBtcPrice,
          btcValueBefore: entryBtcValue,
          btcValueAfter:  newBtcValue,
        }),
      ]);

      console.log(`SWITCH ${state!.holding} → ${targetAsset} | SOLBTC=${solBtcPrice.toFixed(6)} | BTC value: ${currentBtcValue.toFixed(6)} → ${newBtcValue.toFixed(6)}`);
    } else {
      // Update mark-to-market BTC value even when not switching
      await updateAccumulatorState({
        holding:  state!.holding,
        quantity: state!.quantity,
        btcValue: currentBtcValue,
        switches: state!.switches,
      });
      console.log(`HOLD ${state!.holding} | SOLBTC=${solBtcPrice.toFixed(6)} | BTC value: ${currentBtcValue.toFixed(6)} | uptrend=${uptrend}`);
    }

    return { holding: targetAsset, btcValue: currentBtcValue, uptrend, solBtcPrice };
  },
});
