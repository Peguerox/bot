"""Desired-state order engine for the LIT grid (engine v2, 2026-10-22).

The v1 order logic trusted its own ledger about what was resting on the exchange. Every way that
belief could go wrong -- a 429, a timeout, a restart, a half-finished rebuild -- left a mess it
could not see: ghost orders that blocked a slot, orphans still live on the book, gaps in the
ladder. v2 follows the standard grid design (Bitsgap's included): every cycle,

  1. read what is ACTUALLY resting (the exchange is the truth, not the ledger),
  2. compute what SHOULD be resting from scratch (pure functions below, no memory of the past),
  3. diff the two and send every change in one batch.

Whatever state a crash, a fast move or a rate-limit storm leaves behind, the next cycle walks it
back to the target. The ledger keeps the job it is good at: fills and each lot's real cost.

Grid rules (the owner's, unchanged from v1 unless noted):
  - Line prices are exp(anchor_log + line * step), step = ln(1 + spacing). Stored as a log so a
    re-anchor can never overflow (v1's anchor = price / exp(offset*step) refused past 600).
  - Buys sit on the `levels_down` free lines strictly below price, nearest first. A line holding a
    lot never gets a second buy.
  - Every held lot's sell = max(line above the lot, its cost): never below cost. A lot whose sell
    is already below price is sold at market, floored at cost.
  - Only the `levels_up` sells nearest to price rest on the book; far ones wait until they rank.
  - Every fill gets its reaction first: a buy filled on L -> its sell on L+1; a sell filled ->
    the buy back on its line. Orders go out nearest to price first, sell before buy.
  - No market buys (2026-10-23, after v2's trailing market buys opened holes on both bots).
"""
import math
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Want:
    side: str                 # "buy" | "sell"
    price: float              # already rounded to the exchange's price precision
    size: float
    line: int                 # grid line the order rests on (buy) / the lot's line (sell)
    closes_line: int = None   # sells only: the lot this sell closes
    funded: float = 0.0       # buys only: dollars of this buy drawn from the cover-drop bucket


@dataclass
class Plan:
    sells: list = field(default_factory=list)          # [Want] resting sells, nearest first
    market_sells: list = field(default_factory=list)   # [(line, qty, cost)] sell now, floor at cost
    buy_lines: list = field(default_factory=list)      # [(line, price)] nearest first; caller sizes/funds


def line_price(anchor_log, line, step):
    return math.exp(anchor_log + line * step)


def line_at_or_below(price, anchor_log, step):
    """Highest line whose price is <= price (1e-9 guards exact-boundary float noise)."""
    return math.floor((math.log(price) - anchor_log) / step + 1e-9)


def sell_target(line, cost, anchor_log, step, spacing_frac, round_price):
    """A lot on line L sells on line L+1 -- never below what it cost (rule 1). A lot bought on its
    line (every limit buy) costs exactly that line, so this is simply L+1; only a lot that cost
    more than its line+1 (old market buys) waits at its cost, rounded UP to the price tick."""
    tgt = line_price(anchor_log, line + 1, step)
    floor = math.ceil(cost * 10 ** 4 - 1e-6) / 10 ** 4
    return max(round_price(tgt), floor)


def plan_orders(price, anchor_log, step, spacing_frac, lots, levels_up, levels_down,
                round_price, entries_allowed=True, reserved=()):
    """The target ladder, from scratch every cycle. `lots` = {line: {"qty", "cost"}} of sellable
    lots. `reserved` = lines whose buy is still open or settling (never a second buy there).

      - every lot: one sell at sell_target (L+1, never below cost); a target already at or below
        price is sold at market (never below cost) -- the move passed it;
      - only the `levels_up` sells nearest to price rest on the book;
      - one buy on each of the `levels_down` free lines strictly below price, nearest first.
    No market buys, ever. Pure: same inputs, same output."""
    plan = Plan()
    cur = line_at_or_below(price, anchor_log, step)

    targets = sorted((sell_target(ln, h["cost"], anchor_log, step, spacing_frac, round_price), ln)
                     for ln, h in lots.items())
    resting = []
    for tgt, ln in targets:
        if tgt <= price:
            plan.market_sells.append((ln, lots[ln]["qty"], lots[ln]["cost"]))
        else:
            resting.append(Want("sell", tgt, lots[ln]["qty"], ln, closes_line=ln))
    plan.sells = resting[:levels_up]
    sell_prices = {w.price for w in plan.sells}

    held = set(lots) | set(reserved)
    ln = cur
    if line_price(anchor_log, ln, step) >= price:
        ln -= 1
    guard = 0
    while len(plan.buy_lines) < levels_down and guard < levels_down * 4 + len(held) + 10:
        guard += 1
        px = round_price(line_price(anchor_log, ln, step))
        if ln not in lots and px not in sell_prices and px < price:
            plan.buy_lines.append((ln, px))
        ln -= 1
    return plan


def priority_order(wants, price):
    """Direct request: whenever orders can go out, the first is the sell right above price, then
    the buy right below, then the next sell, the next buy, outward. Sells lead each pair."""
    sells = sorted((w for w in wants if w.side == "sell"), key=lambda w: w.price)
    buys = sorted((w for w in wants if w.side == "buy"), key=lambda w: -w.price)
    out = []
    for i in range(max(len(sells), len(buys))):
        if i < len(sells):
            out.append(sells[i])
        if i < len(buys):
            out.append(buys[i])
    return out


def diff_orders(wants, actual, inflight, price_to_int):
    """wants: [Want]. actual: [{"side", "price", "order_index", "client_order_index",
    "closes_line"}] resting on the exchange (closes_line from the ledger, sells only).
    inflight: set of (side, price_int) sent recently and not visible yet.
    A sell matches only a resting sell of the SAME lot at the same price (2026-10-23: two lots
    whose sells shared a price -- one lot's order counted as the other's, and the real one was
    never placed). Buys match by price. Returns (to_cancel, to_place)."""
    def want_key(w):
        return (w.side, price_to_int(w.price), w.closes_line if w.side == "sell" else None)

    def have_key(o):
        return (o["side"], price_to_int(float(o["price"])), o.get("closes_line") if o["side"] == "sell" else None)

    want_by_key = {}
    for w in wants:
        want_by_key.setdefault(want_key(w), w)
    seen = set()
    to_cancel = []
    for o in actual:
        key = have_key(o)
        if key in want_by_key and key not in seen:
            seen.add(key)
        else:
            to_cancel.append(o)
    to_place = [w for key, w in want_by_key.items()
                if key not in seen and (w.side, price_to_int(w.price)) not in inflight]
    return to_cancel, to_place
