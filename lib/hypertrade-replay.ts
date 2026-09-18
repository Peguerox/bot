// Pure replay of server/sol-hypertrade-paper.ts's exact DCA-grid decision logic, for the
// dashboard's Backtest comparison column. The live bot's DCA/TP conditions check the real order
// book's best bid/ask continuously -- this replay uses 1-min candle CLOSE only (NOT high/low)
// as an approximation of that. High/low was tried first (matching this session's established
// "1-min HL execution" convention from the original multi-year statistical backtest) but proved
// too eager here: verified against a real cycle where the high/low version exited a full HOUR
// before the real bot did, because a single small trade briefly printed at the TP price without
// the actual best bid sustaining there. Close is a closer (if imperfect) proxy for what a
// continuously-monitoring real order book actually sustained. Ties within the same candle resolve
// DCA-before-TP, matching the live code's own documented tie-break ("adverse fills first (DCA),
// then favorable (TP)"). Zero cost per fill -- verified against a real completed
// cycle (entry cost=$14.3232, exit proceeds=$14.5447): real proceeds matches
// total_cost*(1+tpPct/100) almost exactly (within $0.0035, pure execution noise), meaning the
// recorded total_cost/proceeds are already effectively fee-exclusive (matches the strategy docs'
// own "0% commission" assumption) -- adding a cost assumption here would only bias this replay
// away from what the real DB rows actually reflect.

import { multForLevel, dropPctForLevel, tpPctForLevel } from "./sol-hypertrade-config";

export type Candle = { time: number; open: number; high: number; low: number; close: number };
export type HypertradeFill = { action: "ENTRY" | "DCA" | "EXIT"; level: number; price: number; time: number };

type Position = { price: number; usdSize: number };

// `firstEntry`, when given, seeds the very first position directly at the bot's REAL first entry
// time+price instead of letting the loop auto-enter at candles[0]. This matters: the live worker
// process can boot (and start logging runs) well before it places its first real trade -- e.g. a
// wallet/book-WS readiness wait, or a deliberate delay before real money was moved onto it. Found
// via a real ~18-hour gap between this bot's process-boot timestamp and its actual first fill;
// seeding at the arbitrary boot-time candle instead of the real entry cascaded into many extra
// spurious cycles by the time the replay reached "now", since every subsequent cycle's timing
// depends on where the previous one exited.
export function runHypertradeReplay(candles: Candle[], seedUsd: number, firstEntry?: { time: number; price: number }): { fills: HypertradeFill[]; totalReturnPct: number } {
  const fills: HypertradeFill[] = [];
  if (candles.length === 0) return { fills, totalReturnPct: 0 };

  let realizedPnlUsd = 0;
  let positions: Position[] = [];
  let level = 0;
  let lastEntryPrice: number | null = null;
  let totalCost = 0;

  function currentBaseSizeUsd(): number {
    return (seedUsd + realizedPnlUsd) / 35; // RESERVE_DIVISOR, matches lib/sol-hypertrade-config.ts
  }
  function totalQty(): number {
    // reconstruct qty from cost/price per leg (usdSize / price), since only usdSize is tracked
    return positions.reduce((s, p) => s + p.usdSize / p.price, 0);
  }
  function tpExitPrice(): number {
    const t = tpPctForLevel(level);
    const avgCost = totalCost / totalQty();
    return avgCost * (1 + t / 100);
  }
  function nextDcaTrigger(): number {
    const d = dropPctForLevel(level + 1);
    return lastEntryPrice! * (1 - d / 100);
  }
  function enter(price: number, time: number) {
    const size = currentBaseSizeUsd();
    positions = [{ price, usdSize: size }];
    totalCost = size; level = 1; lastEntryPrice = price;
    fills.push({ action: "ENTRY", level: 1, price, time });
  }
  function dcaAdd(price: number, time: number) {
    const newLevel = level + 1;
    const lastLegSize = positions[positions.length - 1].usdSize;
    const size = lastLegSize * multForLevel(newLevel);
    positions.push({ price, usdSize: size });
    totalCost += size; level = newLevel; lastEntryPrice = price;
    fills.push({ action: "DCA", level: newLevel, price, time });
  }
  function exit(price: number, time: number) {
    const qty = totalQty();
    const proceeds = qty * price;
    const pnl = proceeds - totalCost;
    realizedPnlUsd += pnl;
    fills.push({ action: "EXIT", level, price, time });
    positions = []; level = 0; lastEntryPrice = null; totalCost = 0;
  }

  let seeded = false;
  for (const c of candles) {
    if (!seeded) {
      if (firstEntry) {
        if (c.time < firstEntry.time) continue; // skip candles before the real first entry
        enter(firstEntry.price, firstEntry.time);
      }
      seeded = true;
      if (firstEntry) continue;
    }
    if (level === 0) { enter(c.close, c.time); continue; }

    // Uses CLOSE, not high/low, to detect crossings -- verified against real fills that using the
    // candle's high/low fires early: a real trade can briefly print at a price without the order
    // book's actual best bid/ask (what the live bot's DCA/TP conditions check) sustaining there.
    // Found via a real cycle where the high/low version exited a full HOUR before the real bot did
    // (a momentary trade spike, not a real bid-side move) -- close is a closer proxy for "the
    // price a continuously-monitoring real order book actually sustained."
    let guard = 0;
    while (c.close <= nextDcaTrigger() && guard++ < 50) {
      dcaAdd(nextDcaTrigger(), c.time);
    }
    if (level > 0) {
      const tp = tpExitPrice();
      if (c.close >= tp) {
        exit(tp, c.time);
        enter(c.close, c.time); // continuous grid: immediately re-enter, matches live exitCycle()
      }
    }
  }

  // mark any still-open cycle to the last close, so an in-progress position isn't silently dropped
  let finalValue = seedUsd + realizedPnlUsd;
  if (level > 0) {
    const lastClose = candles[candles.length - 1].close;
    const qty = totalQty();
    finalValue = finalValue - totalCost + qty * lastClose;
  }
  return { fills, totalReturnPct: (finalValue / seedUsd - 1) * 100 };
}
