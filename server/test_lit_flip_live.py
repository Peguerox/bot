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

    cancel_fails = 0                           # tests: how many cancel_all calls are silently ignored by the "exchange"

    async def cancel_all(self):
        if self.cancel_fails > 0:
            self.cancel_fails -= 1; return None
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
    check("flatten is recorded: a 'flatten' trade row + sequence counted", any(t["result"] == "flatten" for t in db.trades)
          and db.state.get("sequences") == 1, (db.trades, db.state.get("sequences")))
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


async def t_stale_flip_never_left_behind():
    print("\n[target fills but the first cancels are ignored: the bot retries until the old flip order is gone, never starts on top of it]")
    ex, db = FakeEx(), FakeDB(); bot = L.FlipBot(ex, db)
    await _ticks(bot, 1)
    ex.cancel_fails = 4                         # 3 tries in _sequence_over all fail, the 4th (next tick) too
    ex.move(3.0 * 1.02)                         # target fills -> flat, the non-reduce-only flip still rests
    await bot.tick()
    check("sequence over but cancel unverified -> flagged, logged", bot.cancel_pending and any(a == "cancel_unverified" for a, _ in db.logs))
    check("no new sequence while the stale flip rests", ex.pos == 0, ex.pos)
    await bot.tick()
    check("next tick: cancel goes through, book is clean before anything new", not ex.orders or bot.pos is not None, ex.orders)
    check("flag cleared", not bot.cancel_pending)
    ex2, db2 = FakeEx(), FakeDB(); b2 = L.FlipBot(ex2, db2); await _ticks(b2, 1)
    ex2.orders.append(dict(kind="stop", is_ask=False, qty=9.0, price=9.9, reduce_only=False))   # a leftover order
    await b2.tick()
    check("an extra resting order is detected and the book re-placed with just ours", len(ex2.orders) == 2
          and any(a == "orders_extra_replaced" for a, _ in db2.logs), ex2.orders)


async def t_panel_settings_next_sequence_only():
    print("\n[panel settings: a new target applies from the NEXT sequence; the open one keeps its own; bad values ignored; survives restart]")
    ex, db = FakeEx(), FakeDB(); bot = L.FlipBot(ex, db)
    await _ticks(bot, 1)
    tgt0 = [o for o in ex.orders if o["kind"] == "limit"][0]["price"]
    db.state["override_params"] = {"tp_pct": 1.0, "first_pct": 10}
    await _ticks(bot, 2)
    tgt1 = [o for o in ex.orders if o["kind"] == "limit"][0]["price"]
    check("open sequence keeps its 2% target after the panel change", abs(tgt0 - 3.06) < 1e-9 and abs(tgt1 - tgt0) < 1e-9, (tgt0, tgt1))
    check("panel readout shows what the next sequence will use", db.state["live_params"]["tp_pct"] == 1.0 and db.state["live_params"]["first_pct"] == 10)
    bot2 = L.FlipBot(ex, db); await _ticks(bot2, 1)
    check("restart mid-sequence: still the sequence's own 2% (seq_params)", bot2.p.tp_pct == 2.0 and db.state["seq_params"]["tp_pct"] == 2.0, bot2.p)
    db.state["enabled"] = False
    ex.move(3.06); await _ticks(bot2, 2)
    db.state["enabled"] = True; await _ticks(bot2, 1)
    tgt2 = [o for o in ex.orders if o["kind"] == "limit"][0]
    check("next sequence: 1% target and a 10% first trade", bot2.p.tp_pct == 1.0 and abs(tgt2["qty"] - L.qty_round(ex.equity * 0.10 / 3.06)) < 0.02,
          (bot2.p, tgt2))
    db.state["override_params"] = {"tp_pct": 0.3, "sl_pct": 0.5, "mult": 99}
    check("invalid (target <= stop, mult out of range) -> defaults kept", bot2._params_from_state(db.state).tp_pct == 2.0
          and bot2._params_from_state(db.state).mult == 1.5)


async def t_failed_placement_rechecked_fast():
    print("\n[after a flip the first placement fails (e.g. nonce): no duplicate trade row, orders back within the quick re-check]")
    ex, db = FakeEx(), FakeDB(); bot = L.FlipBot(ex, db)
    await _ticks(bot, 1)
    real_limit = ex.limit
    fails = {"n": 1}
    async def flaky_limit(*a, **k):
        if fails["n"] > 0:
            fails["n"] -= 1; raise RuntimeError("code=21104 message='invalid nonce'")
        return await real_limit(*a, **k)
    ex.limit = flaky_limit
    ex.move(2.985)                              # flip fills on the exchange
    await _ticks(bot, 3)
    flips = [t for t in db.trades if t["result"] == "flip"]
    check("flip recorded exactly once", len(flips) == 1, flips)
    check("target + flip on the book after the re-check", sorted(o["kind"] for o in ex.orders) == ["limit", "stop"], ex.orders)


async def t_compounding_off():
    print("\n[compounding OFF: sizes from the fixed amount, not the bigger account; ON (default) uses the whole account]")
    ex, db = FakeEx(equity=400.0), FakeDB(); db.state["override_params"] = {"fixed_base_usd": 250}
    bot = L.FlipBot(ex, db); await _ticks(bot, 1)
    check("first trade = 5% of $250 (not of $400)", abs(bot.pos.ladder_usd[0] - 12.5) < 1e-9 and abs(ex.pos - L.qty_round(12.5 / 3.0)) < 0.02, bot.pos)
    check("readout shows the fixed amount", db.state["live_params"]["fixed_base_usd"] == 250)
    ex2, db2 = FakeEx(equity=400.0), FakeDB(); b2 = L.FlipBot(ex2, db2); await _ticks(b2, 1)
    check("default compounding: 5% of the whole $400", abs(b2.pos.ladder_usd[0] - 20.0) < 1e-9, b2.pos)
    ex3, db3 = FakeEx(equity=150.0), FakeDB(); db3.state["override_params"] = {"fixed_base_usd": 5000}
    b3 = L.FlipBot(ex3, db3); await _ticks(b3, 1)
    check("fixed amount above the real account -> never sizes beyond the real $150 (too small, no trade)", ex3.pos == 0)


async def t_waf_block_backs_off():
    print("\n[Lighter firewall 405: reads pause and back off (logged once), resume after; orders untouched]")
    ex, db = FakeEx(), FakeDB(); bot = L.FlipBot(ex, db)
    await _ticks(bot, 1)
    orders_before = list(ex.orders)
    real_acct = ex.account; calls = {"n": 0}
    async def blocked(*a, **k):
        calls["n"] += 1; raise RuntimeError("(405)\nReason: Not Allowed")
    ex.account = blocked
    await _ticks(bot, 5)
    check("one 405 -> reads paused: 1 request, not 5", calls["n"] == 1, calls["n"])
    check("logged once as lighter_blocked_backoff, no flood of read errors",
          sum(a == "lighter_blocked_backoff" for a, _ in db.logs) == 1 and not any(a == "account_read_failed" for a, _ in db.logs))
    check("resting orders untouched during the pause", ex.orders == orders_before)
    ex.account = real_acct; bot.blocked_until = 0.0
    await _ticks(bot, 1)
    check("after the pause: reads work again, backoff reset", bot.block_wait == L.BLOCK_BACKOFF_S and bot.pos is not None)


async def t_trail_after_target():
    print("\n[trail after target 0.5%: no target limit; at +2% the flip goes, a stop locks 2%; it rises with the peak; exit = a bigger win]")
    ex, db = FakeEx(), FakeDB(); db.state["override_params"] = {"trail_pct": 0.5}
    bot = L.FlipBot(ex, db); await _ticks(bot, 1)
    check("before the target: only the flip rests (no limit that would close at 2%)", [o["kind"] for o in ex.orders] == ["stop"]
          and not ex.orders[0]["reduce_only"], ex.orders)
    ex.price = 3.07; await bot.tick()
    o = ex.orders
    check("target reached -> armed: one reduce-only stop at the target 3.06, flip removed", len(o) == 1 and o[0]["reduce_only"]
          and abs(o[0]["price"] - 3.06) < 1e-9 and any(a == "trail_armed" for a, _ in db.logs), o)
    bot2 = L.FlipBot(ex, db); await bot2.tick()
    check("restart while trailing: still armed at the same stop", bot2.trail_floor is not None and abs(bot2.trail_floor - 3.06) < 1e-9)
    ex.price = 3.12; await bot2.tick()
    check("price runs to 3.12 -> stop raised to ~3.12 x 0.995 (from the bid) = 3.1043", abs(ex.orders[0]["price"] - 3.1043) < 1e-3, ex.orders)
    eq0 = ex.equity
    db.state["enabled"] = False
    ex.move(3.10); await _ticks(bot2, 2)
    t = db.trades[-1]
    check("pullback fills the stop at 3.1044 -> sequence won as 'trail', more than the 2% target",
          ex.pos == 0 and t["result"] == "trail" and db.state.get("wins") == 1 and abs(t["exit_price"] - 3.1043) < 1e-3
          and t["pnl_usd"] > 3.33 * 3.0 * 0.02, (ex.pos, t, db.state.get("wins")))


async def t_trail_stop_refused_closes_at_market():
    print("\n[trail: if Lighter refuses the trailing stop, the bot closes at market at once (win kept, never unprotected)]")
    ex, db = FakeEx(), FakeDB(); db.state["override_params"] = {"trail_pct": 0.5}
    bot = L.FlipBot(ex, db); await _ticks(bot, 1)
    real_stop = ex.stop
    async def refuse_reduce_only(is_ask, qty, trigger, reduce_only):
        if reduce_only: return "invalid trigger price"
        return await real_stop(is_ask, qty, trigger, reduce_only)
    ex.stop = refuse_reduce_only
    db.state["enabled"] = False
    ex.price = 3.07; await _ticks(bot, 3)
    check("closed at market, counted as a win", ex.pos == 0 and any(a == "trail_market_close" for a, _ in db.logs)
          and db.state.get("wins") == 1, (ex.pos, db.state.get("wins")))


async def t_stepped_target():
    print("\n[stepped target 3 steps from 1% +0.5%: 1% at start, 1.5% once profit covers one bust, 2% after two, back down after a loss]")
    ex, db = FakeEx(equity=200.0), FakeDB()
    db.state["override_params"] = {"step_n": 3, "step_start": 1.0, "step_inc": 0.5, "step_base_usd": 200.0}
    bot = L.FlipBot(ex, db); await _ticks(bot, 1)
    tgt = [o for o in ex.orders if o["kind"] == "limit"][0]["price"]
    check("no profit yet -> step 1: target 1%", bot.p.tp_pct == 1.0 and abs(tgt - 3.03) < 1e-9, (bot.p.tp_pct, tgt))
    bust = sum(F.ladder(200.0, bot.p)) * 0.005
    db.state["enabled"] = False; ex.move(3.031); await _ticks(bot, 2)
    ex.equity = 200.0 + bust * 1.2; db.state["enabled"] = True; await _ticks(bot, 1)
    check("profit covers 1.2 busts -> step 2: target 1.5%", bot.p.tp_pct == 1.5, (bot.p.tp_pct, bot.step_info))
    db.state["enabled"] = False; ex.move(ex.price * 1.016); await _ticks(bot, 2)
    ex.equity = 200.0 + bust * 2.5; db.state["enabled"] = True; await _ticks(bot, 1)
    check("covers 2.5 busts -> step 3: target 2% (top step)", bot.p.tp_pct == 2.0, bot.step_info)
    db.state["enabled"] = False; ex.move(ex.price * 1.021); await _ticks(bot, 2)
    ex.equity = 200.0 + bust * 0.5; db.state["enabled"] = True; await _ticks(bot, 1)
    check("a loss eats the cushion -> back to step 1 (1%)", bot.p.tp_pct == 1.0, bot.step_info)
    await bot.tick()
    check("panel readout shows the step", db.state["live_params"]["step_info"]["level"] == 1)


async def _nosleep(*a, **k):
    return None


async def main():
    for t in (t_start_flip_win, t_watch_mode_fallback, t_restart_keeps_the_sequence, t_off_keeps_position_flatten_closes,
              t_bust_at_cap, t_unknown_position_is_protected, t_ws_wake_and_rejected_flip, t_stale_flip_never_left_behind, t_panel_settings_next_sequence_only, t_failed_placement_rechecked_fast, t_compounding_off, t_waf_block_backs_off, t_trail_after_target, t_trail_stop_refused_closes_at_market, t_stepped_target):
        await t()
    print(f"\n==== {len(PASS)} passed, {len(FAIL)} failed ====")

L.asyncio.sleep = _nosleep
asyncio.run(main())
raise SystemExit(1 if FAIL else 0)
