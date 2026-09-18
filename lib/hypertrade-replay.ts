// Pure replay of server/sol-hypertrade-paper.ts's exact DCA-grid decision logic, for the
// dashboard's Backtest comparison column. The live bot reacts to every real order-book tick;
// this replay uses 1-min OHLC (high/low, not just close) so within-candle DCA/TP crossings aren't
// missed -- matching this session's established "1-min HL execution" backtest convention. Ties
// within the same candle resolve DCA-before-TP, exactly matching the live code's own documented
// tie-break ("adverse fills first (DCA), then favorable (TP)"). Assumes fills AT the crossed
// trigger price (not the candle close). Zero cost per fill -- verified against a real completed
// cycle (entry cost=$14.3232, exit proceeds=$14.5447): real proceeds matches
// total_cost*(1+tpPct/100) almost exactly (within $0.0035, pure execution noise), meaning the
// recorded total_cost/proceeds are already effectively fee-exclusive (matches the strategy docs'
// own "0% commission" assumption) -- adding a cost assumption here would only bias this replay
// away from what the real DB rows actually reflect.

import { multForLevel, dropPctForLevel, tpPctForLevel } from "./sol-hypertrade-config";

export type Candle = { time: number; open: number; high: number; low: number; close: number };
export type HypertradeFill = { action: "ENTRY" | "DCA" | "EXIT"; level: number; price: number; time: number };

type Position = { price: number; usdSize: number };

export function runHypertradeReplay(candles: Candle[], seedUsd: number): { fills: HypertradeFill[]; totalReturnPct: number } {
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

  for (const c of candles) {
    if (level === 0) { enter(c.open, c.time); continue; }

    // Conservative tie-break within this candle: keep DCA-adding while the low has breached the
    // next trigger, THEN check TP against the high -- matches the live comment's own documented
    // ordering. A single big-range candle can cross multiple DCA levels in one pass, same as the
    // live "while (ask <= nextDcaTrigger())" loop.
    let guard = 0;
    while (c.low <= nextDcaTrigger() && guard++ < 50) {
      dcaAdd(nextDcaTrigger(), c.time);
    }
    if (level > 0) {
      const tp = tpExitPrice();
      if (c.high >= tp) {
        exit(tp, c.time);
        enter(c.open, c.time); // continuous grid: immediately re-enter, matches live exitCycle()
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
