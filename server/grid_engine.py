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
  - Every held lot's sell = max(line above the lot, cost * (1 + spacing)): at least one full step
    of profit, never below cost. A lot whose sell is already below price is sold at market,
    floored at cost.
  - Only the `levels_up` sells nearest to price rest on the book; far ones wait until they rank.
  - Always a sell right above price (direct request): if fewer than `levels_up` sells sit within
    the first `levels_up` lines above price, buy one lot at market (trailing up) -- its sell lands
    one full step above the price paid.
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
    trail_line: int = None                             # line for a trailing-up market buy, or None


def line_price(anchor_log, line, step):
    return math.exp(anchor_log + line * step)


def line_at_or_below(price, anchor_log, step):
    """Highest line whose price is <= price (1e-9 guards exact-boundary float noise)."""
    return math.floor((math.log(price) - anchor_log) / step + 1e-9)


def sell_target(line, cost, anchor_log, step, spacing_frac, round_price):
    return round_price(max(line_price(anchor_log, line + 1, step), cost * (1 + spacing_frac)))


def plan_orders(price, anchor_log, step, spacing_frac, lots, levels_up, levels_down,
                round_price, entries_allowed=True):
    """The target ladder. `lots` = {line: {"qty", "cost"}} of sellable lots (dust already removed).
    Pure: same inputs, same output, so the diff never churns orders that are already right."""
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

    if entries_allowed:
        window_top = line_price(anchor_log, cur + levels_up + 1, step)
        near = sum(1 for w in plan.sells if w.price <= window_top)
        if near < levels_up:
            ln = cur
            while ln in lots:
                ln += 1
            plan.trail_line = ln

    held = set(lots)
    if plan.trail_line is not None:
        held.add(plan.trail_line)
    ln = cur
    if line_price(anchor_log, ln, step) >= price:
        ln -= 1
    guard = 0
    while len(plan.buy_lines) < levels_down and guard < levels_down * 4 + len(held) + 10:
        guard += 1
        px = round_price(line_price(anchor_log, ln, step))
        if ln not in held and px not in sell_prices and px < price:
            plan.buy_lines.append((ln, px))
        ln -= 1
    return plan


def diff_orders(wants, actual, inflight, price_to_int):
    """wants: [Want]. actual: [{"side", "price", "order_index", "client_order_index"}] resting on
    the exchange. inflight: set of (side, price_int) sent recently and not visible yet.
    Returns (to_cancel, to_place): everything resting that is not wanted (orphans, stale prices,
    far orders, duplicates), and everything wanted that is neither resting nor in flight."""
    want_by_key = {}
    for w in wants:
        want_by_key.setdefault((w.side, price_to_int(w.price)), w)
    seen = set()
    to_cancel = []
    for o in actual:
        key = (o["side"], price_to_int(float(o["price"])))
        if key in want_by_key and key not in seen:
            seen.add(key)
        else:
            to_cancel.append(o)
    to_place = [w for key, w in want_by_key.items() if key not in seen and key not in inflight]
    return to_cancel, to_place


def nearest_first(wants, price):
    return sorted(wants, key=lambda w: abs(w.price - price))
