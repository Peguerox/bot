# Problem: optimal DCA-martingale sizing for a continuous grid strategy

## Data

`binance_global_solusdt_1m_5yr.csv` — 2,678,022 rows, 1-minute OHLCV candles for SOL/USDT on
Binance, 2021-08-08 to 2026-09-11 (~5 years). Columns: `datetime, open, high, low, close, volume`.

## Strategy mechanics

Long-only, always in a position, no directional signal — re-enter immediately after every close.

**State**: a list of open "legs" `[(price_1, size_1), (price_2, size_2), ...]`, where `size_i` is
the dollar amount committed at leg `i`, and `qty_i = size_i / price_i` is the quantity bought.

**Entry** (leg 1): buy `size_1 = BASE` dollars at the current price.

**DCA rescue** (legs 2+): if price falls to `last_entry_price * (1 - DCA_STEP_PCT / 100)`, buy
another leg there. Leg `i`'s size is `size_i = f(i)` for some sizing function `f` — in every
version tested so far, `f(i) = BASE * MULT^(i-1)` (geometric growth), but `f` could be anything.
No cap on how many legs can stack (uncapped depth).

**Exit**: once the *blended* portfolio value crosses a take-profit target, sell everything and
start a fresh leg-1 cycle. Formally, with `total_cost = sum(size_i)` and `total_qty = sum(qty_i)`:

```
tp_target_dollars = total_cost * (1 + TP_PCT / 100)
exit_price = tp_target_dollars / total_qty      # the blended average cost, +TP_PCT
```

Exit fires when `high >= exit_price` on a 1-minute bar (checked after processing any DCA fills
that bar first — DCA is resolved before TP within the same candle, as a conservative tie-break).

**Fills**: DCA fills at the exact trigger price (a real touched price, since `low <= trigger` is
the fire condition); a small round-trip slippage (~0.02%/side, i.e. crossing the spread) is
applied on every fill, buy and sell.

## Variables

| Symbol | Meaning | Values tested so far |
|---|---|---|
| `DCA_STEP_PCT` | % drop from last entry that triggers the next leg | 0.05% – 3.0% |
| `MULT` | geometric growth rate of leg size, `size_i = BASE * MULT^(i-1)` | 1.0 (flat) – 2.0 |
| `TP_PCT` | % above blended cost that triggers exit | 0.05% – 5.0% |
| `BASE` | dollar size of leg 1 | arbitrary (linear scale factor) |
| slippage | round-trip cost per fill, modeled as spread-crossing | 0.02%/side (empirical) |

No hard stop-loss exists in any version tested — the strategy's only way to realize a loss is if
the test window ends while a cycle is still open and underwater (never happens if given enough
time/capital, by construction, *unless* capital runs out first).

## The real constraint: capital, not %

Every "% return" number is meaningless without pinning down how it's divided. The actual
constraints that matter:

- **`max_levels`**: the deepest a single cycle's leg count ever reached across the historical
  data, for a given `(DCA_STEP_PCT, MULT)` pair.
- **`capital_needed = BASE * sum(MULT^i for i in range(max_levels))`**: the total dollars that
  must be reserved to survive that worst historical cycle *without ever being unable to add the
  next leg*. If capital runs out mid-cycle, the strategy silently degrades into a different,
  weaker one (hold-and-hope on a smaller position) — this was confirmed empirically: capping at
  $10,000 vs the true $498,689 needed at one tested config produced wildly different-looking
  results, because the capped version simply isn't running the same strategy anymore.
- **Return should be measured as**: total profit over the test period, divided by
  `capital_needed` (the worst case that actually occurred), never against an assumed/optimistic
  capital figure smaller than what the historical data actually required.

## The empirical puzzle (why we're asking for outside help)

1. **`MULT` trades off level-count vs. per-level cost.** A higher `MULT` needs *fewer* levels to
   recover from a given price decline (each add pulls the blended average down harder, toward
   the most recent/lowest price, since a geometrically-larger add dominates the weighted
   average). But each level also costs geometrically more. Empirically this trade-off is
   **non-monotonic** — `MULT=1.15` needed *more* levels than `MULT=1.2` (31 vs 28) for the same
   `DCA_STEP_PCT=1.0`, yet needed *less* total capital ($501 vs $819), because the slower
   compounding rate mattered more than the extra levels. We don't have a closed-form
   understanding of where this optimum sits — it was found by brute-force grid search, and
   different (`DCA_STEP_PCT`, `MULT`) grid points gave inconsistent rankings depending on which
   slice of the 5 years was tested.

2. **`MULT=1.0` (flat sizing) provably underperforms**, and we understand *why* mechanically: with
   equal-sized legs, the blended average cost converges toward the true recent price only as
   `O(1/N)` (each new leg is "one vote out of N," diluted by all prior higher-priced legs). With
   geometric `MULT > 1`, the average converges much faster because later legs dominate the
   weighted sum. This is a clean, provable difference in convergence rate — but we don't have a
   formal proof or formula for *how much* `MULT` is needed to guarantee the average cost tracks
   within `TP_PCT` of the local price minimum within a bounded number of legs, for a given
   historical volatility/drawdown distribution.

3. **`TP_PCT` interacts with `max_levels` in a way that isn't simply "wider is safer" or
   "tighter is safer."** At fixed `DCA_STEP_PCT=2%, MULT=1.5`, real (uncapped) capital needed to
   survive the worst historical cycle was: **flat at $12,875 for `TP_PCT` in {0.1, 0.2, 0.3}**,
   then jumped to $29,093 at 0.4%, $43,689 at 0.5%, and $498,689 at 1.0-1.5% — a step function,
   not a smooth curve, and we don't have a mechanistic explanation for exactly where the jumps
   happen or why they're not monotonic in a simple way.

## What we want

A framework (closed-form if possible, otherwise a principled numerical method — not another grid
search) that, given the empirical distribution of drawdown depth/duration/recovery-shape in the
attached 5-year SOL dataset, can:

(a) derive the minimum `capital_needed` for a chosen `(DCA_STEP_PCT, MULT, TP_PCT)` without brute-
force backtesting every historical window, and/or

(b) derive an optimal (possibly non-geometric) sizing function `f(i)` that minimizes
`capital_needed` for a target `TP_PCT` and `DCA_STEP_PCT`, subject to the constraint that the
blended average cost must stay reachable (within `TP_PCT`) after a bounded number of legs during
the worst historical decline, and/or

(c) explain the non-monotonic relationships found empirically (point 1 and 3 above) from first
principles, so we can trust the answer generalizes beyond the specific historical windows we
happened to test.
