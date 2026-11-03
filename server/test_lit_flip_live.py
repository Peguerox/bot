"""Tests for lit_flip_live.FlipBot against a fake exchange that really fills resting orders as price moves
(plain script: python3 test_lit_flip_live.py)."""
import asyncio, os
os.environ.setdefault("NEXT_PUBLIC_SUPABASE_URL", "http://x"); os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "x")
import lit_flip_core as F
import lit_flip_live as L

L.ACCOUNT_EVERY = 0.0; L.CANDLES_EVERY = 0.0; L.ORDERS_CHECK_EVERY = 0.0; L.MISMATCH_GRACE_S = 0.0; L.WATCH_REFIRE_S = 0.0; L.PUBLISH_EVERY = 0.0
PASS, FAIL = [], []


def check(name, ok, detail=None):
    (PASS if ok else FAIL).append(name)
    print(("  PASS  " if ok else "  FAIL  ") + name + ("" if ok or detail is None else f"   -> {detail}"))


class FakeEx:
    def __init__(self, price=3.0, equity=200.0, refuse_flip=False):
        self.price, self.equity = price, equity
        self.pos, self.entry = 0.0, None
        self.orders = []                       # dicts: kind limit/stop, is_ask, qty, price, reduce_only
        self.refuse_flip = refuse_flip
        self.sent = []
        self.trend = 1

    # adapter API
    async def account(self):
        return {"pos": self.pos, "entry": self.entry, "equity": self.equity + self._upnl()}

    async def candles(self, n=40):
        base = self.price
        return [{"t": i, "h": base - self.trend * (n - i) * 0.001 + 0.0005, "l": base - self.trend * (n - i) * 0.001 - 0.0005,
                 "c": base - self.trend * (n - i) * 0.001} for i in range(n)] + [{"t": n, "h": base, "l": base, "c": base}]

    async def market(self, is_ask, qty, ref, reduce_only=False):
        self.sent.append(("market", is_ask, round(qty, 2), reduce_only))
        self._fill(is_ask, qty, self.price, reduce_only); return None

    async def limit(self, is_ask, qty, price, reduce_only=True):
        self.orders.append(dict(kind="limit", is_ask=is_ask, qty=qty, price=price, reduce_only=reduce_only)); return None

    async def stop(self, is_ask, qty, trigger, reduce_only):
        if self.refuse_flip and not reduce_only:
            return "reduce only required"
        self.orders.append(dict(kind="stop", is_ask=is_ask, qty=qty, price=trigger, reduce_only=reduce_only)); return None

    async def cancel_all(self):
        self.orders = []; return None

    async def open_order_count(self):
        return len(self.orders)

    def best_bid_ask(self):
        return self.price - 0.0001, self.price + 0.0001

    # simulation
    def _upnl(self):
        return 0.0 if not self.pos else self.pos * (self.price - self.entry)

    def _fill(self, is_ask, qty, px, reduce_only):
        signed = -qty if is_ask else qty
        if reduce_only:
            signed = max(-abs(self.pos), min(abs(self.pos), signed)) if self.pos else 0
        old = self.pos; new = round(old + signed, 6)
        closed = min(abs(old), abs(signed)) if old and (old > 0) != (signed > 0) else 0
        if closed:
            self.equity += (px - self.entry) * (closed if old > 0 else -closed)
        if new == 0:
            self.entry = None
        elif old == 0 or (old > 0) != (new > 0):
            self.entry = px                    # opened fresh or flipped through zero
        elif abs(new) > abs(old):
            self.entry = (self.entry * abs(old) + px * abs(signed)) / abs(new)
        self.pos = new

    def move(self, price):
        self.price = price
        for o in list(self.orders):
            hit = (o["kind"] == "limit" and ((o["is_ask"] and price >= o["price"]) or (not o["is_ask"] and price <= o["price"]))) or \
                  (o["kind"] == "stop" and ((o["is_ask"] and price <= o["price"]) or (not o["is_ask"] and price >= o["price"])))
            if hit and o in self.orders:
                self.orders.remove(o)
                self._fill(o["is_ask"], o["qty"], o["price"], o["reduce_only"])


class FakeDB:
    def __init__(self):
        self.state = {"id": 1, "enabled": True, "close_requested": False}
        self.logs, self.trades = [], []

    async def get_state(self): return dict(self.state)
    async def update_state(self, patch): self.state.update(patch)
    async def log(self, action, detail): self.logs.append((action, detail))
    async def trade(self, row): self.trades.append(row)
    async def try_lock(self, owner): return True


async def _ticks(bot, n=2):
    for _ in range(n):
        await bot.tick()


async def t_start_flip_win():
    print("\n[start long on a rising range -> stop hit -> instant flip short x1.5 -> short target -> sequence won]")
    ex, db = FakeEx(), FakeDB(); bot = L.FlipBot(ex, db)
    L.asyncio.sleep = _nosleep
    await _ticks(bot, 1)
    check("opened LONG with ~$10 (3.33 LIT)", bot.pos is not None and bot.pos.side == F.LONG and abs(ex.pos - 3.33) < 0.02, ex.pos)
    kinds = sorted((o["kind"], o["reduce_only"]) for o in ex.orders)
    check("two orders resting: reduce-only target + NON-reduce-only flip", kinds == [("limit", True), ("stop", False)], kinds)
    flip = [o for o in ex.orders if o["kind"] == "stop"][0]
    check("flip = one SELL for current + next size", flip["is_ask"] and abs(flip["qty"] - (3.33 + 15 / 2.985)) < 0.03, flip)
    ex.move(2.985)                              # exchange fires the flip
    check("exchange position is now SHORT ~5 LIT in one fill", ex.pos < 0 and abs(abs(ex.pos) - 5.02) < 0.03, ex.pos)
    await _ticks(bot)
    check("bot follows: short, level 1", bot.pos.side == F.SHORT and bot.pos.level == 1, bot.pos)
    check("new target is a BUY 2% below the flip price", any(o["kind"] == "limit" and not o["is_ask"] and abs(o["price"] - 2.985 * 0.98) < 1e-6 for o in ex.orders))
    eq0 = 200.0
    db.state["enabled"] = False               # don't start the next sequence right away (the bot would, by design)
    ex.move(2.985 * 0.98)
    await _ticks(bot)
    check("sequence over, flat, no orders left", bot.pos is None and ex.pos == 0 and not ex.orders, (bot.pos, ex.pos, ex.orders))
    check("counted as a win", db.state.get("wins") == 1 and db.state.get("busts") == 0, db.state)
    check("money up after the flip+win", ex.equity > eq0, ex.equity)
    check("trade rows: one flip loss + one target win", [t["result"] for t in db.trades] == ["flip", "target"], db.trades)


async def t_watch_mode_fallback():
    print("\n[Lighter refuses the non-reduce-only stop -> watch mode fires ONE combined market order at the stop price]")
    ex, db = FakeEx(refuse_flip=True), FakeDB(); bot = L.FlipBot(ex, db)
    await _ticks(bot, 1)
    check("switched to watch mode", bot.flip_mode == "watch" and any(a == "flip_mode_watch" for a, _ in db.logs))
    check("only the target rests on the book", [o["kind"] for o in ex.orders] == ["limit"], ex.orders)
    ex.price = 2.985
    await bot.tick()
    sent = ex.sent[-1]
    check("one SELL market order for current + next size", sent[0] == "market" and sent[1] and abs(sent[2] - (3.33 + 5.02)) < 0.05 and not sent[3], sent)
    await _ticks(bot, 3)
    check("bot now short at level 1", bot.pos and bot.pos.side == F.SHORT and bot.pos.level == 1, bot.pos)
    check("fired exactly ONE combined order (no double flip)", sum(1 for x in ex.sent if x[0] == "market") == 2, ex.sent)


async def t_restart_keeps_the_sequence():
    print("\n[restart mid-sequence: a new bot reads the sequence from the state row and keeps managing it]")
    ex, db = FakeEx(), FakeDB(); bot = L.FlipBot(ex, db)
    await _ticks(bot, 1); ex.move(2.985); await _ticks(bot)
    bot2 = L.FlipBot(ex, db)
    await _ticks(bot2)
    check("restarted bot knows it is short at level 1", bot2.pos and bot2.pos.side == F.SHORT and bot2.pos.level == 1, bot2.pos)
    check("orders still there (re-placed if missing)", len(ex.orders) == 2, ex.orders)


async def t_off_keeps_position_flatten_closes():
    print("\n[OFF: no new sequence but an open position keeps its orders; Flatten closes everything]")
    ex, db = FakeEx(), FakeDB(); bot = L.FlipBot(ex, db)
    await _ticks(bot, 1)
    db.state["enabled"] = False
    await _ticks(bot)
    check("OFF: position still open with both orders", ex.pos > 0 and len(ex.orders) == 2)
    db.state["close_requested"] = True
    await _ticks(bot, 3)
    check("flatten: flat, no orders, OFF, request cleared", ex.pos == 0 and not ex.orders and db.state["close_requested"] is False and db.state["enabled"] is False,
          (ex.pos, ex.orders, db.state.get("close_requested")))
    ex2, db2 = FakeEx(), FakeDB(); db2.state["enabled"] = False; b2 = L.FlipBot(ex2, db2)
    await _ticks(b2)
    check("OFF and flat: never opens", ex2.pos == 0 and not ex2.sent)
    check("OFF still publishes the live signal, price and range for the panel",
          db2.state.get("live_signal") == F.LONG and db2.state.get("live_price") and db2.state.get("live_range_pos") is not None, db2.state)


async def t_bust_at_cap():
    print("\n[cap: 10 flips in a row -> last step has a reduce-only stop; hitting it ends the sequence as a bust]")
    ex, db = FakeEx(), FakeDB(); bot = L.FlipBot(ex, db)
    await _ticks(bot, 1)
    for _ in range(10):
        stop = [o for o in ex.orders if o["kind"] == "stop"][0]
        ex.move(stop["price"]); await _ticks(bot)
    check("at level 10", bot.pos and bot.pos.level == 10, bot.pos)
    stop = [o for o in ex.orders if o["kind"] == "stop"][0]
    check("last step's stop is reduce-only (no flip past the cap)", stop["reduce_only"], stop)
    ex.move(stop["price"]); await _ticks(bot)
    check("bust: flat, counted", ex.pos == 0 and db.state.get("busts") == 1 and bot.pos is None, (ex.pos, db.state.get("busts")))


async def t_unknown_position_is_protected():
    print("\n[a position the bot didn't open (e.g. manual) is adopted and protected right away]")
    ex, db = FakeEx(), FakeDB(); db.state["enabled"] = False
    ex._fill(False, 4.0, 3.0, False)
    bot = L.FlipBot(ex, db); await _ticks(bot, 1)
    check("adopted with target + flip on the book", bot.pos is not None and len(ex.orders) == 2, ex.orders)


async def t_ws_wake_and_rejected_flip():
    print("\n[websocket: an order event re-reads the position at once; a flip that triggered but was rejected is re-placed in ~3 s]")
    saved = (L.ACCOUNT_EVERY, L.ORDERS_CHECK_EVERY, L.ACCOUNT_EVERY_WS, L.ORDERS_CHECK_EVERY_WS, L.ORDERS_SETTLE_S)
    L.ACCOUNT_EVERY, L.ORDERS_CHECK_EVERY, L.ACCOUNT_EVERY_WS, L.ORDERS_CHECK_EVERY_WS, L.ORDERS_SETTLE_S = 3.0, 20.0, 10.0, 60.0, 0.0
    try:
        ex, db = FakeEx(), FakeDB(); ex.orders_ws_live = lambda: True; bot = L.FlipBot(ex, db)
        await _ticks(bot, 1)
        check("websocket live -> slow REST safety net (10 s / 60 s)", bot._account_every() == 10.0 and bot._orders_every() == 60.0)
        ex.move(2.985)                          # flip fills on the exchange
        await bot.tick()
        check("without an event the bot hasn't seen the flip yet", bot.pos.side == F.LONG)
        bot.wake(); await bot.tick()
        check("order event -> position re-read at once, now SHORT level 1", bot.pos.side == F.SHORT and bot.pos.level == 1, bot.pos)
        # the new flip triggers on the exchange but Lighter rejects it: the order is gone, position unchanged
        ex.orders = [o for o in ex.orders if o["kind"] != "stop"]
        bot.wake(); await bot.tick()
        check("rejected flip: missing order re-placed right after the event", sum(o["kind"] == "stop" for o in ex.orders) == 1, ex.orders)
        check("logged orders_missing_replaced", any(a == "orders_missing_replaced" for a, _ in db.logs))
        ex2 = FakeEx(); b2 = L.FlipBot(ex2, FakeDB())
        check("no websocket -> old REST cadence (3 s / 20 s)", b2._account_every() == 3.0 and b2._orders_every() == 20.0)
    finally:
        L.ACCOUNT_EVERY, L.ORDERS_CHECK_EVERY, L.ACCOUNT_EVERY_WS, L.ORDERS_CHECK_EVERY_WS, L.ORDERS_SETTLE_S = saved


async def _nosleep(*a, **k):
    return None


async def main():
    for t in (t_start_flip_win, t_watch_mode_fallback, t_restart_keeps_the_sequence, t_off_keeps_position_flatten_closes,
              t_bust_at_cap, t_unknown_position_is_protected, t_ws_wake_and_rejected_flip):
        await t()
    print(f"\n==== {len(PASS)} passed, {len(FAIL)} failed ====")

L.asyncio.sleep = _nosleep
asyncio.run(main())
raise SystemExit(1 if FAIL else 0)
