"""SOL flip bot (FLIP_COIN=SOL: market 2, 3 size decimals, min 0.055 SOL, stop 0.5 / target 1) against the fake exchange
(plain script: python3 test_sol_flip_live.py)."""
import asyncio, os
os.environ["FLIP_COIN"] = "SOL"
os.environ.setdefault("NEXT_PUBLIC_SUPABASE_URL", "http://x"); os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "x")
import lit_flip_core as F
import lit_flip_live as L

L.ACCOUNT_EVERY = 0.0; L.CANDLES_EVERY = 0.0; L.ORDERS_CHECK_EVERY = 0.0; L.MISMATCH_GRACE_S = 0.0; L.FLAT_CONFIRM_S = 0.0; L.WATCH_REFIRE_S = 0.0; L.PUBLISH_EVERY = 0.0
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



async def main():
    print("\n[SOL config]")
    check("market 2, own tables, stop 0.5 / target 1", L.MARKET_ID == 2 and L.TABLE_STATE == "lighter_sol_flip_state"
          and L.PARAMS.sl_pct == 0.5 and L.PARAMS.tp_pct == 1.0 and L.SIZE_DEC == 3 and L.PRICE_DEC == 3)
    check("price 93.58 sent as 93580 (3 decimals), 0.107 SOL as 107", L.px_int(93.58) == 93580 and L.qty_int(0.107) == 107)
    print("\n[SOL at $93: open long $10 -> flip short x1.5 at -0.5% -> target -1% wins]")
    ex, db = FakeEx(price=93.0, equity=200.0), FakeDB(); bot = L.FlipBot(ex, db)
    await bot.tick()
    check("opened LONG 0.108 SOL: rounded UP so the order is >= $10 (0.107 x $93 = $9.95 would be refused)",
          bot.pos is not None and bot.pos.side == F.LONG and abs(ex.pos - 0.108) < 1e-9, ex.pos)
    tgt = [o for o in ex.orders if o["kind"] == "limit"][0]; flip = [o for o in ex.orders if o["kind"] == "stop"][0]
    check("target sell at +1%", tgt["is_ask"] and abs(tgt["price"] - 93.0 * 1.01) < 1e-6, tgt)
    check("flip: one non-reduce-only SELL at -0.5% for current + next (0.108 + 15/92.535)",
          flip["is_ask"] and not flip["reduce_only"] and abs(flip["price"] - 92.535) < 1e-6 and abs(flip["qty"] - (0.108 + 15 / 92.535)) < 0.002, flip)
    ex.move(92.535); await bot.tick(); await bot.tick()
    check("now SHORT level 1, ~0.162 SOL", bot.pos.side == F.SHORT and bot.pos.level == 1 and abs(ex.pos + 0.162) < 0.002, (bot.pos, ex.pos))
    db.state["enabled"] = False
    ex.move(92.535 * 0.99); await bot.tick(); await bot.tick()
    check("target hit: flat, 1 win, money up", ex.pos == 0 and db.state.get("wins") == 1 and ex.equity > 200, (ex.pos, db.state.get("wins"), ex.equity))
    print(f"\n==== {len(PASS)} passed, {len(FAIL)} failed ====")


async def _nosleep(*a, **k):
    return None

L.asyncio.sleep = _nosleep
asyncio.run(main())
raise SystemExit(1 if FAIL else 0)
