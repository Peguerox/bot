"""Engine v2 simulator (2026-10-22). Drives a real LitGridLive (engine_v2_enabled) against a fake
Lighter exchange and a fake Supabase, through fast crashes, spikes and chop, with injected
429s, ambiguous timeouts, late order visibility and restarts. Checks every tick:

  - no lot is ever sold below its cost (every filled sell's realized profit >= 0),
  - the ledger never disagrees with the exchange for long (LIT and resting orders),
  - the exchange never holds two of our orders at the same price,
  - after a disruption ends, the book recovers: a buy just below price and a sell just above,
  - exchange requests stay inside the budget.

Plain script, same convention as test_lit_grid_live.py: `python3 test_engine_sim.py`.
"""
import asyncio, math, os, random, sys, types
from datetime import datetime, timedelta, timezone

os.environ.setdefault("NEXT_PUBLIC_SUPABASE_URL", "http://sim")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "sim")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lit_grid_live as core
import grid_engine

PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    if not cond:
        print(f"  FAIL  {name}  -> {extra}")


# ── Fake clock (patched into the bot module) ────────────────────────────────────────────────────
class Clock:
    t = 1_000_000.0


T0 = Clock.t
BASE_DT = datetime(2026, 10, 22, tzinfo=timezone.utc)


class FakeTime:
    @staticmethod
    def time():
        return Clock.t

    @staticmethod
    def monotonic():
        return Clock.t


class FakeDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return BASE_DT + timedelta(seconds=Clock.t - T0)


core.time = FakeTime
core.datetime = FakeDatetime


# ── Fake Supabase (generic PostgREST filters) ───────────────────────────────────────────────────
def _parse(path):
    table, _, qs = path.partition("?")
    filters, opts = [], {}
    for part in qs.split("&") if qs else []:
        k, _, v = part.partition("=")
        if k in ("select", "order", "limit", "offset"):
            opts[k] = v
        else:
            filters.append((k, v))
    return table, filters, opts


def _match(row, filters):
    for col, expr in filters:
        val = row.get(col)
        if expr.startswith("eq."):
            if str(val) != expr[3:] and not (isinstance(val, bool) and str(val).lower() == expr[3:]):
                return False
        elif expr.startswith("in.("):
            if str(val) not in expr[4:-1].split(","):
                return False
        elif expr == "not.is.null":
            if val is None:
                return False
        elif expr == "is.null":
            if val is not None:
                return False
        else:
            raise RuntimeError(f"unsupported filter {col}={expr}")
    return True


class SimDb:
    def __init__(self, state):
        self.state = dict(state)
        self.orders = []
        self.runs = []
        self._next = 1

    async def sb(self, method, path, body=None):
        table, filters, opts = _parse(path)
        if table == core.TABLE_STATE:
            if method == "GET":
                return [dict(self.state)]
            self.state.update(body)
            return [dict(self.state)]
        if table == core.TABLE_RUNS:
            self.runs.append(body)
            return [body]
        if table != core.TABLE_ORDERS:
            raise RuntimeError(path)
        if method == "POST":
            row = dict(body)
            row["id"] = self._next
            self._next += 1
            self.orders.append(row)
            return [dict(row)]
        rows = [r for r in self.orders if _match(r, filters)]
        if method == "PATCH":
            for r in rows:
                r.update(body)
            return [dict(r) for r in rows]
        rows.sort(key=lambda r: r["id"])
        off, lim = int(opts.get("offset", 0)), opts.get("limit")
        rows = rows[off:off + int(lim)] if lim else rows[off:]
        return [dict(r) for r in rows]


# ── Fake Lighter exchange ───────────────────────────────────────────────────────────────────────
class RateLimited(Exception):
    pass


class SimExchange:
    def __init__(self, price, usdc, lit, rng):
        self.price, self.usdc, self.lit, self.rng = price, usdc, lit, rng
        self.orders = {}           # order_index -> dict
        self.next_oi = 1
        self.p429 = 0.0            # chance any request is refused by the rate limiter
        self.p_timeout = 0.0       # chance a send times out (and maybe landed anyway)
        self.lag = 4.0             # seconds before a new order is visible to reads
        self.fill_lag = 4.0        # seconds before a FILL shows in the per-order lookup, while the
                                   # order is already gone from the active list (audit 2026-10-22)
        self.requests = []         # timestamps of every request, for the budget check
        self.fills = []            # (side, price, size, co)

    def _gate(self):
        self.requests.append(Clock.t)
        if self.rng.random() < self.p429:
            raise RateLimited("(429)\nReason: Too Many Requests")

    def set_price(self, p):
        self.price = p
        for o in self.orders.values():
            if o["status"] != "open":
                continue
            if (o["side"] == "buy" and p <= o["price"]) or (o["side"] == "sell" and p >= o["price"]):
                self._fill(o, o["price"])

    def _fill(self, o, px):
        q = o["remaining"]
        o["filled_t"] = Clock.t
        o["filled"] += q
        o["quote"] += q * px
        o["remaining"] = 0.0
        o["status"] = "filled"
        if o["side"] == "buy":
            self.usdc -= q * px
            self.lit += q
        else:
            self.lit -= q
            self.usdc += q * px
        self.fills.append((o["side"], px, q, o["co"]))

    def place(self, co, side, price, size, post_only=True):
        if post_only and ((side == "buy" and price >= self.price) or (side == "sell" and price <= self.price)):
            return "post-only would cross"
        if side == "sell" and size > self.lit - self._locked_lit() + 1e-9:
            return "insufficient LIT"
        if side == "buy" and price * size > self.usdc - self._locked_usdc() + 1e-6:
            return "insufficient USDC"
        oi = self.next_oi
        self.next_oi += 1
        self.orders[oi] = {"oi": oi, "co": co, "side": side, "price": price, "size": size,
                           "remaining": size, "filled": 0.0, "quote": 0.0, "status": "open",
                           "created": Clock.t}
        return None

    def market(self, co, side, size, band):
        free_lit = self.lit - self._locked_lit()   # before this order is on the book
        oi = self.next_oi
        self.next_oi += 1
        o = {"oi": oi, "co": co, "side": side, "price": band, "size": size, "remaining": size,
             "filled": 0.0, "quote": 0.0, "status": "open", "created": Clock.t}
        self.orders[oi] = o
        ok = (side == "buy" and self.price <= band) or (side == "sell" and self.price >= band)
        if ok and (side == "buy" or free_lit >= size - 1e-9):
            self._fill(o, self.price)
        else:
            o["status"] = "canceled"

    def _locked_lit(self):
        return sum(o["remaining"] for o in self.orders.values() if o["status"] == "open" and o["side"] == "sell")

    def _locked_usdc(self):
        return sum(o["remaining"] * o["price"] for o in self.orders.values()
                   if o["status"] == "open" and o["side"] == "buy")

    def cancel(self, oi):
        o = self.orders.get(oi)
        if o and o["status"] == "open":
            o["status"] = "canceled"
            o["closed_t"] = Clock.t

    def cancel_all(self):
        for o in self.orders.values():
            if o["status"] == "open":
                o["status"] = "canceled"
                o["closed_t"] = Clock.t

    def as_obj(self, o):
        return types.SimpleNamespace(
            client_order_index=o["co"], order_index=o["oi"], is_ask=o["side"] == "sell",
            price=f"{o['price']:.4f}", status=o["status"], filled_base_amount=o["filled"],
            filled_quote_amount=o["quote"], remaining_base_amount=o["remaining"])

    def visible(self, o):
        return Clock.t - o["created"] >= self.lag


class SimSigner:
    ORDER_TYPE_LIMIT = 0
    ORDER_TYPE_MARKET = 1
    ORDER_TIME_IN_FORCE_POST_ONLY = 2
    CANCEL_ALL_TIF_IMMEDIATE = 0

    def __init__(self, ex):
        self.ex = ex
        self.nonce_manager = types.SimpleNamespace(
            api_keys_list=[3], lock=lambda k: self._lock, async_next_nonce=self._next_nonce,
            acknowledge_failure=lambda k: None, async_hard_refresh_nonce=self._refresh)
        self._lock = asyncio.Lock()

    async def _next_nonce(self, k):
        return k, 0

    async def _refresh(self, k):
        return None

    def _maybe_timeout(self, apply):
        if self.ex.rng.random() < self.ex.p_timeout:
            if self.ex.rng.random() < 0.5:
                apply()
            raise asyncio.TimeoutError()
        apply()

    async def create_order(self, **kw):
        self.ex._gate()
        res = {}
        self._maybe_timeout(lambda: res.setdefault("err", self.ex.place(
            kw["client_order_index"], "sell" if kw["is_ask"] else "buy",
            kw["price"] / 10 ** core.PRICE_DECIMALS, kw["base_amount"] / 10 ** core.SIZE_DECIMALS)))
        return (None, None, res["err"]) if res.get("err") else (object(), types.SimpleNamespace(code=200), None)

    async def create_market_order(self, **kw):
        self.ex._gate()
        self._maybe_timeout(lambda: self.ex.market(
            kw["client_order_index"], "sell" if kw["is_ask"] else "buy",
            kw["base_amount"] / 10 ** core.SIZE_DECIMALS, kw["avg_execution_price"] / 10 ** core.PRICE_DECIMALS))
        return object(), types.SimpleNamespace(code=200), None

    async def cancel_order(self, market_index, order_index):
        self.ex._gate()
        self._maybe_timeout(lambda: self.ex.cancel(order_index))
        return object(), types.SimpleNamespace(code=200), None

    async def cancel_all_orders(self, time_in_force, timestamp_ms):
        self.ex._gate()
        self._maybe_timeout(self.ex.cancel_all)
        return object(), types.SimpleNamespace(code=200), None

    def sign_create_order(self, market, co, base, price, is_ask, otype, tif, nonce=-1, api_key_index=None):
        return "create", {"co": co, "side": "sell" if is_ask else "buy",
                          "price": price / 10 ** core.PRICE_DECIMALS,
                          "size": base / 10 ** core.SIZE_DECIMALS}, "h", None

    def sign_cancel_order(self, market, order_index, nonce=-1, api_key_index=None):
        return "cancel", {"oi": order_index}, "h", None

    async def send_tx_batch(self, tx_types, tx_infos):
        self.ex._gate()

        def apply():
            for ty, info in zip(tx_types, tx_infos):
                if ty == "cancel":
                    self.ex.cancel(info["oi"])
                else:
                    self.ex.place(info["co"], info["side"], info["price"], info["size"])
        self._maybe_timeout(apply)
        return types.SimpleNamespace(code=200, volume_quota_remaining=1000)


class SimOrderApi:
    def __init__(self, ex):
        self.ex = ex

    async def account_active_orders(self, authorization, account_index, market_id, _request_timeout=None):
        self.ex._gate()
        return types.SimpleNamespace(orders=[self.ex.as_obj(o) for o in self.ex.orders.values()
                                             if o["status"] == "open" and self.ex.visible(o)])

    async def account_orders(self, authorization, client_order_indexes, account_index, _request_timeout=None):
        self.ex._gate()
        cos = {int(c) for c in client_order_indexes.split(",")}
        return types.SimpleNamespace(orders=[self.ex.as_obj(o) for o in self.ex.orders.values()
                                             if o["co"] in cos and self.ex.visible(o)
                                             and Clock.t - o.get("filled_t", -1e18) >= self.ex.fill_lag])


class SimAccountApi:
    def __init__(self, ex):
        self.ex = ex

    async def account(self, by, value, _headers=None, _request_timeout=None):
        self.ex._gate()
        assets = [types.SimpleNamespace(symbol="USDC", balance=self.ex.usdc, margin_mode="disabled"),
                  types.SimpleNamespace(symbol="LIT", balance=self.ex.lit, margin_mode="disabled")]
        return types.SimpleNamespace(accounts=[types.SimpleNamespace(assets=assets)])


def make_sim_bot(db, ex, limiter):
    bot = core.LitGridLive.__new__(core.LitGridLive)
    core.LitGridLive.__init__(bot, http=None)
    bot._limiter = limiter
    bot.sb = db.sb
    bot.client = SimSigner(ex)
    bot._order_api = SimOrderApi(ex)
    bot._account_api = SimAccountApi(ex)
    bot.account_index = 1
    bot._lock_held = True

    async def yes(*a, **k):
        return True
    bot.acquire_lock = yes
    bot._touch_lock_heartbeat = yes
    bot._get_auth_token = lambda: "tok"
    bot.live.best_mid = lambda max_age=None: ex.price

    async def price():
        return ex.price
    bot.fetch_current_price = price
    return bot


def base_state(**over):
    st = {"enabled": True, "spacing_pct": 0.5, "levels_up": 5, "levels_down": 5,
          "capital_usd": 1000.0, "drawdown_pct": 20, "order_size_lit": None,
          "usdc_balance": 1000.0, "lit_balance": 0.0, "internal_spacing_pct": None,
          "max_open_buys": None, "lifetime_buy_count": 0, "profit_mode": "rest",
          "profit_bucket_rest_usd": 0.0, "profit_bucket_cover_drop_usd": 0.0,
          "profit_bucket_compound_usd": 0.0, "rest_withdrawn_usd": 0, "engine_v2_enabled": True,
          "dynamic_dd_enabled": False, "gate_spacing_growth_enabled": False,
          "grid_anchor_log": None, "grid_anchor_price": None, "reanchor_journal": None,
          "flatten_requested": False, "grid_reset_requested": False}
    st.update(over)
    return st


def price_path(kind, p0, n, rng):
    """Per-2s prices. crash: -15% in ~3 min then chop; spike: +12% fast; chop: +-1% noise."""
    out, p = [], p0
    for i in range(n):
        if kind == "crash":
            drift = -0.15 / 90 if i < 90 else 0.0
        elif kind == "spike":
            drift = 0.12 / 60 if i < 60 else 0.0
        else:
            drift = 0.0
        p *= math.exp(drift + rng.gauss(0, 0.0015))
        out.append(round(p, 4))
    return out


def lot_costs(db):
    buys = [r for r in db.orders if r["side"] == "buy" and r.get("status") == "filled"]
    sells = [r for r in db.orders if r["side"] == "sell" and r.get("filled_qty") is not None
             and r.get("closes_level") is not None]
    return core.holdings_from_rows(buys, sells)


def push_feed(feed, ex, rng, p_drop):
    """The account_orders websocket as the bot would see it: each order's state ~1s after it
    changed (an order that changed more recently keeps its previous state in the feed), and a
    dropped connection now and then (empty feed, then a snapshot of the OPEN orders only)."""
    if feed is None:
        return
    if rng.random() < p_drop:
        feed.reset()
        return
    lagged = [ex.as_obj(o) for o in ex.orders.values()
              if Clock.t - max(o["created"], o.get("filled_t", -1e18), o.get("closed_t", -1e18)) >= 1.0]
    if feed.synced_at == 0:
        feed.apply([o for o in lagged if o.status == "open"], snapshot=True, now=Clock.t)
    else:
        known = {co: (o.status, o.filled_base_amount) for co, o in feed.orders.items()}
        changed = [o for o in lagged if known.get(o.client_order_index) != (o.status, o.filled_base_amount)]
        feed.apply(changed, snapshot=False, now=Clock.t)
    feed.frame_at = Clock.t


async def run_scenario(name, kind, seed, p429=0.0, p_timeout=0.0, restart_every=None, ticks=240,
                       spacing=0.5, levels=(5, 5), disrupt_until=None, state_over=None, hooks=None,
                       flatten_at=None, ws=True, p_drop=0.02):
    rng = random.Random(seed)
    Clock.t = T0
    ex = SimExchange(3.50, 1000.0, 0.0, rng)
    db = SimDb(base_state(spacing_pct=spacing, levels_up=levels[0], levels_down=levels[1],
                          **(state_over or {})))
    limiter = core.ExchangeLimiter()
    feed = core.OrdersFeed() if ws else None
    bot = make_sim_bot(db, ex, limiter)
    bot._orders_feed = feed
    prices = price_path(kind, 3.50, ticks, rng)
    disrupt_until = disrupt_until if disrupt_until is not None else int(ticks * 0.6)
    worst_profit = 0.0
    recovered_at = None
    covered = eligible = 0
    for i, p in enumerate(prices):
        Clock.t += 2.0
        for at, fn in (hooks or {}).items():
            if at == i:
                fn(db)
        if flatten_at == i:
            db.state["flatten_requested"] = True
        on = i < disrupt_until
        ex.p429, ex.p_timeout = (p429, p_timeout) if on else (0.0, 0.0)
        ex.set_price(p)
        if restart_every and i and i % restart_every == 0:
            bot = make_sim_bot(db, ex, limiter)
            if feed is not None:
                feed = core.OrdersFeed()     # a restart starts a new connection
            bot._orders_feed = feed
        push_feed(feed, ex, rng, p_drop if on else 0.0)
        try:
            await bot.tick()
        except RateLimited:
            pass
        except asyncio.TimeoutError:
            pass
        for r in db.orders:
            if r["side"] == "sell" and r.get("realized_profit_usd") is not None:
                worst_profit = min(worst_profit, float(r["realized_profit_usd"]))
        prices_on_book = [(o["side"], round(o["price"], 4)) for o in ex.orders.values() if o["status"] == "open"]
        if len(prices_on_book) != len(set(prices_on_book)):
            check(f"[{name}] never two of our orders at one price (tick {i})", False, sorted(prices_on_book))
            break
        buys = [o["price"] for o in ex.orders.values() if o["status"] == "open" and o["side"] == "buy"]
        sells = [o["price"] for o in ex.orders.values() if o["status"] == "open" and o["side"] == "sell"]
        step = 1 + float(core.effective_spacing_pct(db.state)) / 100
        # "Next to price" = within 3 grid lines, or 0.6% on a grid so tight that the sim's own
        # per-tick move (~0.3% in 2s) outruns one 5s book refresh by more than 3 lines.
        reach = max(step ** 3.05, 1.006)
        near_buy = bool(buys) and max(buys) >= p / reach
        # Sells never go below a lot's cost + one step (owner's rule). After a drop every lot was
        # bought higher, so the nearest ALLOWED sell can be far above price: then "next to price"
        # means within a line of that nearest allowed sell.
        lots_now = {k: h for k, h in lot_costs(db).items() if h["qty"] >= 1.0}
        floor = min((h["cost"] for h in lots_now.values()), default=0.0)
        # No lot held = nothing to sell (no market buys): the sell side has no gap to fill.
        near_sell = (not lots_now) or (bool(sells) and min(sells) <= max(p * reach, floor * step ** 1.05))
        if not on and recovered_at is None and near_buy and near_sell:
            recovered_at = i
        grace = disrupt_until + int(core.RATE_LIMIT_BACKOFF_MAX / 2) + 5 if (p429 or p_timeout) else 20
        if (i > grace and not on and db.state.get("enabled") and not db.state.get("flatten_requested")
                and ex.usdc > 200):
            eligible += 1
            covered += near_buy and near_sell
    # settle: no faults, let reconcile catch up, then compare ledger to exchange
    ex.p429 = ex.p_timeout = 0.0
    for _ in range(40):
        Clock.t += 2.0
        push_feed(feed, ex, rng, 0.0)
        await bot.tick()
    if flatten_at is not None:
        check(f"[{name}] flatten sold everything and stopped the bot",
              ex.lit < 1.0 and db.state.get("enabled") is False, (ex.lit, db.state.get("enabled")))
    else:
        check(f"[{name}] no lot ever sold below cost (worst realized {worst_profit:.6f})", worst_profit >= -1e-6, worst_profit)
        if eligible:
            # A 0.125% grid in the sim's extreme crash (0.3% every 2s) needs more orders per minute
            # than a Lighter Standard account allows (60/min per wallet, EVERY order in a batch
            # counting -- docs, confirmed live 2026-10-22). 50% there is the account's ceiling,
            # not the engine's; a Plus account lifts it.
            need = 0.5 if "0.125" in name else 0.85
            check(f"[{name}] a buy and a sell next to price on >={int(need*100)}% of calm ticks ({covered}/{eligible})",
                  covered >= need * eligible, (covered, eligible))
    ledger_lit = sum(h["qty"] for h in lot_costs(db).values())
    # Fills from the last few seconds are not visible to the bot yet; count them on both sides.
    for o in ex.orders.values():
        if o["co"] in {o2["co"] for o2 in ex.orders.values() if Clock.t - o2.get("filled_t", -1e18) < 10}:
            row = next((r for r in db.orders if r["client_order_index"] == o["co"]), None)
            if row is not None and row.get("status") != "filled":
                ledger_lit += o["filled"] if o["side"] == "buy" else -o["filled"]
    check(f"[{name}] ledger LIT matches exchange LIT ({ledger_lit:.2f} vs {ex.lit:.2f})",
          abs(ledger_lit - ex.lit) < 0.05, (ledger_lit, ex.lit))
    # One lot per line: walking each line's buys and sells in time order, it never holds two.
    worst_stack = 0
    events = sorted((r["id"], r) for r in db.orders if r.get("status") == "filled")
    held_per_line = {}
    for _, r in events:
        if r["side"] == "buy":
            held_per_line[r["level"]] = held_per_line.get(r["level"], 0) + 1
            worst_stack = max(worst_stack, held_per_line[r["level"]])
        elif r.get("closes_level") is not None:
            held_per_line[r["closes_level"]] = max(0, held_per_line.get(r["closes_level"], 0) - 1)
    if not any(h for h in (hooks or {})) and flatten_at is None:
        check(f"[{name}] a line never holds two lots at once (worst {worst_stack})", worst_stack <= 1, worst_stack)
    open_ledger = {r["client_order_index"] for r in db.orders if r.get("status") in ("open", "pending", "cancel_requested")}
    open_ex = {o["co"] for o in ex.orders.values() if o["status"] == "open"}
    # A cancel sent in the last few seconds is legitimately not reconciled yet.
    just_closed = {o["co"] for o in ex.orders.values()
                   if Clock.t - max(o.get("closed_t", -1e18), o.get("filled_t", -1e18), o["created"]) < 10}
    check(f"[{name}] no orphan orders on the exchange (exchange \\ ledger empty)",
          not (open_ex - open_ledger), sorted(open_ex - open_ledger)[:10])
    check(f"[{name}] no ghost rows in the ledger (ledger \\ exchange empty)",
          not (open_ledger - open_ex - just_closed), sorted(open_ledger - open_ex - just_closed)[:10])
    if flatten_at is None:
        check(f"[{name}] book recovered after the disruption (buy and sell within 3 lines of price)",
              recovered_at is not None, recovered_at)
    per_min = {}
    for t in ex.requests:
        per_min[int((t - T0) // 60)] = per_min.get(int((t - T0) // 60), 0) + 1
    worst_min = max(per_min.values()) if per_min else 0
    check(f"[{name}] requests per minute stay inside the budget (worst {worst_min})",
          worst_min <= core.REQUEST_BUDGET_PER_MIN + 1, worst_min)
    trades = sum(1 for f in ex.fills)
    print(f"  {name}: fills={trades} worst_req/min={worst_min} recovered_at_tick={recovered_at} "
          f"lit={ex.lit:.2f} usdc={ex.usdc:.2f}")


async def main():
    scenarios = [
        ("chop, clean", "chop", 1, 0.0, 0.0, None),
        ("crash, clean", "crash", 2, 0.0, 0.0, None),
        ("spike, clean", "spike", 3, 0.0, 0.0, None),
        ("crash + 429 storm", "crash", 4, 0.3, 0.0, None),
        ("spike + 429 storm", "spike", 5, 0.3, 0.0, None),
        ("chop + timeouts", "chop", 6, 0.0, 0.15, None),
        ("crash + 429s + timeouts", "crash", 7, 0.2, 0.1, None),
        ("chop + restarts every 20 ticks", "chop", 8, 0.1, 0.05, 20),
        ("crash, tight 0.125% grid", "crash", 9, 0.1, 0.05, None),
    ]
    for name, kind, seed, p429, pto, rs in scenarios:
        kw = {"spacing": 0.125, "levels": (10, 10)} if "0.125" in name else {}
        await run_scenario(name, kind, seed, p429, pto, rs, **kw)

    dyn = {"dynamic_dd_enabled": True, "gate_spacing_growth_enabled": True, "dynamic_dd_high": None,
           "dynamic_dd_tier": None, "dynamic_dd_base_capital_usd": None,
           "gate_spacing_multiplier_value": None}
    await run_scenario("crash through every tier, dynamic drawdown + spacing growth", "crash", 11,
                       0.1, 0.05, None, ticks=360, state_over=dyn)
    await run_scenario("same, tight 0.125% grid", "crash", 12, 0.1, 0.05, None, ticks=360,
                       spacing=0.125, levels=(10, 10), state_over=dyn)
    await run_scenario("compound bucket resizing in chop", "chop", 13, 0.1, 0.05, None, ticks=300,
                       state_over={"profit_mode": "compound"})
    await run_scenario("cover-drop bucket through a crash", "crash", 14, 0.1, 0.05, None,
                       state_over={"profit_mode": "cover_drop"})
    await run_scenario("spacing edited mid-run 0.5% -> 0.25% -> 1%", "chop", 15, 0.1, 0.05, None,
                       ticks=300, hooks={60: lambda db: db.state.update({"spacing_pct": 0.25, "order_size_lit": None}),
                                         160: lambda db: db.state.update({"spacing_pct": 1.0, "order_size_lit": None})})
    await run_scenario("growth toggled on mid-crash", "crash", 16, 0.1, 0.05, None, ticks=300,
                       state_over={"dynamic_dd_enabled": True},
                       hooks={50: lambda db: db.state.update({"gate_spacing_growth_enabled": True,
                                                              "gate_spacing_multiplier_value": None,
                                                              "dynamic_dd_tier": None, "order_size_lit": None})})
    await run_scenario("flatten mid-crash", "crash", 17, 0.1, 0.05, None, flatten_at=80)
    # The websocket down the whole time: REST alone must still be correct (slower, not wrong).
    await run_scenario("no websocket, crash + 429s + timeouts", "crash", 18, 0.2, 0.1, None, ws=False)
    await run_scenario("no websocket, chop + restarts", "chop", 19, 0.1, 0.05, 20, ws=False)
    await run_scenario("websocket dropping often, spike", "spike", 20, 0.1, 0.05, None, p_drop=0.2)
    # Live 2026-10-22 (Worker 3, 0.125%): a lot bought at market at 3.40175 on the 3.3979 line.
    # Simple grid: it sells on the line above, never below its cost -> 3.4022 (one line up),
    # and the planner never market-buys.
    step = math.log(1.00125)
    anchor = math.log(3.3979) - 10162 * step
    lots = {10162: {"qty": 5.3, "cost": 3.40175}}
    plan = core.grid_engine.plan_orders(3.4005, anchor, step, 0.00125, lots, 10, 10, core.round_price)
    check("a lot sells one line up, never below cost",
          plan.sells[0].price == core.round_price(math.exp(anchor + 10163 * step)) and plan.sells[0].price >= 3.40175,
          [w.price for w in plan.sells[:1]])
    check("the planner never market-buys", not hasattr(plan, "trail_line") or plan.trail_line is None, None)
    order = core.grid_engine.priority_order(
        [core.grid_engine.Want("buy", 3.38, 1, 1), core.grid_engine.Want("sell", 3.45, 1, 3),
         core.grid_engine.Want("buy", 3.39, 1, 2), core.grid_engine.Want("sell", 3.41, 1, 2)], 3.40)
    check("priority: nearest sell, nearest buy, next sell, next buy",
          [(w.side, w.price) for w in order] == [("sell", 3.41), ("buy", 3.39), ("sell", 3.45), ("buy", 3.38)],
          [(w.side, w.price) for w in order])
    print(f"\n==== {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL:
        for f in FAIL:
            print("  FAILED:", f)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
