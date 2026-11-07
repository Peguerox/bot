"""Flip martingale -- pure decision logic (no exchange, no database), owner's strategy 2026-11-03.

Setting A (research/martingale-dca-2026-11-03/, picked on BTC 1-min 5y, held on HYPE and LIT):
  * Start a sequence when price is in the top `band` of its last `window` closed 1-min candles' high-low range
    (LONG) or the bottom `band` (SHORT). First trade = first_pct of equity.
  * Every trade: a TARGET at +tp% (reduce-only limit) and a FLIP at -sl% that closes the position AND opens the
    opposite side `mult` times bigger in ONE order (owner: "the flip has to be instant -- never close, then open").
  * The first target that fills ends the sequence; size resets.
  * Cap: no trade bigger than lev_cap x equity. When the NEXT flip would exceed it, the -sl% order is a plain
    reduce-only stop instead: the sequence ends with its loss ("bust") and the next one starts from first_pct.

This module only answers "what should be resting on the book right now"; lit_flip_live.py does the I/O.
"""
from dataclasses import dataclass, field
from typing import Optional, List

LONG, SHORT = 1, -1


@dataclass(frozen=True)
class Params:
    first_pct: float = 5.0        # first trade, % of equity
    mult: float = 1.5             # each flip is this many times the previous trade
    sl_pct: float = 0.5           # stop / flip distance from the entry, %
    tp_pct: float = 2.0           # target distance from the entry, %
    window: int = 30              # range window, closed 1-min candles
    band: float = 0.30            # top/bottom share of the range that counts as a trend
    lev_cap: float = 3.0          # biggest trade = lev_cap x equity
    min_order_usd: float = 10.0   # Lighter's minimum order value
    lock_from_step: float = 0.0   # deep-step profit lock (owner 2026-11-04): 0 = off; else from this step (1-based) on, once
    lock_profit_pct: float = 0.25 #   the open trade pays back the whole sequence + lock_profit_pct % of the account and is
    lock_arm_pct: float = 0.5     #   lock_arm_pct % past that, a stop locks it (target stays; flip removed);
    lock_trail_pct: float = 0.0   #   0 = fixed lock, >0 = raise it behind the peak by this %
    add_mode: float = 0.0         # 0 = FLIP to the other side at -sl%; 1 = ADD on the SAME side at -sl% (owner 2026-11-04, NEAR)
    trail_pct: float = 0.0        # 0 = off. >0: at the target don't close -- lock the target, trail the peak by this % (owner 2026-11-04)
    first_usd: float = 0.0        # 0 = first trade is first_pct of equity; >0 = first trade is this many USD (owner 2026-11-05: the
                                  #   cap still grows with the whole account, so steps grow as the account grows)
    last_sl_pct: float = 0.0      # 0 = the last step's bust stop is sl_pct away; >0 = this % instead (more room before a bust)
    flip_limit_pct: float = 0.0   # 0 = the flip is a stop-MARKET order; >0 = a stop-LIMIT that fills no worse than this % past the
                                  #   trigger (owner 2026-11-07: cut the ~0.04% flip slippage; the bot flips at market if it misses)


def range_signal(candles, window: int, band: float) -> int:
    """LONG / SHORT / 0 from the last `window` CLOSED candles (the last element of `candles` is the forming one).
    Candles are dicts with h/l/c. Not enough history -> 0 (never guesses)."""
    closed = candles[:-1][-window:]
    if len(closed) < window:
        return 0
    hi = max(c["h"] for c in closed)
    lo = min(c["l"] for c in closed)
    if hi <= lo:
        return 0
    pos = (closed[-1]["c"] - lo) / (hi - lo)
    if pos >= 1 - band:
        return LONG
    if pos <= band:
        return SHORT
    return 0


def range_info(candles, window: int):
    """(position 0..1, high, low) of the last closed price inside the last `window` closed candles, or Nones."""
    closed = candles[:-1][-window:]
    if len(closed) < window:
        return None, None, None
    hi = max(c["h"] for c in closed); lo = min(c["l"] for c in closed)
    return ((closed[-1]["c"] - lo) / (hi - lo) if hi > lo else 0.5), hi, lo


def ladder(equity: float, p: Params) -> List[float]:
    """Trade sizes in USD for one sequence: first_pct of equity, x mult each flip, while <= lev_cap x equity.
    Empty if even the first trade is under the exchange minimum."""
    if p.first_usd > 0:
        s = max(p.first_usd, p.min_order_usd)       # a fixed first trade (never under Lighter's minimum)
    else:
        s = equity * p.first_pct / 100.0
        if s < p.min_order_usd:
            return []
    sizes = []
    while s <= p.lev_cap * equity + 1e-9:
        sizes.append(s)
        s *= p.mult
    return sizes


@dataclass
class Position:
    side: int                 # LONG / SHORT
    qty: float                # base units (LIT), > 0
    entry: float              # average entry price of THIS trade
    level: int                # 0-based index into the sequence ladder
    ladder_usd: List[float] = field(default_factory=list)


@dataclass(frozen=True)
class Order:
    kind: str                 # "target" | "flip" | "stop"
    is_ask: bool              # True = sell
    qty: float                # base units
    price: float              # limit price (target) or trigger price (flip/stop)
    reduce_only: bool


def target_price(pos: Position, p: Params) -> float:
    return pos.entry * (1 + p.tp_pct / 100.0) if pos.side == LONG else pos.entry * (1 - p.tp_pct / 100.0)


def stop_pct(pos: Position, p: Params) -> float:
    """The stop distance for this level: sl_pct, or last_sl_pct (if set) at the last step (the bust stop)."""
    if p.last_sl_pct > 0 and pos.level >= len(pos.ladder_usd) - 1:
        return p.last_sl_pct
    return p.sl_pct


def stop_price(pos: Position, p: Params) -> float:
    d = stop_pct(pos, p)
    return pos.entry * (1 - d / 100.0) if pos.side == LONG else pos.entry * (1 + d / 100.0)


def next_qty(pos: Position, p: Params) -> Optional[float]:
    """Base units of the NEXT trade (opposite side) if the ladder allows one more step, else None (bust)."""
    nxt = pos.level + 1
    if nxt >= len(pos.ladder_usd):
        return None
    return pos.ladder_usd[nxt] / stop_price(pos, p)


def resting_orders(pos: Position, p: Params) -> List[Order]:
    """The two orders that must always be on the book while a position is open."""
    is_ask_close = pos.side == LONG                 # closing a long = sell
    orders = [Order("target", is_ask_close, pos.qty, target_price(pos, p), True)]
    nq = next_qty(pos, p)
    if nq is None:
        orders.append(Order("stop", is_ask_close, pos.qty, stop_price(pos, p), True))
    else:
        # ONE order: closes pos.qty and opens nq on the other side.
        orders.append(Order("flip", is_ask_close, pos.qty + nq, stop_price(pos, p), False))
    return orders


def add_price(pos: Position, p: Params) -> float:
    """Add mode: the next level's price = this level's stop price (a resting LIMIT on the same side, no slippage)."""
    return stop_price(pos, p)


def add_qty(pos: Position, p: Params) -> Optional[float]:
    """Add mode: base units to ADD at the next level so the whole position equals the next ladder size there (the same money
    as closing at the stop and re-opening the same side mult x bigger). None at the last step (-> bust stop)."""
    nxt = pos.level + 1
    if nxt >= len(pos.ladder_usd):
        return None
    return max(0.0, pos.ladder_usd[nxt] / add_price(pos, p) - pos.qty)


def resting_orders_add(pos: Position, p: Params) -> List[Order]:
    """Add mode: target (reduce-only limit, whole position, tp from this LEVEL's price) + add (same-side limit at the stop
    price, NOT reduce-only), or at the last step a reduce-only stop for everything (bust)."""
    close_is_ask = pos.side == LONG
    orders = [Order("target", close_is_ask, pos.qty, target_price(pos, p), True)]
    aq = add_qty(pos, p)
    if aq is None:
        orders.append(Order("stop", close_is_ask, pos.qty, stop_price(pos, p), True))
    else:
        orders.append(Order("add", not close_is_ask, aq, add_price(pos, p), False))
    return orders


def after_flip(pos: Position, fill_price: float, p: Params) -> Position:
    """Position right after the flip order filled at `fill_price`."""
    nq = next_qty(pos, p)
    assert nq is not None, "flip without a next ladder step"
    return Position(side=-pos.side, qty=nq, entry=fill_price, level=pos.level + 1, ladder_usd=pos.ladder_usd)


def start(signal: int, price: float, equity: float, p: Params) -> Optional[Position]:
    """A new sequence's first position (market entry at `price`), or None if no signal / too small."""
    if signal == 0:
        return None
    lad = ladder(equity, p)
    if not lad:
        return None
    return Position(side=signal, qty=lad[0] / price, entry=price, level=0, ladder_usd=lad)
