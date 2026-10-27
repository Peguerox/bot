"""Offline tests for lit_grid_live. No network, no real money -- same plain-script convention as
test_core.py / test_lit_grid_paper.py (python3 test_lit_grid_live.py), Supabase and the Lighter
SDK both faked in-memory.

Several tests here specifically reproduce findings from the second, independent follow-up audit
(2026-10-18) -- including the core rounding bug, confirmed with plain arithmetic before writing
the fix: fill prices sit EXACTLY on a grid-bin boundary by construction, so rounding to the
exchange's real 4-decimal precision has roughly 50% odds of landing in the wrong bin on any given
fill. That's why sells are now linked to buys by an explicit `closes_level`, never a level
recomputed from a (rounded) price."""
import asyncio, math, os, sys, time

os.environ.setdefault("NEXT_PUBLIC_SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")
sys.path.insert(0, "/Users/julio/trading-bot/server")

import lit_grid_live as core
core.ROWS_CACHE_RELOAD_S = 0.0   # these tests edit the fake ledger by hand between calls
from lit_grid_live import (
    LitGridLive, round_price, round_size, clamp_order_size, price_to_int,
    size_to_int, _order_fill_amounts, _order_is_terminal, MIN_BASE_AMOUNT, PRICE_DECIMALS,
    SIZE_DECIMALS, run_lit_grid_live,
)
from lit_grid_paper import level_of

PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{('  -> ' + str(extra)) if extra and not cond else ''}")


def _parse_qs(path):
    qs = path.split("?", 1)[1] if "?" in path else ""
    out = {}
    for part in qs.split("&"):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k] = v
    return out


class FakeDb:
    def __init__(self, state, orders=None):
        self.state = dict(state)
        self.orders = list(orders or [])
        self.runs = []
        self._next_id = max([o["id"] for o in self.orders], default=0) + 1

    async def sb(self, method, path, body=None):
        if path.startswith(core.TABLE_STATE):
            if method == "GET":
                return [dict(self.state)]
            if method == "PATCH":
                # Conditional PATCH, same semantics as the real PostgREST query-string guard:
                # every "<col>=eq.<val>" condition besides id must match the CURRENT state, or
                # the write touches zero rows (external audit fixes P1-1/P1-6, both built on
                # this exact optimistic-concurrency pattern).
                for part in path.split("?", 1)[1].split("&") if "?" in path else []:
                    if part.startswith("id="):
                        continue
                    if "=eq." in part:
                        col, val = part.split("=eq.", 1)
                        cur = self.state.get(col)
                        if cur is None:
                            if val not in ("null", ""):
                                return []
                        elif str(cur) != val:
                            return []
                self.state.update(body)
                return [dict(self.state)]
        if path.startswith(core.TABLE_ORDERS):
            if method == "POST":
                row = dict(body)
                row["id"] = self._next_id
                self._next_id += 1
                self.orders.append(row)
                return [row]
            if method == "GET":
                rows = self.orders
                if "side=eq.buy&status=in.(" in path:
                    rows = [r for r in rows if r.get("side") == "buy" and r.get("status") in core.OPEN_STATUSES]
                elif f"status=in.({','.join(core.OPEN_STATUSES)})" in path:
                    rows = [r for r in rows if r.get("status") in core.OPEN_STATUSES]
                elif "status=eq.filled&side=eq.buy" in path:
                    rows = [r for r in rows if r.get("status") == "filled" and r.get("side") == "buy"]
                elif "side=eq.sell&realized_profit_usd=not.is.null" in path:
                    rows = [r for r in rows if r.get("side") == "sell" and r.get("realized_profit_usd") is not None]
                elif "side=eq.sell&closes_level=not.is.null" in path:
                    rows = [r for r in rows if r.get("side") == "sell"
                            and r.get("closes_level") is not None and r.get("filled_qty") is not None]
                rows = sorted(rows, key=lambda r: r["id"])
                qs = _parse_qs(path)
                if "limit" in qs:
                    limit = int(qs["limit"])
                    offset = int(qs.get("offset", 0))
                    rows = rows[offset:offset + limit]
                return [dict(r) for r in rows]
            if method == "PATCH":
                row_id = int(path.split("id=eq.")[1].split("&")[0])
                for r in self.orders:
                    if r["id"] == row_id:
                        r.update(body)
                        return [dict(r)]
                return []
        if path.startswith(core.TABLE_RUNS) and method == "POST":
            self.runs.append(body)
            return [body]
        raise RuntimeError(f"unexpected call {method} {path}")


class FakeOrder:
    def __init__(self, client_order_index, order_index=1, status="open",
                 filled_base_amount=0.0, filled_quote_amount=0.0, remaining_base_amount=None):
        self.client_order_index = client_order_index
        self.order_index = order_index
        self.status = status
        self.filled_base_amount = filled_base_amount
        self.filled_quote_amount = filled_quote_amount
        self.remaining_base_amount = remaining_base_amount


class FakeOrdersResp:
    def __init__(self, orders):
        self.orders = orders


class FakeOrderApi:
    def __init__(self, orders_by_co=None, fail=False, client=None,
                 active_orders_by_co=None, active_orders_fail=False):
        self.orders_by_co = orders_by_co or {}
        self.fail = fail
        self.client = client
        # Fallback lookup for a row account_orders() can't find by ID (2026-10-22, the Worker 3
        # stuck-order incident) -- lists everything resting for the account/market, no per-ID
        # limitation. Separate fixture from orders_by_co so a test can show the two lookups
        # disagreeing (e.g. account_orders misses it, account_active_orders still has it).
        self.active_orders_by_co = active_orders_by_co or {}
        self.active_orders_fail = active_orders_fail
        self.active_orders_calls = 0

    async def account_orders(self, authorization, client_order_indexes, account_index, _request_timeout=None):
        if self.fail:
            raise RuntimeError("simulated reconciliation read failure")
        co_idxs = [int(x) for x in client_order_indexes.split(",")]
        out = []
        placed_by_co = {p["client_order_index"]: p for p in (self.client.placed if self.client else [])}
        for c in co_idxs:
            if c in self.orders_by_co:
                out.append(self.orders_by_co[c])
            elif c in placed_by_co:
                p = placed_by_co[c]
                base = p["base_amount"] / (10 ** SIZE_DECIMALS)
                price = (p.get("price") or p.get("avg_execution_price")) / (10 ** PRICE_DECIMALS)
                out.append(FakeOrder(c, order_index=900000 + c, status="filled",
                                      filled_base_amount=base, filled_quote_amount=base * price,
                                      remaining_base_amount=0.0))
        return FakeOrdersResp(out)

    async def account_active_orders(self, authorization, account_index, market_id, _request_timeout=None):
        self.active_orders_calls += 1
        if self.active_orders_fail:
            raise RuntimeError("simulated active-orders read failure")
        return FakeOrdersResp(list(self.active_orders_by_co.values()))


class FakeAsset:
    def __init__(self, symbol, balance, locked_balance=0, margin_balance=None, margin_mode=None):
        self.symbol = symbol
        self.balance = balance
        self.locked_balance = locked_balance
        self.margin_balance = margin_balance
        self.margin_mode = margin_mode or ("enabled" if margin_balance is not None else "disabled")


class FakeAccount:
    def __init__(self, assets):
        self.assets = assets


class FakeAccountResp:
    def __init__(self, assets):
        self.accounts = [FakeAccount(assets)]


class FakeAccountApi:
    def __init__(self, assets=None, fail=False):
        self.assets = assets or []
        self.fail = fail

    async def account(self, by, value, _headers=None, _request_timeout=None):
        if self.fail:
            raise RuntimeError("simulated balance read failure")
        return FakeAccountResp(self.assets)


class FakeSignerClient:
    ORDER_TYPE_LIMIT = "limit"
    ORDER_TIME_IN_FORCE_POST_ONLY = "post_only"

    def __init__(self, fail=False, err=None, cancel_err=None):
        self.fail = fail
        self.err = err
        self.cancel_err = cancel_err
        self.placed = []
        self.cancelled = []

    async def create_order(self, **kwargs):
        if getattr(self, "fail_msg", None):
            raise RuntimeError(self.fail_msg)
        if self.fail:
            raise RuntimeError("simulated network failure")
        self.placed.append(kwargs)
        if self.err:
            return None, None, self.err
        return object(), object(), None

    async def create_market_order(self, **kwargs):
        if self.fail:
            raise RuntimeError("simulated network failure")
        self.placed.append(kwargs)
        if self.err:
            return None, None, self.err
        return object(), object(), None

    async def cancel_order(self, market_index, order_index):
        self.cancelled.append(order_index)
        if self.cancel_err:
            return None, None, self.cancel_err
        return object(), object(), None

    CANCEL_ALL_TIF_IMMEDIATE = 0

    async def cancel_all_orders(self, time_in_force, timestamp_ms):
        self.cancel_all_calls = getattr(self, "cancel_all_calls", 0) + 1
        if self.cancel_err:
            return None, None, self.cancel_err
        return object(), object(), None

    def create_auth_token_with_expiry(self):
        return "fake-token", None


def force_not_cold_start(bot):
    """Monkeypatches _has_ever_bought() to True so a test exercising the ORDINARY resting-limit
    ladder isn't accidentally treated as a cold start (eighth-pass change: a cold start now fills
    via real market orders instead) -- without polluting fake.orders with an extra buy row that
    would throw off every buy-count/index assertion elsewhere in that test."""
    bot._has_ever_bought = lambda: _async_return(True)


def base_state(**over):
    st = {
        "enabled": True, "spacing_pct": 0.125, "levels_up": 15, "levels_down": 3,
        "capital_usd": 500, "drawdown_pct": 10, "order_size_lit": 1.70,
        "usdc_balance": 500.0, "lit_balance": 0.0,
        "live_price": None, "history_reset_at": None, "internal_spacing_pct": 0.125,
        "max_open_buys": None, "lifetime_buy_count": 0,
        "lock_owner": "test", "lock_heartbeat": None,
        "profit_mode": "rest", "profit_bucket_rest_usd": 0.0,
        "profit_bucket_cover_drop_usd": 0.0, "profit_bucket_compound_usd": 0.0,
    }
    st.update(over)
    return st


class _LongMissing(dict):
    """First-seen-missing tracker whose rows have already been missing for 10 minutes."""
    def setdefault(self, k, default=None):
        return super().setdefault(k, time.time() - 600)


def make_bot(state, orders=None, signer_fail=False, signer_err=None, cancel_err=None,
             orders_by_co=None, assets=None, order_api_fail=False, account_api_fail=False,
             active_orders_by_co=None, active_orders_fail=False):
    bot = LitGridLive.__new__(LitGridLive)
    # Every default the real bot starts with (v2 fields included); the test-specific fakes below
    # override what they need.
    LitGridLive.__init__(bot, http=None)
    bot.TABLE_STATE, bot.TABLE_ORDERS, bot.TABLE_RUNS = core.TABLE_STATE, core.TABLE_ORDERS, core.TABLE_RUNS
    bot._tag = ""
    bot._lock_id = "test"
    bot._lock_held = True
    bot._lock_checked_at = 0.0
    bot._lock_blocked_logged = False
    bot._last_level = None
    bot._window_center = None
    bot.live = core.LiveBook(core.MARKET_ID)
    bot._book_ws_connected_at = 0.0
    bot.account_index = 1
    bot._auth_token = None
    bot._auth_token_expiry_at = 0.0
    bot._last_balance_check = 0.0
    bot._balance_paused = False
    bot._limiter = core.ExchangeLimiter(per_minute=100000)
    bot._missing_since = _LongMissing()   # rows a test treats as gone were gone long ago
    bot._inflight = {}
    bot._orders_feed = None
    bot._last_rest_snapshot_at = 0.0
    bot._started_at_dt = core.datetime(2000, 1, 1, tzinfo=core.timezone.utc)
    bot._reject_count = {}
    bot._reconciled_seq = -1
    bot._v2_active = False
    bot._gap_since = None
    bot._last_cancel_all_at = 0.0
    bot.client = FakeSignerClient(fail=signer_fail, err=signer_err, cancel_err=cancel_err)
    bot._order_api = FakeOrderApi(orders_by_co, fail=order_api_fail, client=bot.client,
                                   active_orders_by_co=active_orders_by_co,
                                   active_orders_fail=active_orders_fail)
    bot._account_api = FakeAccountApi(assets, fail=account_api_fail)
    fake = FakeDb(state, orders)
    bot.sb = fake.sb
    return bot, fake


async def _async_return(value):
    return value


# ── Precision / unit conversion ─────────────────────────────────────────────────────────────────

def t_precision_and_minimum_enforcement():
    check("price rounds to 4 decimals", round_price(3.123456) == 3.1235, round_price(3.123456))
    check("size rounds to 2 decimals", round_size(1.236) == 1.24, round_size(1.236))
    check("a size at or above the 1.00 LIT minimum is accepted",
          clamp_order_size(1.70) == 1.70, clamp_order_size(1.70))
    check("a size that rounds below the 1.00 LIT minimum is refused (None)",
          clamp_order_size(0.994) is None, clamp_order_size(0.994))
    check("price_to_int scales by 10**PRICE_DECIMALS",
          price_to_int(3.1012) == round(3.1012 * 10 ** PRICE_DECIMALS), price_to_int(3.1012))
    check("size_to_int scales by 10**SIZE_DECIMALS",
          size_to_int(1.70) == round(1.70 * 10 ** SIZE_DECIMALS), size_to_int(1.70))


def t_order_fill_amounts_uses_real_human_decimal_units():
    o = FakeOrder(1, filled_base_amount=1.70, filled_quote_amount=5.27)
    qty, price = _order_fill_amounts(o)
    check("fill quantity is the real human-decimal value", abs(qty - 1.70) < 1e-9, qty)
    check("fill price is quote/base in real units", abs(price - (5.27 / 1.70)) < 1e-9, price)
    check("no fill yet reads as (0.0, None)",
          _order_fill_amounts(FakeOrder(2, filled_base_amount=0)) == (0.0, None),
          _order_fill_amounts(FakeOrder(2, filled_base_amount=0)))


def t_order_is_terminal_uses_remaining_amount_primarily():
    check("zero remaining is terminal regardless of status string",
          _order_is_terminal(FakeOrder(1, status="open", remaining_base_amount=0.0)) is True)
    check("nonzero remaining with an ordinary open status is NOT terminal",
          _order_is_terminal(FakeOrder(1, status="open", remaining_base_amount=0.7)) is False)
    check("a canceled-post-only style status is terminal even with remaining reported",
          _order_is_terminal(FakeOrder(1, status="canceled-post-only", remaining_base_amount=1.2)) is True)


# ── Exchange-request backoff (2026-10-22 real incident) ────────────────────────────────────────

def t_is_rate_limit_error_matches_429_and_nonce_not_unrelated_errors():
    check("a 429 message matches", core.LitGridLive._is_rate_limit_error(
        "(429)\nReason: Too Many Requests"))
    check("an 'invalid nonce' message matches, case-insensitively", core.LitGridLive._is_rate_limit_error(
        "HTTP response body: code=21104 message='Invalid Nonce'"))
    check("an unrelated rejection (bad price) does NOT match", not core.LitGridLive._is_rate_limit_error(
        "code=21101 message='invalid price'"))
    check("an unrelated rejection (insufficient margin) does NOT match", not core.LitGridLive._is_rate_limit_error(
        "insufficient margin for this order"))


async def t_passed_level_market_sell_is_floored_at_the_lots_cost():
    # 2026-10-22: the 0.5% slippage band is wider than a 0.125% step, so without a floor a
    # passed-level market sell could in principle fill below what the lot cost.
    bot, fake = make_bot(base_state())
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: 3.4500
    await bot.market_sell_level(10, 5.0, min_price=3.4480)
    sent = bot.client.placed[-1]
    check("worst allowed fill price is the lot's cost (rounded up), not mid - 0.5%",
          sent["avg_execution_price"] == price_to_int(3.4480), sent["avg_execution_price"])
    await bot.market_sell_level(11, 5.0)
    sent2 = bot.client.placed[-1]
    check("with no floor (flatten), the plain 0.5% band is unchanged",
          sent2["avg_execution_price"] == price_to_int(round_price(3.45 * 0.995)), sent2["avg_execution_price"])


async def t_reset_grid_waits_for_a_row_it_cannot_settle_yet():
    # Lighter publishes fills late. A row younger than GHOST_RESOLVE_S that the exchange no longer
    # shows might be a fill in flight -- closing it would drop that LIT from the ledger.
    bot, fake = _reset_fixture(active={}, young_ghost=core.now_iso())
    await bot.tick()
    rows = {r["id"]: r for r in fake.orders}
    check("the young unresolved row is left alone", rows[3]["status"] == "pending", rows[3]["status"])
    check("no re-anchor while it is unresolved; the flag stays set",
          fake.state.get("grid_anchor_price") == 3.30 and fake.state.get("grid_reset_requested") is True,
          (fake.state.get("grid_anchor_price"), fake.state.get("grid_reset_requested")))


def t_capital_corrected_multiplier_is_bounded():
    check("a near-zero cash reading cannot blow the multiplier up (cap 4x)",
          core.capital_corrected_spacing_multiplier(99.9, 0.0001, 10000.0) <= 4.0,
          core.capital_corrected_spacing_multiplier(99.9, 0.0001, 10000.0))
    check("never below 1x", core.capital_corrected_spacing_multiplier(10.0, 50000.0, 100.0) >= 1.0,
          core.capital_corrected_spacing_multiplier(10.0, 50000.0, 100.0))


def t_rate_limit_matching_ignores_prices_that_contain_429():
    check("a price containing 429 is not a rate limit",
          not core.LitGridLive._is_rate_limit_error("order rejected: price 3.4290 outside band"))
    check("a WAF 405 is a rate limit", core.LitGridLive._is_rate_limit_error("(405)\nReason: Not Allowed"))


async def t_flatten_uses_one_cancel_all_not_one_cancel_per_order():
    a = {"id": 1, "level": 900, "side": "buy", "status": "open", "client_order_index": 1,
         "exchange_order_id": 50, "limit_price": 3.00, "size": 1.70}
    b = {"id": 2, "level": 901, "side": "buy", "status": "open", "client_order_index": 2,
         "exchange_order_id": 51, "limit_price": 3.01, "size": 1.70}
    bot, fake = make_bot(base_state(flatten_requested=True), orders=[a, b],
                          active_orders_by_co={1: FakeOrder(1, order_index=50), 2: FakeOrder(2, order_index=51)})
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: 3.10
    await bot.flatten_all()
    check("one cancel-all transaction, no per-order cancels",
          getattr(bot.client, "cancel_all_calls", 0) == 1 and bot.client.cancelled == [],
          (getattr(bot.client, "cancel_all_calls", 0), bot.client.cancelled))

# ── Grid reset (one cancel-all tx, then re-anchor) ─────────────────────────────────────────────

def _reset_fixture(active=None, lit_real=6.0, young_ghost=None, **state_over):
    held = {"id": 1, "level": 10, "side": "buy", "status": "filled", "filled_qty": 6.0,
            "filled_price": 3.40, "size": 6.0, "closes_level": None}
    resting = {"id": 2, "level": 11, "side": "sell", "status": "open", "closes_level": 10,
               "client_order_index": 501, "exchange_order_id": 5001, "limit_price": 3.42, "size": 6.0,
               "placed_at": "2020-01-01T00:00:00+00:00"}
    ghost = {"id": 3, "level": 9, "side": "buy", "status": "pending", "client_order_index": 502,
             "exchange_order_id": None, "limit_price": 3.38, "size": 6.0,
             "placed_at": young_ghost or "2020-01-01T00:00:00+00:00"}
    st = base_state(grid_reset_requested=True, grid_anchor_price=3.30, internal_spacing_pct=0.125,
                    lit_balance=lit_real, **state_over)
    cancelled_501 = {501: FakeOrder(501, order_index=5001, status="canceled", remaining_base_amount=0.0)}
    bot, fake = make_bot(st, orders=[held, resting, ghost], active_orders_by_co=active or {},
                         orders_by_co=cancelled_501,
                         assets=[FakeAsset("USDC", 500.0, 0.0), FakeAsset("LIT", lit_real, 0.0)])
    bot.fetch_current_price = lambda: _async_return(3.45)
    return bot, fake


async def t_reset_grid_sends_one_cancel_all_while_orders_rest_on_the_exchange():
    bot, fake = _reset_fixture(active={501: FakeOrder(501, order_index=5001, status="open"),
                                       777: FakeOrder(777, order_index=7777, status="open")})
    await bot.tick()
    check("exactly one cancel-all transaction is sent (not one cancel per order)",
          getattr(bot.client, "cancel_all_calls", 0) == 1 and bot.client.cancelled == [],
          (getattr(bot.client, "cancel_all_calls", 0), bot.client.cancelled))
    check("no order is placed during the reset", bot.client.placed == [], bot.client.placed)
    check("the reset flag stays set until the exchange is actually clear",
          fake.state.get("grid_reset_requested") is True, fake.state.get("grid_reset_requested"))
    await bot.tick()
    check("a second tick inside the retry window does not resend the cancel-all",
          bot.client.cancel_all_calls == 1, bot.client.cancel_all_calls)


async def t_reset_grid_reanchors_once_the_exchange_is_clear():
    bot, fake = _reset_fixture(active={})
    await bot.tick()
    rows = {r["id"]: r for r in fake.orders}
    check("the order cancelled by the cancel-all is recorded as cancelled (exchange's own word)",
          rows[2]["status"] == "cancelled", rows[2]["status"])
    check("the ghost (never on the exchange, long past the visibility delay) is resolved",
          rows[3]["status"] == "rejected", rows[3]["status"])
    check("the held lot keeps its real fill price (cost basis untouched)",
          rows[1]["filled_price"] == 3.40 and rows[1]["status"] == "filled", rows[1])
    check("the grid is re-anchored (new anchor) and the flag cleared",
          fake.state.get("grid_anchor_price") not in (None, 3.30)
          and fake.state.get("grid_reset_requested") is False, fake.state)
    check("order size is cleared so the next tick resizes", fake.state.get("order_size_lit") is None,
          fake.state.get("order_size_lit"))
    check("nothing is sold or placed by the reset itself", bot.client.placed == [], bot.client.placed)
    check("completion is logged", any(r["action"] == "grid_reset_completed" for r in fake.runs), fake.runs)


async def t_reset_grid_never_reanchors_on_a_balance_mismatch():
    bot, fake = _reset_fixture(active={}, lit_real=9.0)
    await bot.tick()
    check("no re-anchor when ledger LIT (6) != real LIT (9)",
          fake.state.get("grid_anchor_price") == 3.30, fake.state.get("grid_anchor_price"))
    check("the flag stays set so a human can look",
          fake.state.get("grid_reset_requested") is True, fake.state.get("grid_reset_requested"))
    check("the block is logged",
          any(r["action"] == "grid_reset_blocked_balance_mismatch" for r in fake.runs), fake.runs)


async def t_reset_grid_does_nothing_when_the_active_orders_read_fails():
    bot, fake = _reset_fixture(active={})
    bot._order_api.active_orders_fail = True
    await bot.tick()
    rows = {r["id"]: r for r in fake.orders}
    check("a failed exchange read never counts as 'book is clear' -- nothing is closed",
          rows[2]["status"] == "open" and rows[3]["status"] == "pending", (rows[2]["status"], rows[3]["status"]))
    check("no cancel-all and no re-anchor", getattr(bot.client, "cancel_all_calls", 0) == 0
          and fake.state.get("grid_anchor_price") == 3.30, fake.state.get("grid_anchor_price"))


def t_rounding_does_not_shift_the_real_fill_price_bin():
    # Second audit's core finding, confirmed with plain arithmetic: a fill price is EXACTLY a
    # bin's lower boundary by construction, so rounding to 4 decimals can land in the bin below.
    step = math.log(1 + 0.125 / 100)
    lvl = 905
    exact = math.exp(lvl * step)
    rounded = round(exact, 4)
    check("this is a REAL, reproducible phenomenon (not claiming it's universal, just real here)",
          level_of(rounded, step) != lvl, (level_of(rounded, step), lvl))


# ── Order placement ──────────────────────────────────────────────────────────────────────────────

# ── Cancel: intermediate state, not assumed final ───────────────────────────────────────────────

async def t_cancel_requested_resolves_to_filled_if_a_fill_raced_it():
    # The exact race the audit flagged: we requested a cancel, but the exchange reports the
    # order actually filled anyway.
    row = {"id": 1, "level": 900, "side": "buy", "client_order_index": 777,
           "status": "cancel_requested", "limit_price": 3.10, "size": 1.70}
    raced_fill = FakeOrder(777, order_index=55, status="filled",
                            filled_base_amount=1.70, filled_quote_amount=5.27, remaining_base_amount=0.0)
    bot, fake = make_bot(base_state(), orders=[row], orders_by_co={777: raced_fill})
    await bot.reconcile_pending_orders()
    check("a cancel_requested order that actually filled is resolved to 'filled', not left as cancelled",
          fake.orders[0]["status"] == "filled", fake.orders[0])


# ── Holdings: quantity-aware running balance, explicit closes_level pairing ────────────────────

async def t_holdings_survives_rounding_via_explicit_closes_level():
    # The second audit's headline reproduction: buy recorded at level 905 (real cost = the exact
    # unrounded bin price), a sell that would, under the OLD level-inference design, round to
    # level 904 and break pairing. With explicit closes_level, pairing is correct regardless.
    step = math.log(1 + 0.125 / 100)
    real_cost = math.exp(905 * step)
    orders = [
        {"id": 1, "level": 905, "side": "buy", "status": "filled", "filled_qty": 1.70, "filled_price": real_cost},
        {"id": 2, "level": 904, "side": "sell", "closes_level": 905, "status": "filled",
         "filled_qty": 1.70, "filled_price": round_price(real_cost * 1.00125)},
    ]
    bot, fake = make_bot(base_state(), orders=orders)
    holdings = await bot.current_holdings()
    check("the sell correctly closes level 905 via explicit closes_level, regardless of its own display level",
          905 not in holdings, holdings)


async def t_holdings_partial_sell_leaves_correct_remaining_quantity():
    # Audit reproduction A: buy 1.70 LIT; sell 0.40 LIT, remainder cancelled. Must show 1.30 LIT
    # remaining, not zero.
    orders = [
        {"id": 1, "level": 900, "side": "buy", "status": "filled", "filled_qty": 1.70, "filled_price": 3.10},
        {"id": 2, "level": 901, "side": "sell", "closes_level": 900, "status": "filled",
         "filled_qty": 0.40, "filled_price": 3.1039},
    ]
    bot, fake = make_bot(base_state(), orders=orders)
    holdings = await bot.current_holdings()
    check("a partial sell reduces remaining quantity proportionally, not to zero",
          900 in holdings and abs(holdings[900]["qty"] - 1.30) < 1e-9, holdings.get(900))


async def t_holdings_aggregate_sell_closes_multiple_buys_at_one_level():
    # Audit reproduction B: buy 1 LIT, buy another 2 LIT at the same level, one aggregate 3 LIT
    # sell closes it all. Must end at zero, not a leftover count-based remainder.
    orders = [
        {"id": 1, "level": 900, "side": "buy", "status": "filled", "filled_qty": 1.0, "filled_price": 3.00},
        {"id": 2, "level": 900, "side": "buy", "status": "filled", "filled_qty": 2.0, "filled_price": 3.30},
        {"id": 3, "level": 901, "side": "sell", "closes_level": 900, "status": "filled",
         "filled_qty": 3.0, "filled_price": 3.31},
    ]
    bot, fake = make_bot(base_state(), orders=orders)
    holdings = await bot.current_holdings()
    check("a full aggregate sell closes out all buys at the level, regardless of how many orders",
          900 not in holdings, holdings)


async def t_holdings_repeat_cycle_at_the_same_level_is_not_erased():
    orders = [
        {"id": 1, "level": 900, "side": "buy", "status": "filled", "filled_qty": 1.70, "filled_price": 3.10},
        {"id": 2, "level": 901, "side": "sell", "closes_level": 900, "status": "filled",
         "filled_qty": 1.70, "filled_price": 3.1039},
        {"id": 3, "level": 900, "side": "buy", "status": "filled", "filled_qty": 1.65, "filled_price": 3.09},
    ]
    bot, fake = make_bot(base_state(), orders=orders)
    holdings = await bot.current_holdings()
    check("a second cycle's buy at a previously-closed level is tracked as current inventory",
          900 in holdings and abs(holdings[900]["qty"] - 1.65) < 1e-9, holdings.get(900))


# ── Balance divergence (fail-closed) ────────────────────────────────────────────────────────────

async def t_balance_divergence_pauses_new_orders():
    orders = [{"id": 1, "level": 900, "side": "buy", "status": "filled",
               "filled_qty": 5.0, "filled_price": 3.10}]
    bot, fake = make_bot(base_state(), orders=orders, assets=[FakeAsset("LIT", 2.0, 0.0)])
    safe, _refreshed = await bot.check_balance_divergence()
    check("a real divergence beyond tolerance blocks new order placement", safe is False, safe)


async def t_balance_check_fails_closed_on_the_very_first_call():
    bot, fake = make_bot(base_state(), account_api_fail=True)
    safe, _refreshed = await bot.check_balance_divergence()
    check("an unverifiable balance on the very first check fails CLOSED", safe is False, safe)


async def t_real_balances_prefers_margin_balance_over_plain_balance():
    bot, fake = make_bot(base_state(), assets=[
        FakeAsset("USDC", balance=0.0, locked_balance=0.0, margin_balance=544.549261262078),
    ])
    usdc, lit = await bot.real_balances()
    check("margin_balance is read as the real USDC total when present",
          abs(usdc - 544.549261262078) < 1e-6, usdc)


async def t_real_balances_reads_non_margin_lit_from_balance():
    # Exact shape returned live 2026-10-18 while holding 12.96 LIT, all of it resting in sells.
    bot, fake = make_bot(base_state(), assets=[
        FakeAsset("LIT", balance="12.96000000", locked_balance="12.96000000",
                  margin_balance="0.00000000", margin_mode="disabled"),
        FakeAsset("USDC", balance="0.000000", locked_balance="85.889808",
                  margin_balance="462.727611262078", margin_mode="enabled"),
    ])
    usdc, lit = await bot.real_balances()
    check("a non-margin LIT balance is read from balance, not its always-zero margin_balance",
          abs(lit - 12.96) < 1e-9, lit)
    check("locked LIT is part of balance, never added on top of it",
          abs(lit - 12.96) < 1e-9, lit)
    check("USDC in margin mode is still read from margin_balance",
          abs(usdc - 462.727611262078) < 1e-9, usdc)


# ── Window maintenance ───────────────────────────────────────────────────────────────────────────

# ── Spacing change ───────────────────────────────────────────────────────────────────────────────

async def t_tick_spacing_change_does_not_advance_if_cancel_fails():
    # External audit finding: a spacing-change cancel failure used to be silently ignored --
    # internal_spacing_pct advanced anyway, leaving an old order live under the new spacing.
    resting = {"id": 1, "level": 900, "side": "buy", "status": "open", "client_order_index": 1,
               "exchange_order_id": 77, "limit_price": 3.10, "size": 1.70}
    bot, fake = make_bot(base_state(spacing_pct=0.25, internal_spacing_pct=0.125,
                                     order_size_lit=1.70, usdc_balance=500.0), orders=[resting],
                          cancel_err="cancel rejected")
    bot.fetch_current_price = lambda: _async_return(3.10)
    await bot.tick()
    check("internal_spacing_pct does NOT advance while a cancel is still unresolved",
          fake.state["internal_spacing_pct"] == 0.125, fake.state)
    check("the old order is not falsely marked cancelled",
          fake.orders[0]["status"] != "cancel_requested" or fake.orders[0]["status"] != "cancelled",
          fake.orders[0])


async def t_tick_does_not_rewrite_an_unchanged_resting_order():
    # Speed fix: an order the exchange still reports as open, with nothing filled, must not be
    # re-written (or logged) every tick.
    resting = {"id": 1, "level": -2, "side": "buy", "status": "open", "client_order_index": 1,
               "exchange_order_id": 77, "limit_price": 3.0923, "size": 1.70}
    bot, fake = make_bot(base_state(order_size_lit=1.70, usdc_balance=500.0, grid_anchor_price=3.10),
                          orders=[resting], orders_by_co={1: FakeOrder(1, order_index=77, status="open")})
    bot.fetch_current_price = lambda: _async_return(3.10)
    writes, logs = [], []
    orig_sb = bot.sb
    async def spying_sb(method, path, body=None):
        if method == "PATCH" and path.startswith(core.TABLE_ORDERS) and "id=eq.1" in path:
            writes.append(body)
        if method == "POST" and path.startswith(core.TABLE_RUNS) and body and body.get("action") == "reconciled_order":
            logs.append(body)
        return await orig_sb(method, path, body)
    bot.sb = spying_sb
    await bot.tick()
    check("an unchanged resting order is not rewritten", writes == [], writes)
    check("an unchanged resting order is not logged", logs == [], logs)
    check("it is still open in the ledger", fake.orders[0]["status"] == "open", fake.orders[0])


async def t_tick_skips_new_decisions_when_reconciliation_fails():
    pending = {"id": 1, "level": 900, "side": "buy", "client_order_index": 555,
               "status": "pending", "limit_price": 3.10, "size": 1.70}
    bot, fake = make_bot(base_state(usdc_balance=500.0), orders=[pending], order_api_fail=True)
    bot.fetch_current_price = lambda: _async_return(3.10)
    await bot.tick()
    check("no new buys are placed when reconciliation itself failed this tick",
          not any(o["side"] == "buy" and o["id"] != 1 for o in fake.orders), fake.orders)


# ── Flatten ──────────────────────────────────────────────────────────────────────────────────────

async def t_flatten_sells_each_held_level_separately_with_correct_closes_level():
    # External audit finding: a single lump-sum flatten sell at a fake level=-1 broke the
    # ledger's level-based matching entirely. Flatten must sell per-level with real closes_level.
    held_a = {"id": 1, "level": 900, "side": "buy", "status": "filled",
              "filled_qty": 1.70, "filled_price": 3.10}
    held_b = {"id": 2, "level": 910, "side": "buy", "status": "filled",
              "filled_qty": 2.00, "filled_price": 3.15}
    bot, fake = make_bot(base_state(), orders=[held_a, held_b], assets=[FakeAsset("LIT", 3.70, 0.0)])
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: 3.10
    await bot.flatten_all()
    # One step per tick (2026-10-22): this pass sends the sells; the next confirms the account flat.
    bot._account_api.assets = [FakeAsset("LIT", 0.0, 0.0)]
    for o in fake.orders:   # the next tick comes after the exchange's visibility delay
        if o["side"] == "sell":
            o["placed_at"] = "2020-01-01T00:00:00+00:00"
    await bot.flatten_all()
    sell_rows = [o for o in fake.orders if o["side"] == "sell"]
    closes_levels = {o["closes_level"] for o in sell_rows}
    check("flatten places one sell per held level, each with the correct closes_level",
          closes_levels == {900, 910}, sell_rows)
    holdings_after = await bot.current_holdings()
    check("the ledger correctly shows nothing held after a full flatten",
          holdings_after == {}, holdings_after)
    check("the bot ends disabled after a VERIFIED-flat flatten", fake.state["enabled"] is False, fake.state)


async def t_flatten_does_not_report_completion_if_a_sell_failed():
    held = {"id": 1, "level": 900, "side": "buy", "status": "filled",
            "filled_qty": 1.70, "filled_price": 3.10}
    bot, fake = make_bot(base_state(flatten_requested=True), orders=[held],
                          assets=[FakeAsset("LIT", 1.70, 0.0)])
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: None  # stale book -- sell can't act
    await bot.flatten_all()
    check("flatten_requested stays true when a sell never actually happened",
          fake.state["flatten_requested"] is True, fake.state)
    check("flatten_incomplete is logged, not flatten_completed",
          any(r["action"] == "flatten_incomplete" for r in fake.runs)
          and not any(r["action"] == "flatten_completed" for r in fake.runs), fake.runs)


async def t_flatten_does_not_report_completion_if_a_cancel_failed():
    resting = {"id": 1, "level": 902, "side": "buy", "status": "open", "client_order_index": 1,
               "exchange_order_id": 55, "limit_price": 3.00, "size": 1.70}
    bot, fake = make_bot(base_state(flatten_requested=True), orders=[resting],
                          cancel_err="cancel rejected", assets=[FakeAsset("LIT", 0.0, 0.0)])
    await bot.flatten_all()
    check("flatten does not report completion when a cancel failed",
          not any(r["action"] == "flatten_completed" for r in fake.runs), fake.runs)


async def t_flatten_does_not_duplicate_sell_for_a_level_with_an_unresolved_resting_sell():
    # External audit finding (P1-2): a level whose previous flatten attempt's sell was still
    # unresolved (not yet confirmed terminal) could get a SECOND market sell fired against the
    # same inventory. Flatten must never attempt a level that still has an unresolved resting
    # sell working it.
    held = {"id": 1, "level": 900, "side": "buy", "status": "filled",
            "filled_qty": 1.70, "filled_price": 3.10}
    unresolved_sell = {"id": 2, "level": 901, "side": "sell", "closes_level": 900, "status": "open",
                        "client_order_index": 2, "exchange_order_id": 50,
                        "limit_price": 3.1039, "size": 1.70}
    bot, fake = make_bot(base_state(flatten_requested=True), orders=[held, unresolved_sell],
                          assets=[FakeAsset("LIT", 1.70, 0.0)])
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: 3.10
    await bot.flatten_all()
    new_sells = [o for o in fake.orders if o["side"] == "sell" and o["id"] != 2]
    check("flatten does not place a duplicate sell for a level an unresolved sell already works",
          len(new_sells) == 0, new_sells)
    check("flatten reports incomplete rather than falsely completing",
          not any(r["action"] == "flatten_completed" for r in fake.runs), fake.runs)


async def t_flatten_logs_dust_stuck_distinctly_for_an_unsellable_remainder():
    # External audit finding (P2-9): a terminal partial fill below the 1.00 LIT minimum has no
    # exit path -- clamp_order_size refuses it forever. Flatten must log this distinctly rather
    # than looking like an ordinary unresolved retry.
    held = {"id": 1, "level": 900, "side": "buy", "status": "filled",
            "filled_qty": 0.30, "filled_price": 3.10}
    bot, fake = make_bot(base_state(flatten_requested=True), orders=[held],
                          assets=[FakeAsset("LIT", 0.30, 0.0)])
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: 3.10
    await bot.flatten_all()
    check("a terminal remainder below the sellable minimum is logged distinctly",
          any(r["action"] == "flatten_dust_stuck" for r in fake.runs), fake.runs)
    # Audit 2026-10-22: dust under the 1 LIT minimum can never be sold; Flatten completes (and
    # stops the bot) instead of retrying forever, and says dust was left.
    check("flatten completes with unsellable dust left, and says so",
          any(r["action"] == "flatten_completed" and r["detail"].get("dust_left") for r in fake.runs)
          and fake.state["enabled"] is False, fake.runs)


# ── Atomic one-shot buy allowance ────────────────────────────────────────────────────────────────

# ── Pagination ───────────────────────────────────────────────────────────────────────────────────

async def t_current_holdings_paginates_past_a_single_page():
    # External audit finding (P1-5): an unpaginated query could silently truncate old inventory
    # on a long-running bot. Force a tiny page size and confirm every level still surfaces.
    orig_page_size = core.PAGE_SIZE
    core.PAGE_SIZE = 2
    try:
        orders = [
            {"id": i, "level": 900 + i, "side": "buy", "status": "filled",
             "filled_qty": 1.0, "filled_price": 3.0}
            for i in range(1, 6)
        ]
        bot, fake = make_bot(base_state(), orders=orders)
        holdings = await bot.current_holdings()
        check("every level surfaces even though the query spans several pages",
              set(holdings.keys()) == {901, 902, 903, 904, 905}, sorted(holdings.keys()))
    finally:
        core.PAGE_SIZE = orig_page_size


# ── Single-instance lock: loss mid-tick ─────────────────────────────────────────────────────────

async def t_touch_lock_heartbeat_detects_lock_loss_mid_tick():
    # External audit finding (P1-6): a dethroned instance used to keep believing it still held
    # the lock and kept placing real orders. A heartbeat write matching zero rows must clear
    # _lock_held immediately.
    bot, fake = make_bot(base_state(lock_owner="some-other-instance"))
    bot._lock_held = True
    await bot._touch_lock_heartbeat()
    check("losing the lock to another instance mid-tick clears _lock_held immediately",
          bot._lock_held is False, bot._lock_held)
    check("the loss is logged", any(r["action"] == "instance_lock_lost_mid_tick" for r in fake.runs), fake.runs)


# ── Stale cash between balance refreshes ────────────────────────────────────────────────────────

# ── Stale-unresolved-order visibility ───────────────────────────────────────────────────────────

async def t_reconcile_logs_a_warning_for_a_long_unresolved_order():
    # External audit finding (P2-10): an order absent from the exchange's own lookup used to be
    # silently skipped forever with no visibility, even once it's clearly beyond Lighter's finite
    # history window.
    old_pending = {"id": 1, "level": 900, "side": "buy", "client_order_index": 999,
                   "status": "pending", "limit_price": 3.10, "size": 1.70,
                   "placed_at": "2020-01-01T00:00:00+00:00"}
    bot, fake = make_bot(base_state(), orders=[old_pending])
    _all_ok, _usdc_delta, has_stale_unresolved = await bot.reconcile_pending_orders()
    check("an order missing from the exchange for far longer than the stale threshold is logged",
          any(r["action"] == "order_unresolved_stale" for r in fake.runs), fake.runs)
    check("reconcile reports the stale-unresolved condition back to the caller",
          has_stale_unresolved is True, has_stale_unresolved)


async def t_tick_blocks_new_entries_while_an_order_is_stale_unresolved():
    # External audit finding (P2-10/P2-6, fifth pass): a stale-unresolved order used to only be
    # logged -- new entries kept being placed elsewhere while that uncertainty sat unresolved.
    old_pending = {"id": 1, "level": 950, "side": "buy", "client_order_index": 999,
                   "status": "pending", "limit_price": 5.00, "size": 1.70,
                   "placed_at": "2020-01-01T00:00:00+00:00"}
    bot, fake = make_bot(base_state(levels_down=3, order_size_lit=1.70, usdc_balance=500.0),
                          orders=[old_pending])
    bot.fetch_current_price = lambda: _async_return(3.10)
    await bot.tick()
    new_buys = [o for o in fake.orders if o["side"] == "buy" and o["id"] != 1]
    check("no new buys are placed elsewhere while an order sits stale-unresolved",
          len(new_buys) == 0, new_buys)


async def t_reconcile_falls_back_to_active_orders_when_the_co_index_lookup_misses():
    # 2026-10-22: account_orders()'s lookup can lose visibility even for an order that's really
    # still resting (finite history window). account_active_orders() lists everything resting for
    # the account/market with no per-ID limitation -- it should still find and correctly process
    # a partial fill even when account_orders() itself returns nothing for this client_order_index.
    still_open = {"id": 1, "level": 900, "side": "buy", "client_order_index": 999,
                  "status": "pending", "limit_price": 3.10, "size": 1.70,
                  "placed_at": core.now_iso()}
    resting = FakeOrder(999, order_index=77, status="open",
                        filled_base_amount=0.80, filled_quote_amount=0.80 * 3.10,
                        remaining_base_amount=0.90)
    bot, fake = make_bot(base_state(), orders=[still_open], active_orders_by_co={999: resting})
    all_ok, _usdc_delta, has_stale_unresolved = await bot.reconcile_pending_orders()
    check("reconcile succeeds using the active-orders fallback", all_ok is True, all_ok)
    check("the row is NOT treated as stale/vanished -- the fallback found it resting",
          has_stale_unresolved is False, has_stale_unresolved)
    row = next(r for r in fake.orders if r["id"] == 1)
    check("the row's real exchange id and partial fill are picked up from the fallback lookup",
          row.get("exchange_order_id") == 77 and abs(row.get("filled_qty") - 0.80) < 1e-9,
          row)
    check("the row stays open (not yet terminal)", row.get("status") == "open", row)


async def t_reconcile_checks_active_orders_at_most_once_per_pass():
    # Fetched lazily, only when a row is actually missing from account_orders() -- and cached for
    # the rest of this same reconcile pass rather than re-fetched per row.
    a = {"id": 1, "level": 900, "side": "buy", "client_order_index": 1,
         "status": "pending", "limit_price": 3.10, "size": 1.70, "placed_at": core.now_iso()}
    b = {"id": 2, "level": 901, "side": "buy", "client_order_index": 2,
         "status": "pending", "limit_price": 3.09, "size": 1.70, "placed_at": core.now_iso()}
    bot, fake = make_bot(base_state(), orders=[a, b])
    await bot.reconcile_pending_orders()
    check("account_active_orders is called at most once for two misses in the same pass",
          bot._order_api.active_orders_calls == 1, bot._order_api.active_orders_calls)


async def t_reconcile_marks_a_row_vanished_from_both_lookups_as_rejected_once_stale():
    # The Worker 3 stuck-order incident (2026-10-22, real money): a sell order (row 846, level
    # 2056) got written to the ledger but never confirmed by the exchange -- absent from BOTH
    # account_orders() and account_active_orders() for hours, it blocked every spacing-change
    # cancel-and-reanchor forever (cancel_order_row refuses to act with no exchange_order_id, and
    # the row never left OPEN_STATUSES). Once confirmed absent from BOTH lookups past the stale
    # threshold, it must resolve to a terminal status instead of looping forever.
    vanished = {"id": 846, "level": 2056, "side": "sell", "client_order_index": 999,
                "status": "pending", "limit_price": 3.9489, "size": 33.39,
                "placed_at": "2020-01-01T00:00:00+00:00"}
    bot, fake = make_bot(base_state(), orders=[vanished])
    all_ok, _usdc_delta, has_stale_unresolved = await bot.reconcile_pending_orders()
    check("reconcile still succeeds (no read failures, just a confirmed absence)", all_ok is True, all_ok)
    check("the stale-unresolved condition is still reported for this pass",
          has_stale_unresolved is True, has_stale_unresolved)
    check("the vanished order is logged distinctly",
          any(r["action"] == "order_vanished_marked_rejected" for r in fake.runs), fake.runs)
    row = next(r for r in fake.orders if r["id"] == 846)
    check("the row resolves to rejected instead of looping forever",
          row.get("status") == "rejected", row)


async def t_tick_spacing_change_unsticks_once_the_vanished_order_resolves():
    # The actual symptom this fixes: a spacing change (e.g. gate-spacing-growth easing the tier)
    # cannot complete -- and therefore the bot never places anything else, forever -- while a
    # vanished order sits unresolved at a level the new grid needs to cancel through.
    held = {"id": 1, "level": 10, "side": "buy", "status": "filled",
            "filled_qty": 6.0, "filled_price": 3.70, "closes_level": None}
    vanished = {"id": 846, "level": 2056, "side": "sell", "client_order_index": 999,
                "status": "pending", "limit_price": 3.9489, "size": 33.39,
                "closes_level": 10, "placed_at": "2020-01-01T00:00:00+00:00"}
    bot, fake = make_bot(
        base_state(spacing_pct=0.125, internal_spacing_pct=0.25, lit_balance=6.0,
                   grid_anchor_price=3.80205, gate_spacing_growth_enabled=True,
                   dynamic_dd_enabled=True, dynamic_dd_tier=10),
        orders=[held, vanished],
        assets=[FakeAsset("USDC", 500.0, 0.0), FakeAsset("LIT", 6.0, 0.0)],
    )
    bot.fetch_current_price = lambda: _async_return(3.78)
    # Since 2026-10-26 the change asks for the clean reset on one tick and the reset finishes it.
    for _ in range(4):
        await bot.tick()
    check("the previously-vanished order is resolved, not still resting",
          next(r for r in fake.orders if r["id"] == 846)["status"] == "rejected",
          fake.orders)
    check("the spacing change completes instead of retrying forever",
          fake.state.get("internal_spacing_pct") == 0.125, fake.state)


# ── Lock-aware flatten (never acts after a confirmed handover) ──────────────────────────────────

async def t_flatten_aborts_if_the_lock_is_lost_during_the_cancel_loop():
    # External audit finding (P1, fourth independent audit): flatten_all() had NO lock checks at
    # all -- a dethroned worker could keep flattening after a handover, racing the replacement
    # worker over the same inventory.
    resting_a = {"id": 1, "level": 900, "side": "buy", "status": "open", "client_order_index": 1,
                 "exchange_order_id": 50, "limit_price": 3.00, "size": 1.70}
    resting_b = {"id": 2, "level": 901, "side": "buy", "status": "open", "client_order_index": 2,
                 "exchange_order_id": 51, "limit_price": 3.01, "size": 1.70}
    held = {"id": 3, "level": 902, "side": "buy", "status": "filled", "filled_qty": 1.70, "filled_price": 3.02}
    bot, fake = make_bot(base_state(flatten_requested=True), orders=[resting_a, resting_b, held],
                          assets=[FakeAsset("LIT", 1.70, 0.0)])
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: 3.10

    async def losing_cancel_all(context):
        bot._lock_held = False
        return True
    bot._cancel_all_on_exchange = losing_cancel_all
    await bot.flatten_all()
    check("no per-order cancels at all (one cancel-all)", bot.client.cancelled == [], bot.client.cancelled)
    check("no market sell was attempted after the lock was lost",
          not any(o["side"] == "sell" for o in fake.orders), fake.orders)
    check("the abort is logged distinctly", any(r["action"] == "flatten_aborted_lock_lost" for r in fake.runs), fake.runs)


async def t_flatten_aborts_if_the_lock_is_lost_during_the_sell_loop():
    held_a = {"id": 1, "level": 900, "side": "buy", "status": "filled", "filled_qty": 1.70, "filled_price": 3.00}
    held_b = {"id": 2, "level": 910, "side": "buy", "status": "filled", "filled_qty": 1.70, "filled_price": 3.15}
    bot, fake = make_bot(base_state(flatten_requested=True), orders=[held_a, held_b],
                          assets=[FakeAsset("LIT", 3.40, 0.0)])
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: 3.10
    orig_sell = bot.market_sell_level

    async def losing_sell(level, qty):
        row_id = await orig_sell(level, qty)
        bot._lock_held = False
        return row_id
    bot.market_sell_level = losing_sell
    await bot.flatten_all()
    sells = [o for o in fake.orders if o["side"] == "sell"]
    check("only one market sell went out before the lock loss stopped the loop",
          len(sells) == 1, sells)
    check("the abort is logged distinctly", any(r["action"] == "flatten_aborted_lock_lost" for r in fake.runs), fake.runs)


async def t_market_sell_level_refuses_without_the_lock():
    bot, fake = make_bot(base_state())
    bot._lock_held = False
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: 3.10
    row_id = await bot.market_sell_level(900, 1.70)
    check("market_sell_level refuses to act once the lock is already lost",
          row_id is None, row_id)
    check("no order row was written", fake.orders == [], fake.orders)


# ── Heartbeat fails CLOSED on an unverifiable write ─────────────────────────────────────────────

async def t_heartbeat_fails_closed_on_an_unverifiable_write():
    # External audit finding (P1, fourth independent audit): a network error on the heartbeat
    # PATCH used to just `return`, leaving _lock_held True (fail OPEN) -- the one inconsistency
    # with every other safety check in this file.
    bot, fake = make_bot(base_state())

    async def failing_sb(method, path, body=None):
        if method == "PATCH" and path.startswith(core.TABLE_STATE) and "lock_heartbeat" in (body or {}):
            raise RuntimeError("simulated network timeout")
        return await fake.sb(method, path, body)
    bot.sb = failing_sb
    ok = await bot._touch_lock_heartbeat()
    check("an unverifiable heartbeat write fails CLOSED, not open", ok is False, ok)
    check("_lock_held is cleared", bot._lock_held is False, bot._lock_held)
    check("the failure is logged distinctly",
          any(r["action"] == "instance_lock_heartbeat_unverifiable" for r in fake.runs), fake.runs)


# ── Cash correction persists across ticks ───────────────────────────────────────────────────────

# ── Eighth-pass changes (direct request + seventh independent audit) ───────────────────────────

def _grid_rows(P, held, sells_for, buys_at, sold=()):
    rows, i = [], 1
    for k in held:
        rows.append({"id": i, "level": k, "side": "buy", "status": "filled", "filled_qty": 2.16,
                     "filled_price": round(P * 1.00125 ** k, 4), "size": 2.16}); i += 1
    for k in sold:
        rows.append({"id": i, "level": k, "side": "buy", "status": "filled", "filled_qty": 2.16,
                     "filled_price": round(P * 1.00125 ** k, 4), "size": 2.16}); i += 1
        rows.append({"id": i, "level": k + 1, "side": "sell", "status": "filled", "closes_level": k,
                     "filled_qty": 2.16, "filled_price": round(P * 1.00125 ** (k + 1), 4),
                     "size": 2.16, "client_order_index": 900 + i}); i += 1
    for k in sells_for:
        rows.append({"id": i, "level": k + 1, "side": "sell", "status": "open", "closes_level": k,
                     "client_order_index": 100 + i, "exchange_order_id": 1000 + i, "size": 2.16,
                     "limit_price": core.round_price(P * 1.00125 ** (k + 1))}); i += 1
    for k in buys_at:
        rows.append({"id": i, "level": k, "side": "buy", "status": "open",
                     "client_order_index": 100 + i, "exchange_order_id": 1000 + i, "size": 2.16,
                     "limit_price": core.round_price(P * 1.00125 ** k)}); i += 1
    return rows


async def t_a_partly_filled_open_buy_does_not_trip_the_balance_pause():
    # Live 20:30: buy at 2.8836 filled 0.54 of 2.19 and stayed open; holdings only count full
    # fills, so the 0.54 real LIT read as a divergence and paused all new buys.
    held = {"id": 1, "level": 0, "side": "buy", "status": "filled", "filled_qty": 2.16,
            "filled_price": 3.0, "size": 2.16}
    partial = {"id": 2, "level": -1, "side": "buy", "status": "open", "filled_qty": 0.54,
               "filled_price": 2.99, "size": 2.19, "client_order_index": 2, "limit_price": 2.99}
    bot, fake = make_bot(base_state(), orders=[held, partial],
                          assets=[FakeAsset("LIT", 2.70, 0.0), FakeAsset("USDC", 0, 0, margin_balance=490.0)])
    safe, refreshed = await bot.check_balance_divergence()
    check("a partly filled open buy counts as held LIT -- no pause", safe is True and refreshed, (safe, refreshed))


async def t_dynamic_drawdown_sizes_on_available_cash_and_follows_the_gates():
    # Toggle on: high = price at switch-on, tier 10, size = spendable cash spread down to 10%
    # below the high. A 6% drop switches to 20% and re-sizes on the cash left; a further fall
    # past 20% -> 99.9%; back above -5% -> 10% again (same gates both ways).
    P = 2.83365
    bot, fake = make_bot(base_state(levels_up=5, levels_down=5, order_size_lit=None,
                                     usdc_balance=6500.0, capital_usd=6500.0, grid_anchor_price=P,
                                     dynamic_dd_enabled=True), orders=_grid_rows(P, held=[], sells_for=[], buys_at=[]))
    logged = []
    orig = bot.log_run
    async def spy(action, detail, orig=orig):
        logged.append((action, detail))
        return await orig(action, detail)
    bot.log_run = spy
    st = fake.state
    sizes = {}
    for label, price in (("start", P), ("drop6", P * 0.94), ("drop22", P * 0.78), ("back", P * 0.97)):
        await bot._dynamic_order_size(st, price, 0.125, {}, {})
        sizes[label] = (st["dynamic_dd_tier"], st["order_size_lit"], st["dynamic_dd_high"])
    check("starts at tier 10 with the high = price at switch-on",
          sizes["start"][0] == 10 and abs(sizes["start"][2] - P) < 1e-9, sizes)
    expect = core.compute_order_size_lit(6500.0, P, 0.125, core.levels_for_drawdown(0.125, 10))
    check("tier-10 size spreads the spendable cash down to 10% below the high",
          abs(sizes["start"][1] - expect) < 1e-6, (sizes["start"][1], expect))
    check("6% drop -> tier 20", sizes["drop6"][0] == 20, sizes)
    check("22% drop -> deepest tier 99.9 (was 80 until 2026-10-23)", sizes["drop22"][0] == 99.9, sizes)
    check("back within 5% of the high -> tier 10 again", sizes["back"][0] == 10, sizes)
    check("the high does not move on the way down", sizes["drop22"][2] == P, sizes)
    check("each switch is logged", [d["to"] for a, d in logged if a == "dynamic_drawdown_switch"] == [10, 20, 99.9, 10], logged)
    n = len(logged)
    await bot._dynamic_order_size(st, P * 0.97, 0.125, {}, {})
    check("no re-size while the tier is unchanged", len(logged) == n, logged[n:])
    await bot._dynamic_order_size(st, P * 1.02, 0.125, {}, {})
    check("a new high is tracked", abs(st["dynamic_dd_high"] - P * 1.02) < 1e-9, st["dynamic_dd_high"])


async def t_dynamic_drawdown_resize_uses_cash_left_not_the_full_investment():
    # Half the money already sits in LIT: the 20% tier is sized on the cash actually left.
    P = 2.83365
    rows = _grid_rows(P, held=range(0, 5), sells_for=range(0, 5), buys_at=[])
    bot, fake = make_bot(base_state(levels_up=5, levels_down=5, order_size_lit=None,
                                     usdc_balance=3000.0, capital_usd=6500.0, grid_anchor_price=P,
                                     dynamic_dd_enabled=True, dynamic_dd_high=P, dynamic_dd_tier=10),
                          orders=rows)
    holdings = await bot.current_holdings()
    price = P * 0.94
    _, _, available = bot._funding(fake.state, holdings, {})
    await bot._dynamic_order_size(fake.state, price, 0.125, holdings, {})
    drop = 6.0
    cover = (20 - drop) / (1 - drop / 100)
    expect = core.compute_order_size_lit(available, price, 0.125, core.levels_for_drawdown(0.125, cover))
    check("20% tier sized on the cash left (not $6,500)",
          abs(fake.state["order_size_lit"] - expect) < 1e-6 and available <= 3000.0,
          (fake.state["order_size_lit"], expect, available))


async def t_reconcile_row_write_failure_forces_a_fresh_balance_check_next_tick():
    # External audit finding (seventh independent audit): a row-write exception might mean the
    # write actually committed and only the HTTP response was lost -- not proof nothing happened.
    buy_a = {"id": 1, "level": 900, "side": "buy", "client_order_index": 111,
             "status": "pending", "limit_price": 3.00, "size": 1.70}
    filled_a = FakeOrder(111, order_index=55, status="filled",
                          filled_base_amount=1.70, filled_quote_amount=1.70 * 3.00, remaining_base_amount=0.0)
    bot, fake = make_bot(base_state(), orders=[buy_a], orders_by_co={111: filled_a})
    bot._last_balance_check = time.time()
    orig_sb = bot.sb

    async def failing_on_row_1(method, path, body=None):
        if method == "PATCH" and path.startswith(core.TABLE_ORDERS) and "id=eq.1" in path:
            raise RuntimeError("simulated lost response, write may have actually committed")
        return await orig_sb(method, path, body)
    bot.sb = failing_on_row_1
    await bot.reconcile_pending_orders()
    check("a row-write failure fails closed, pausing new entries", bot._balance_paused is True, bot._balance_paused)
    check("it also resets the refresh timer so the next tick forces a real check",
          bot._last_balance_check == 0.0, bot._last_balance_check)


async def t_check_balance_divergence_does_not_advance_timer_if_the_save_fails():
    # External audit finding (seventh independent audit): advancing the refresh timer BEFORE
    # the fresh balance was actually saved meant a failed save left the next tick believing a
    # refresh had just succeeded, skipping a real one and trusting stale cash with no pause.
    bot, fake = make_bot(base_state(usdc_balance=6.0),
                          assets=[FakeAsset("USDC", balance=0, locked_balance=0, margin_balance=0.73459)])
    orig_sb = bot.sb

    async def failing_save(method, path, body=None):
        if (method == "PATCH" and path.startswith(core.TABLE_STATE)
                and body and "usdc_balance" in body and "lit_balance" in body):
            raise RuntimeError("simulated save failure")
        return await orig_sb(method, path, body)
    bot.sb = failing_save
    safe, refreshed = await bot.check_balance_divergence()
    check("a failed snapshot save fails closed", safe is False, safe)
    check("the refresh timer is NOT advanced, so the next tick retries a real check immediately",
          bot._last_balance_check == 0.0, bot._last_balance_check)


# ── Seventh-pass redesign (sixth independent audit) ─────────────────────────────────────────────

async def t_reconcile_isolates_a_per_row_write_failure_without_losing_other_rows_deltas():
    # External audit finding (sixth independent audit): a single row's PATCH write failing used
    # to raise UNCAUGHT out of reconcile_pending_orders() entirely, losing every OTHER row's
    # already-computed cash delta this pass -- and since a row whose write DID succeed is now
    # 'filled' (dropped from every future scan), that delta could never be recovered later.
    buy_a = {"id": 1, "level": 900, "side": "buy", "client_order_index": 111,
             "status": "pending", "limit_price": 3.00, "size": 1.70}
    buy_b = {"id": 2, "level": 901, "side": "buy", "client_order_index": 222,
             "status": "pending", "limit_price": 3.10, "size": 1.70}
    filled_a = FakeOrder(111, order_index=55, status="filled",
                          filled_base_amount=1.70, filled_quote_amount=1.70 * 3.00, remaining_base_amount=0.0)
    filled_b = FakeOrder(222, order_index=56, status="filled",
                          filled_base_amount=1.70, filled_quote_amount=1.70 * 3.10, remaining_base_amount=0.0)
    bot, fake = make_bot(base_state(), orders=[buy_a, buy_b], orders_by_co={111: filled_a, 222: filled_b})
    orig_sb = bot.sb

    async def failing_on_row_2(method, path, body=None):
        if method == "PATCH" and path.startswith(core.TABLE_ORDERS) and "id=eq.2" in path:
            raise RuntimeError("simulated row write failure")
        return await orig_sb(method, path, body)
    bot.sb = failing_on_row_2
    all_ok, usdc_delta, _stale = await bot.reconcile_pending_orders()
    check("the batch is reported as not fully ok", all_ok is False, all_ok)
    check("the other row's successfully-written delta is still counted this pass",
          abs(usdc_delta - (-1.70 * 3.00)) < 1e-6, usdc_delta)
    check("the failed row was never actually persisted as filled, so it's recomputed correctly next pass",
          fake.orders[1]["status"] == "pending", fake.orders[1])


async def t_cancelled_buy_releases_its_reservation_automatically():
    # External audit finding (sixth independent audit), fixed by construction: a confirmed
    # cancellation never released an unfilled buy's coverage reservation under the old mutable
    # model. Under the derived model a cancelled row just isn't in OPEN_STATUSES anymore --
    # nothing extra to write, the reservation releases itself.
    old_credit = {"id": 90, "side": "sell", "status": "filled", "realized_profit_usd": 10.0,
                  "profit_bucket_destination": "profit_bucket_cover_drop_usd"}
    cancelled_buy = {"id": 1, "side": "buy", "status": "cancelled", "filled_qty": 0,
                      "size": 1.70, "funded_from_bucket_usd": 4.25895}
    bot, fake = make_bot(base_state(), orders=[old_credit, cancelled_buy])
    buckets = await bot._bucket_balances()
    check("a confirmed cancellation's reservation is not counted -- released automatically",
          abs(buckets["profit_bucket_cover_drop_usd"] - 10.0) < 1e-6, buckets)


# ── Rest cap + overflow + withdrawals (2026-10-20, direct request) ──────────────────────────────

def _rest_cap_fixture(state_over, prior_rest=0.0, prior_dest="profit_bucket_rest_usd"):
    buy = {"id": 1, "level": 900, "side": "buy", "status": "filled", "filled_qty": 1.0, "filled_price": 3.00}
    sell_row = {"id": 2, "level": 901, "side": "sell", "closes_level": 900, "client_order_index": 555,
                "status": "pending", "limit_price": 3.10, "size": 1.0}
    old = {"id": 3, "level": 850, "side": "sell", "closes_level": 849, "status": "filled",
           "realized_profit_usd": prior_rest, "profit_bucket_destination": prior_dest}
    filled = FakeOrder(555, order_index=77, status="filled",
                       filled_base_amount=1.0, filled_quote_amount=3.10, remaining_base_amount=0.0)
    return make_bot(base_state(**state_over), orders=[buy, sell_row, old], orders_by_co={555: filled})


async def t_rest_cap_below_cap_profit_stays_in_rest():
    bot, fake = _rest_cap_fixture({}, prior_rest=5.0)
    await bot.reconcile_pending_orders(profit_mode="rest", route={"cap": 10, "overflow": "compound"})
    check("below the cap, profit goes to rest",
          fake.orders[1]["profit_bucket_destination"] == "profit_bucket_rest_usd", fake.orders[1])


async def t_rest_cap_full_rest_overflows_to_chosen_bucket():
    for overflow, col in (("compound", "profit_bucket_compound_usd"), ("cover_drop", "profit_bucket_cover_drop_usd")):
        bot, fake = _rest_cap_fixture({}, prior_rest=10.0)
        await bot.reconcile_pending_orders(profit_mode="rest", route={"cap": 10, "overflow": overflow})
        check(f"rest at the cap sends new profit to {overflow}",
              fake.orders[1]["profit_bucket_destination"] == col, fake.orders[1])


async def t_rest_cap_withdrawal_reopens_rest():
    bot, fake = _rest_cap_fixture({}, prior_rest=10.0)
    await bot.reconcile_pending_orders(profit_mode="rest",
                                       route={"cap": 10, "overflow": "compound", "withdrawn": 4.0})
    check("after a withdrawal rest is under the cap again and refills",
          fake.orders[1]["profit_bucket_destination"] == "profit_bucket_rest_usd", fake.orders[1])
    buckets = await bot._bucket_balances(rest_withdrawn=4.0)
    check("rest bucket shows profit minus withdrawals",
          abs(buckets["profit_bucket_rest_usd"] - (10.0 + 0.10 - 4.0)) < 1e-6, buckets)


async def t_rest_cap_ignored_outside_rest_mode_or_without_cap():
    bot, fake = _rest_cap_fixture({}, prior_rest=10.0)
    await bot.reconcile_pending_orders(profit_mode="compound", route={"cap": 1, "overflow": "cover_drop"})
    check("compound mode ignores the rest cap",
          fake.orders[1]["profit_bucket_destination"] == "profit_bucket_compound_usd", fake.orders[1])
    bot, fake = _rest_cap_fixture({}, prior_rest=10.0)
    await bot.reconcile_pending_orders(profit_mode="rest", route={"cap": None, "overflow": "compound"})
    check("no cap set: rest keeps everything",
          fake.orders[1]["profit_bucket_destination"] == "profit_bucket_rest_usd", fake.orders[1])
    bot, fake = _rest_cap_fixture({}, prior_rest=10.0)
    await bot.reconcile_pending_orders(profit_mode="rest", route={"cap": 5, "overflow": None})
    check("no destination set: rest keeps everything",
          fake.orders[1]["profit_bucket_destination"] == "profit_bucket_rest_usd", fake.orders[1])


async def t_tick_passes_rest_cap_from_state():
    bot, fake = _rest_cap_fixture({"rest_cap_usd": 10, "rest_overflow_to": "compound",
                                   "rest_withdrawn_usd": 0}, prior_rest=10.0)
    seen = {}
    orig = bot.reconcile_pending_orders
    async def spy(profit_mode=None, route=None):
        seen["route"] = route
        return True, 0.0, False
    bot.reconcile_pending_orders = spy
    bot.check_balance_divergence = lambda **kw: _async_return((True, False))
    bot.fetch_current_price = lambda: _async_return(None)
    bot._apply_usdc_delta = lambda d: _async_return(None)
    await bot._tick()
    check("tick hands the state's cap/destination/withdrawn to reconcile",
          seen.get("route") == {"cap": 10, "overflow": "compound", "withdrawn": 0}, seen)


# ── Profit allocation (direct request) ──────────────────────────────────────────────────────────

async def t_reconcile_credits_realized_profit_to_the_active_bucket():
    buy = {"id": 1, "level": 900, "side": "buy", "status": "filled", "filled_qty": 1.70, "filled_price": 3.00}
    sell_row = {"id": 2, "level": 901, "side": "sell", "closes_level": 900, "client_order_index": 555,
                "status": "pending", "limit_price": 3.10, "size": 1.70}
    filled_sell = FakeOrder(555, order_index=77, status="filled",
                             filled_base_amount=1.70, filled_quote_amount=1.70 * 3.10, remaining_base_amount=0.0)
    bot, fake = make_bot(base_state(profit_mode="rest"), orders=[buy, sell_row], orders_by_co={555: filled_sell})
    await bot.reconcile_pending_orders(profit_mode="rest")
    check("the profit is recorded on the sell's own row, atomic with its filled status",
          fake.orders[1].get("realized_profit_usd") is not None, fake.orders[1])
    # Profit allocation is PURE DERIVED now (external audit fix, seventh pass) -- no separate
    # flush/credit step; _bucket_balances() reads it straight off the ledger, immediately.
    buckets = await bot._bucket_balances()
    expected_profit = 1.70 * (3.10 - 3.00)
    check("realized profit on a sell fill is reflected in the active bucket immediately",
          abs(buckets["profit_bucket_rest_usd"] - expected_profit) < 1e-6, buckets)


async def t_profit_bucket_balance_untouched_by_a_mode_switch():
    # Direct request: switching profit_mode only changes where NEW profit goes -- money already
    # earmarked for a different bucket's purpose must never move.
    buy = {"id": 1, "level": 900, "side": "buy", "status": "filled", "filled_qty": 1.0, "filled_price": 3.00}
    sell_row = {"id": 2, "level": 901, "side": "sell", "closes_level": 900, "client_order_index": 555,
                "status": "pending", "limit_price": 3.10, "size": 1.0}
    filled_sell = FakeOrder(555, order_index=77, status="filled",
                            filled_base_amount=1.0, filled_quote_amount=1.0 * 3.10, remaining_base_amount=0.0)
    # An EARLIER sell already routed profit to cover_drop (simulating money from a prior mode).
    old_sell = {"id": 3, "level": 850, "side": "sell", "closes_level": 849, "status": "filled",
                "realized_profit_usd": 20.0, "profit_bucket_destination": "profit_bucket_cover_drop_usd"}
    bot, fake = make_bot(base_state(profit_mode="compound"),
                          orders=[buy, sell_row, old_sell], orders_by_co={555: filled_sell})
    await bot.reconcile_pending_orders(profit_mode="compound")
    buckets = await bot._bucket_balances()
    check("new profit goes to the currently active bucket (compound), not an old one",
          buckets["profit_bucket_compound_usd"] > 0, buckets)
    check("a previously-selected bucket's balance is untouched by the mode switch",
          buckets["profit_bucket_cover_drop_usd"] == 20.0, buckets)


# ── Sixth-pass fixes (fifth independent audit) ──────────────────────────────────────────────────

async def t_tick_persists_cash_delta_even_when_price_is_unavailable():
    # External audit finding (sixth pass): a missing price used to make tick() return BEFORE
    # persisting the cash delta, permanently losing a correction that can never be recomputed
    # once its order has already left the reconcilable set.
    pending_buy = {"id": 1, "level": 900, "side": "buy", "client_order_index": 777,
                   "status": "pending", "limit_price": 3.10, "size": 1.70}
    filled = FakeOrder(777, order_index=55, status="filled",
                        filled_base_amount=1.70, filled_quote_amount=1.70 * 3.10, remaining_base_amount=0.0)
    bot, fake = make_bot(base_state(usdc_balance=10.0), orders=[pending_buy], orders_by_co={777: filled})
    bot._last_balance_check = time.time()  # skip the periodic real-balance refresh this tick
    bot.fetch_current_price = lambda: _async_return(None)  # simulated price outage
    await bot.tick()
    check("the cash delta is persisted even though tick() returns early for a missing price",
          abs(float(fake.state["usdc_balance"]) - (10.0 - 1.70 * 3.10)) < 1e-6, fake.state["usdc_balance"])


async def t_tick_fails_closed_if_the_cash_delta_persist_write_itself_fails():
    pending_buy = {"id": 1, "level": 900, "side": "buy", "client_order_index": 777,
                   "status": "pending", "limit_price": 3.10, "size": 1.70}
    filled = FakeOrder(777, order_index=55, status="filled",
                        filled_base_amount=1.70, filled_quote_amount=1.70 * 3.10, remaining_base_amount=0.0)
    bot, fake = make_bot(base_state(usdc_balance=10.0), orders=[pending_buy], orders_by_co={777: filled})
    bot._last_balance_check = time.time()  # isolate the cash-delta persist from the (unrelated)
                                            # periodic real-balance refresh's own usdc_balance write
    orig_sb = bot.sb

    async def failing_usdc_patch(method, path, body=None):
        if method == "PATCH" and path.startswith(core.TABLE_STATE) and body and "usdc_balance" in body and "lit_balance" not in body:
            raise RuntimeError("simulated write failure")
        return await orig_sb(method, path, body)
    bot.sb = failing_usdc_patch
    bot.fetch_current_price = lambda: _async_return(3.10)
    await bot.tick()
    check("a failed cash-delta persist fails CLOSED", bot._balance_paused is True, bot._balance_paused)
    check("the failure is logged", any(r["action"] == "cash_delta_persist_failed" for r in fake.runs), fake.runs)


async def t_tick_persists_a_fresh_derived_bucket_snapshot_before_maintain_window():
    old_sell = {"id": 1, "side": "sell", "status": "filled", "realized_profit_usd": 0.17,
                "profit_bucket_destination": "profit_bucket_cover_drop_usd"}
    bot, fake = make_bot(base_state(levels_down=1, order_size_lit=None, usdc_balance=500.0, capital_usd=500),
                          orders=[old_sell])
    bot.fetch_current_price = lambda: _async_return(3.10)
    await bot.tick()
    check("a prior sell's realized profit is reflected in the bucket snapshot this same tick",
          abs(float(fake.state["profit_bucket_cover_drop_usd"]) - 0.17) < 1e-6,
          fake.state["profit_bucket_cover_drop_usd"])


async def t_cover_drop_room_rises_automatically_once_a_funded_position_sells():
    # External audit finding (sixth pass), fixed by construction under the seventh-pass derived
    # model: cover_drop money spent funding a buy never came back when that position was later
    # sold. "Coming back" needs no extra step now -- selling removes the position from
    # current_holdings(), which is exactly what the derived figure subtracts in the first place.
    old_credit = {"id": 90, "side": "sell", "status": "filled", "realized_profit_usd": 20.0,
                  "profit_bucket_destination": "profit_bucket_cover_drop_usd"}
    buy = {"id": 1, "level": 900, "side": "buy", "status": "filled", "filled_qty": 1.70,
           "filled_price": 3.00, "size": 1.70, "funded_from_bucket_usd": 4.00}
    sell_row = {"id": 2, "level": 901, "side": "sell", "closes_level": 900, "client_order_index": 555,
                "status": "pending", "limit_price": 3.10, "size": 1.70}
    filled_sell = FakeOrder(555, order_index=77, status="filled",
                             filled_base_amount=1.70, filled_quote_amount=1.70 * 3.10, remaining_base_amount=0.0)
    bot, fake = make_bot(base_state(profit_mode="rest"), orders=[old_credit, buy, sell_row],
                          orders_by_co={555: filled_sell})
    buckets_before = await bot._bucket_balances()
    check("before selling, the bucket-funded position's cost reduces spendable room",
          abs(buckets_before["profit_bucket_cover_drop_usd"] - (20.0 - 4.00)) < 1e-6, buckets_before)
    await bot.reconcile_pending_orders(profit_mode="rest")
    buckets_after = await bot._bucket_balances()
    check("once sold, that position's cost no longer reduces it -- cover_drop room rises back "
          "on its own, with no separate 'return principal' step",
          abs(buckets_after["profit_bucket_cover_drop_usd"] - 20.0) < 1e-6, buckets_after)
    check("the NEW realized profit from this sell goes to the active mode's bucket (rest), "
          "separate from cover_drop's own principal return",
          abs(buckets_after["profit_bucket_rest_usd"] - 1.70 * (3.10 - 3.00)) < 1e-6, buckets_after)


async def t_bucket_balances_recompute_correctly_on_every_call():
    # External audit finding (sixth pass): retrying the old credit-flush mechanism could
    # double-apply a credit if a write failed or its response was lost. Under the derived model
    # (seventh pass) there is nothing to double-apply -- tick()'s own write of this figure is
    # purely a display snapshot; even if THAT write failed outright, the next call here still
    # derives the exact correct figure straight from the ledger, every time, with no retry logic.
    old_sell = {"id": 1, "side": "sell", "status": "filled", "realized_profit_usd": 0.17,
                "profit_bucket_destination": "profit_bucket_rest_usd"}
    bot, fake = make_bot(base_state())
    fake.orders.append(old_sell)
    first = await bot._bucket_balances()
    second = await bot._bucket_balances()
    check("the derived figure is identical and correct across repeated calls -- nothing to lose or duplicate",
          first["profit_bucket_rest_usd"] == second["profit_bucket_rest_usd"] == 0.17, (first, second))


async def t_reconcile_uses_real_quote_delta_across_multiple_partial_fill_passes():
    # External audit finding (sixth pass): the old code multiplied the NEW quantity by the
    # latest CUMULATIVE AVERAGE price -- wrong the moment per-fill prices differ across passes.
    buy = {"id": 1, "level": 900, "side": "buy", "status": "filled", "filled_qty": 1.0, "filled_price": 3.00}
    sell_row = {"id": 2, "level": 901, "side": "sell", "closes_level": 900, "client_order_index": 555,
                "status": "pending", "limit_price": 3.10, "size": 1.0}
    bot, fake = make_bot(base_state(profit_mode="rest"), orders=[buy, sell_row])
    bot._order_api.orders_by_co = {555: FakeOrder(555, order_index=77, status="open",
                                                   filled_base_amount=0.50, filled_quote_amount=0.50 * 3.10,
                                                   remaining_base_amount=0.50)}
    await bot.reconcile_pending_orders(profit_mode="rest")
    bot._order_api.orders_by_co = {555: FakeOrder(555, order_index=77, status="filled",
                                                   filled_base_amount=1.00,
                                                   filled_quote_amount=0.50 * 3.10 + 0.50 * 3.20,
                                                   remaining_base_amount=0.0)}
    await bot.reconcile_pending_orders(profit_mode="rest")
    buckets = await bot._bucket_balances()
    expected_profit = (0.50 * 3.10 + 0.50 * 3.20) - 1.0 * 3.00
    check("profit across a multi-price partial fill uses real per-increment proceeds, not qty*average",
          abs(buckets["profit_bucket_rest_usd"] - expected_profit) < 1e-6, buckets)


async def t_tick_resizes_immediately_when_compound_bucket_grows():
    old_sell = {"id": 1, "side": "sell", "status": "filled", "realized_profit_usd": 500.0,
                "profit_bucket_destination": "profit_bucket_compound_usd"}
    # 2026-10-23: resizes once compound has grown by 0.2% of the Investment since the recorded
    # baseline (here $0 -> $500, far past the $1 step).
    bot, fake = make_bot(base_state(order_size_lit=1.70, levels_down=1, capital_usd=500,
                                     drawdown_pct=10, usdc_balance=5000.0,
                                     compound_resize={"compound_usd": 0.0}), orders=[old_sell])
    bot.fetch_current_price = lambda: _async_return(3.10)
    await bot.tick()
    check("crediting the compound bucket triggers an immediate resize reflecting the bigger basis",
          fake.state["order_size_lit"] is not None and fake.state["order_size_lit"] > 1.70,
          fake.state["order_size_lit"])


# ── Window hysteresis ────────────────────────────────────────────────────────────────────────────

# ── Lock heartbeat ───────────────────────────────────────────────────────────────────────────────

# ── Rate-limit backoff ──────────────────────────────────────────────────────────────────────────

async def t_rate_limited_errors_back_off_before_retrying():
    class RateLimitedBot:
        async def log_run(self, *_a, **_k):
            pass
        async def acquire_lock(self):
            raise RuntimeError("429 Too Many Requests!")
        async def tick(self):
            pass
        async def release_lock(self):
            pass

    orig_tick_every = core.TICK_EVERY
    orig_sleep = asyncio.sleep
    sleeps = []

    async def fake_sleep(secs):
        sleeps.append(secs)
        if len(sleeps) >= 4:
            raise asyncio.CancelledError()
        await orig_sleep(0)

    core.TICK_EVERY = 3.0
    asyncio.sleep = fake_sleep
    try:
        try:
            await core._run_tick_loop(RateLimitedBot())
        except asyncio.CancelledError:
            pass
    finally:
        core.TICK_EVERY = orig_tick_every
        asyncio.sleep = orig_sleep
    check("the first retry after a 429 waits longer than the normal tick interval",
          len(sleeps) >= 2 and sleeps[0] > core.TICK_EVERY, sleeps)
    check("backoff grows on repeated 429s instead of staying flat",
          len(sleeps) >= 2 and sleeps[1] > sleeps[0], sleeps)



# ── Spacing change re-anchors held lots (2026-10-20) ─────────────────────────────────────────────

def _reanchor_ledger(A, step, lots, closed=()):
    """Filled buys at old lines `lots` (line -> cost) plus fully closed history at `closed` lines."""
    rows, i = [], 1
    for k in closed:
        px = round(A * math.exp(k * step), 4)
        rows.append({"id": i, "level": k, "side": "buy", "status": "filled", "filled_qty": 2.0,
                     "filled_price": px, "size": 2.0}); i += 1
        rows.append({"id": i, "level": k + 1, "side": "sell", "status": "filled", "closes_level": k,
                     "filled_qty": 2.0, "filled_price": px * 1.00125, "realized_profit_usd": 0.01}); i += 1
    for k, cost in lots.items():
        rows.append({"id": i, "level": k, "side": "buy", "status": "filled", "filled_qty": 2.0,
                     "filled_price": cost, "size": 2.0}); i += 1
    return rows


def _split(rows):
    buys = [r for r in rows if r["side"] == "buy" and r["status"] == "filled"]
    sells = [r for r in rows if r["side"] == "sell" and r.get("closes_level") is not None
             and r.get("filled_qty") is not None]
    return buys, sells


# ── Twin-instance parameterization (2026-10-21, Worker 3/Worker 4 same-process twins) ─────────────

def t_default_init_is_byte_identical_to_worker4s_old_hardcoded_behavior():
    import aiohttp
    bot = core.LitGridLive(None)
    check("default table_state is the original Worker 4 constant",
          bot.TABLE_STATE == core.TABLE_STATE, bot.TABLE_STATE)
    check("default table_orders is the original Worker 4 constant",
          bot.TABLE_ORDERS == core.TABLE_ORDERS, bot.TABLE_ORDERS)
    check("default table_runs is the original Worker 4 constant",
          bot.TABLE_RUNS == core.TABLE_RUNS, bot.TABLE_RUNS)
    check("default tag is empty (log lines unchanged: '[lit-grid-live:action]')", bot._tag == "", bot._tag)
    check("default lock id has no tag suffix", bot._lock_id.endswith(":lit-grid-live"), bot._lock_id)


def t_overridden_init_uses_its_own_tables_and_tag_not_worker4s():
    bot = core.LitGridLive(None, table_state="w3_state", table_orders="w3_orders",
                            table_runs="w3_runs", tag="-worker3")
    check("overridden table_state is used, not the Worker 4 constant",
          bot.TABLE_STATE == "w3_state" and bot.TABLE_STATE != core.TABLE_STATE, bot.TABLE_STATE)
    check("overridden table_orders is used, not the Worker 4 constant",
          bot.TABLE_ORDERS == "w3_orders" and bot.TABLE_ORDERS != core.TABLE_ORDERS, bot.TABLE_ORDERS)
    check("overridden table_runs is used, not the Worker 4 constant",
          bot.TABLE_RUNS == "w3_runs" and bot.TABLE_RUNS != core.TABLE_RUNS, bot.TABLE_RUNS)
    check("lock id carries the tag so it never collides in logs with Worker 4's",
          bot._lock_id.endswith(":lit-grid-live-worker3"), bot._lock_id)


def t_run_lit_grid_live_signature_defaults_match_worker4_exactly():
    import inspect
    sig = inspect.signature(core.run_lit_grid_live)
    p = sig.parameters
    check("table_state defaults to Worker 4's real table", p["table_state"].default == core.TABLE_STATE)
    check("table_orders defaults to Worker 4's real table", p["table_orders"].default == core.TABLE_ORDERS)
    check("table_runs defaults to Worker 4's real table", p["table_runs"].default == core.TABLE_RUNS)
    check("env_prefix defaults to empty (reads LIGHTER_* env vars, not WORKER3_LIGHTER_*)", p["env_prefix"].default == "")
    check("tag defaults to empty", p["tag"].default == "")



# ── Gate-dependent spacing growth (2026-10-21) ────────────────────────────────────────────────

def t_cover_for_tier_matches_the_live_gates():
    check("base tier (10): cover is just the tier itself", core.cover_for_tier(10.0) == 10.0)
    check("tier 20 (5% gate): cover = (20-5)/(1-0.05) = 15.789...",
          abs(core.cover_for_tier(20.0) - 15.7894736842) < 1e-6)
    check("tier 40 (10% gate): cover = (40-10)/(1-0.10) = 33.333...",
          abs(core.cover_for_tier(40.0) - 33.3333333333) < 1e-6)
    check("deepest tier 99.9 (20% gate, was 80 until 2026-10-23): cover = (99.9-20)/(1-0.20) = 99.875",
          abs(core.cover_for_tier(99.9) - 99.875) < 1e-9)


def t_capital_corrected_spacing_multiplier_matches_verified_values():
    # 2026-10-22: replaces the old flat 1/2/3/4x table. Values below are the exact numbers
    # verified against the real sizing code and backtested in
    # research/lit-constant-profit-spacing-2026-10-22/PROPOSAL.md.
    base_cover = core.cover_for_tier(10.0)
    for tier, want in ((10.0, 1.0), (20.0, 1.2566), (40.0, 1.8257), (99.9, 3.1603)):
        got = core.capital_corrected_spacing_multiplier(tier, available_usdc=1000.0, base_capital_usdc=1000.0)
        check(f"tier {tier:g} with no capital depletion (K0==Kg): multiplier ~{want}",
              abs(got - want) < 1e-3, got)
    check("an unrecognized tier is treated as the base tier: multiplier 1, not an error",
          abs(core.capital_corrected_spacing_multiplier(999.0, 1000.0, 1000.0) - 1.0) < 1e-9)
    check("base_capital_usdc=None treats current cash as K0 (plain sqrt-cover, no correction)",
          abs(core.capital_corrected_spacing_multiplier(20.0, 1000.0, None)
              - math.sqrt(core.cover_for_tier(20.0) / base_cover)) < 1e-9)


def t_capital_corrected_spacing_multiplier_corrects_for_depleted_cash():
    # Less cash available now (Kg) than when last at base (K0) widens spacing a bit MORE than
    # the plain cover ratio alone would, to keep per-trade profit flat despite the smaller pool.
    plain = core.capital_corrected_spacing_multiplier(20.0, available_usdc=1000.0, base_capital_usdc=1000.0)
    depleted = core.capital_corrected_spacing_multiplier(20.0, available_usdc=800.0, base_capital_usdc=1000.0)
    check("depleted cash (Kg < K0) widens the multiplier beyond the plain cover-ratio version",
          depleted > plain, (depleted, plain))


def t_effective_spacing_off_by_default_is_the_plain_dashboard_value():
    st = base_state(spacing_pct=0.5, dynamic_dd_enabled=True, gate_spacing_multiplier_value=3.0)
    check("gate_spacing_growth_enabled unset/false: plain spacing_pct, no widening",
          core.effective_spacing_pct(st) == 0.5, core.effective_spacing_pct(st))
    st2 = base_state(spacing_pct=0.5, gate_spacing_growth_enabled=True, dynamic_dd_enabled=False, gate_spacing_multiplier_value=3.0)
    check("dynamic_dd disabled: plain spacing_pct even with the growth flag on",
          core.effective_spacing_pct(st2) == 0.5, core.effective_spacing_pct(st2))
    st3 = base_state(spacing_pct=0.5, gate_spacing_growth_enabled=True, dynamic_dd_enabled=True)
    check("no multiplier persisted yet: plain spacing_pct, not an error",
          core.effective_spacing_pct(st3) == 0.5, core.effective_spacing_pct(st3))


def t_effective_spacing_widens_by_the_persisted_multiplier_when_both_flags_are_on():
    # effective_spacing_pct (2026-10-22) reads a PERSISTED multiplier -- it no longer derives one
    # from dynamic_dd_tier itself, since capital_corrected_spacing_multiplier needs live cash
    # figures only _dynamic_order_size has. dynamic_dd_tier may still be recorded alongside it
    # for context/logging, but effective_spacing_pct doesn't look at it anymore.
    for mult in (1.0, 1.2566, 1.8257, 2.7386):
        st = base_state(spacing_pct=0.125, gate_spacing_growth_enabled=True,
                         dynamic_dd_enabled=True, gate_spacing_multiplier_value=mult)
        want = round(0.125 * mult, 6)
        got = round(core.effective_spacing_pct(st), 6)
        check(f"multiplier {mult}: 0.125 x{mult} = {want}", got == want, got)


# ── De-escalation hysteresis (2026-10-22 real incident) ───────────────────────────────────────

def t_dynamic_dd_tier_escalates_instantly_at_the_raw_gate():
    check("drop exactly at the 5% gate, coming from tier 10, escalates to 20 immediately",
          core.dynamic_dd_tier_for_drop(5.0, 10.0) == 20.0)
    check("a big jump straight to the 20% gate escalates straight to 80, no step-by-step delay",
          core.dynamic_dd_tier_for_drop(20.0, 10.0) == 99.9)


def t_dynamic_dd_tier_blocks_deescalation_inside_the_hysteresis_band():
    # Real data, 2026-10-22: chop around the 5% gate stayed between 4.92% and 6.38% for hours.
    # Dipping just under the gate (but still within the 1-point band) must NOT fall back to 10.
    check("drop just under the gate (4.5%), but within the 1-point band, stays at the deeper tier",
          core.dynamic_dd_tier_for_drop(4.5, 20.0) == 20.0)
    check("drop at exactly gate-1 (4.0%) still counts as inside the band (boundary itself holds)",
          core.dynamic_dd_tier_for_drop(4.0, 20.0) == 20.0)


def t_dynamic_dd_tier_deescalates_once_past_the_hysteresis_margin():
    check("drop clearly past gate-1 (3.9%) de-escalates back to the shallower tier",
          core.dynamic_dd_tier_for_drop(3.9, 20.0) == 10.0)


def t_dynamic_dd_tier_applies_the_same_band_at_every_gate():
    check("10% gate: 9.5% stays at 40 (inside the band)",
          core.dynamic_dd_tier_for_drop(9.5, 40.0) == 40.0)
    check("10% gate: 8.9% de-escalates to 20 (past the band)",
          core.dynamic_dd_tier_for_drop(8.9, 40.0) == 20.0)
    check("20% gate: 19.5% stays at 80 (inside the band)",
          core.dynamic_dd_tier_for_drop(19.5, 99.9) == 99.9)
    check("20% gate: 18.9% de-escalates to 40 (past the band)",
          core.dynamic_dd_tier_for_drop(18.9, 99.9) == 40.0)


def t_dynamic_dd_tier_lets_a_real_recovery_fall_straight_through():
    # A genuine large recovery (not noise) must land wherever the raw gate says, in one step --
    # the band only guards the ONE gate that produced the current tier, never stacks per gate.
    check("drop falling from deep (old_tier 80) straight to 3% lands at base (10) in one step",
          core.dynamic_dd_tier_for_drop(3.0, 99.9) == 10.0)
    check("drop falling from deep (old_tier 80) to 15% lands at 40 in one step",
          core.dynamic_dd_tier_for_drop(15.0, 99.9) == 40.0)


def t_dynamic_dd_tier_with_no_prior_tier_uses_the_raw_gate():
    check("first-ever call (nothing recorded yet) has no history to hysteresis against",
          core.dynamic_dd_tier_for_drop(15.0, None) == 40.0)


async def t_dynamic_order_size_does_not_thrash_on_real_boundary_chop():
    # Reproduces the actual 2026-10-22 incident sequence (drop oscillating across the 5% gate)
    # and confirms the tier no longer flips back and forth tick to tick.
    bot, fake = make_bot(base_state(
        dynamic_dd_enabled=True, dynamic_dd_high=100.0, dynamic_dd_tier=10.0,
        order_size_lit=5.0, usdc_balance=500.0,
    ))
    for drop_pct in (4.98, 5.08, 4.92, 5.5, 4.97):
        price = 100.0 * (1 - drop_pct / 100.0)
        await bot._dynamic_order_size(fake.state, price, 0.125, {}, {})
    check("tier settles at the deeper tier instead of flapping back to 10 on every small dip",
          fake.state.get("dynamic_dd_tier") == 20.0, fake.state.get("dynamic_dd_tier"))
    switches = [r for r in fake.runs if r["action"] == "dynamic_drawdown_switch"]
    check("only ONE real switch happened across the whole noisy sequence (escalate once, no bouncing)",
          len(switches) == 1, switches)


async def t_dynamic_order_size_persists_multiplier_and_base_capital_on_a_tier_switch():
    # 2026-10-22: with gate_spacing_growth_enabled on, a tier switch must persist BOTH
    # gate_spacing_multiplier_value (for effective_spacing_pct to read next tick) and
    # dynamic_dd_base_capital_usd (K0), not just dynamic_dd_tier/order_size_lit.
    bot, fake = make_bot(base_state(
        dynamic_dd_enabled=True, gate_spacing_growth_enabled=True,
        dynamic_dd_high=100.0, dynamic_dd_tier=10.0, dynamic_dd_base_capital_usd=None,
        order_size_lit=5.0, usdc_balance=500.0,
    ))
    await bot._dynamic_order_size(fake.state, 94.0, 0.125, {}, {})  # drop=6% -> tier 20
    check("tier switched to 20", fake.state.get("dynamic_dd_tier") == 20.0, fake.state.get("dynamic_dd_tier"))
    mult = fake.state.get("gate_spacing_multiplier_value")
    want_mult = core.capital_corrected_spacing_multiplier(20.0, fake.state.get("usdc_balance"), fake.state.get("usdc_balance"))
    check("multiplier persisted, matching the real formula for this tier/cash",
          mult is not None and abs(mult - want_mult) < 1e-6, mult)
    check("K0 (base capital) initialized from current cash -- nothing was recorded before this",
          fake.state.get("dynamic_dd_base_capital_usd") == fake.state.get("usdc_balance"),
          fake.state.get("dynamic_dd_base_capital_usd"))


async def t_dynamic_order_size_refreshes_base_capital_every_time_it_returns_to_base_tier():
    bot, fake = make_bot(base_state(
        capital_usd=1000.0, dynamic_dd_enabled=True, gate_spacing_growth_enabled=True,
        dynamic_dd_high=100.0, dynamic_dd_tier=20.0, dynamic_dd_base_capital_usd=1000.0,
        order_size_lit=5.0, usdc_balance=850.0,
    ))
    await bot._dynamic_order_size(fake.state, 100.0, 0.125, {}, {})  # drop=0% -> back to base tier 10
    check("tier returned to base (10)", fake.state.get("dynamic_dd_tier") == 10.0, fake.state.get("dynamic_dd_tier"))
    check("K0 refreshed to the cash actually available now, not left at the old 1000",
          fake.state.get("dynamic_dd_base_capital_usd") == 850.0, fake.state.get("dynamic_dd_base_capital_usd"))
    check("multiplier at the base tier is 1.0 (no widening)",
          abs(fake.state.get("gate_spacing_multiplier_value") - 1.0) < 1e-9,
          fake.state.get("gate_spacing_multiplier_value"))


async def t_dynamic_order_size_never_touches_multiplier_fields_when_growth_flag_is_off():
    # Regression guard: gate_spacing_growth_enabled off (the default) must never write the new
    # columns at all, same philosophy as every other flag-gated read/write in this file.
    bot, fake = make_bot(base_state(
        dynamic_dd_enabled=True, dynamic_dd_high=100.0, dynamic_dd_tier=10.0,
        order_size_lit=5.0, usdc_balance=500.0,
    ))
    await bot._dynamic_order_size(fake.state, 94.0, 0.125, {}, {})
    check("gate_spacing_multiplier_value is never written when the growth flag is off",
          "gate_spacing_multiplier_value" not in fake.state, fake.state.get("gate_spacing_multiplier_value"))
    check("dynamic_dd_base_capital_usd is never written when the growth flag is off",
          "dynamic_dd_base_capital_usd" not in fake.state, fake.state.get("dynamic_dd_base_capital_usd"))


async def t_dynamic_order_size_resize_without_a_tier_change_never_touches_the_multiplier():
    # Real incident, 2026-10-22: order_size_lit gets cleared for reasons that have nothing to do
    # with the tier (compound-profit credit, a settings change, a manual fix) -- recomputing the
    # capital-corrected multiplier on every one of those (it depends on LIVE cash, unlike the old
    # flat table) produced a slightly different spacing EVERY time, each one triggering its own
    # full cancel-and-reanchor even while staying in the exact same tier. Worker 4 got stuck in
    # back-to-back reanchors this way within minutes of deploy. A resize with the SAME tier must
    # leave gate_spacing_multiplier_value/dynamic_dd_base_capital_usd completely untouched.
    bot, fake = make_bot(base_state(
        dynamic_dd_enabled=True, gate_spacing_growth_enabled=True,
        dynamic_dd_high=100.0, dynamic_dd_tier=20.0, dynamic_dd_base_capital_usd=1000.0,
        gate_spacing_multiplier_value=1.2566, order_size_lit=None, usdc_balance=850.0,
    ))
    await bot._dynamic_order_size(fake.state, 94.0, 0.125, {}, {})  # drop=6% -- still tier 20, no change
    check("tier is unchanged (still 20)", fake.state.get("dynamic_dd_tier") == 20.0, fake.state.get("dynamic_dd_tier"))
    check("order_size_lit WAS recomputed (it was None)", fake.state.get("order_size_lit") is not None, fake.state.get("order_size_lit"))
    check("the multiplier is NOT recomputed -- stays at the exact value it already had",
          fake.state.get("gate_spacing_multiplier_value") == 1.2566, fake.state.get("gate_spacing_multiplier_value"))
    check("K0 is NOT touched either -- stays at the exact value it already had",
          fake.state.get("dynamic_dd_base_capital_usd") == 1000.0, fake.state.get("dynamic_dd_base_capital_usd"))


async def t_a_resting_order_that_just_left_the_book_is_not_marked_rejected():
    # Audit 2026-10-22 (P0-2): a sell that rested for hours, filled, and was not yet visible in the
    # per-order lookup was marked rejected on the spot -- the fill and its profit lost for good.
    held = {"id": 1, "level": 10, "side": "buy", "status": "filled", "filled_qty": 6.0,
            "filled_price": 3.40, "size": 6.0, "closes_level": None}
    sell = {"id": 2, "level": 11, "side": "sell", "status": "open", "closes_level": 10,
            "client_order_index": 601, "exchange_order_id": 6001, "limit_price": 3.42, "size": 6.0,
            "placed_at": "2020-01-01T00:00:00+00:00"}
    ghost = {"id": 3, "level": 9, "side": "buy", "status": "pending", "client_order_index": 602,
             "exchange_order_id": None, "limit_price": 3.38, "size": 6.0,
             "placed_at": "2020-01-01T00:00:00+00:00"}
    bot, fake = make_bot(base_state(), orders=[held, sell, ghost], active_orders_by_co={})
    bot._missing_since = {}
    await bot.reconcile_pending_orders()
    rows = {r["id"]: r for r in fake.orders}
    check("an old resting sell that just left the book is NOT resolved on first sight",
          rows[2]["status"] == "open", rows[2]["status"])
    check("an old ghost is NOT resolved on first sight either (needs a minute missing)",
          rows[3]["status"] == "pending", rows[3]["status"])
    bot._missing_since = {k: v - core.GHOST_RESOLVE_S - 1 for k, v in bot._missing_since.items()}
    await bot.reconcile_pending_orders()
    rows = {r["id"]: r for r in fake.orders}
    check("after a full minute missing, the never-seen ghost resolves", rows[3]["status"] == "rejected",
          rows[3]["status"])


async def t_compound_resizes_once_it_adds_a_hundredth_of_a_lit():
    # Direct request 2026-10-24: new compound profit resizes the orders as soon as it adds >= 0.01
    # LIT to every order (the exchange's size step) -- replacing the +0.2%-of-Investment step that
    # grew to $89 after a deposit and almost never fired.
    price = 3.0
    bot, fake = make_bot(base_state(capital_usd=44561.0))
    st = dict(fake.state)
    step = bot._compound_step_usd(st, price)
    expect = 0.01 * core._price_sum_for_levels(price, 0.125, core.levels_for_drawdown(0.125, 10.0))
    check("step = 0.01 LIT x the price sum of the lines the cash is spread over",
          abs(step - expect) < 1e-9, (step, expect))
    check("first sight only records the baseline (no resize)", bot._compound_resize_due(st, 100.0, price) is False)
    check("just under one step does not resize", bot._compound_resize_due(st, 100.0 + step - 0.01, price) is False)
    check("one full step resizes", bot._compound_resize_due(st, 100.0 + step + 1e-6, price) is True)
    await bot._note_compound_resize(st, 100.0 + step, step)
    check("the resize is recorded (with its step) and becomes the new baseline",
          st["compound_resize"]["compound_usd"] == round(100.0 + step, 6)
          and st["compound_resize"]["step_usd"] == round(step, 2)
          and bot._compound_resize_due(st, 100.0 + step * 1.5, price) is False, st.get("compound_resize"))
    check("the next resize needs another full step",
          bot._compound_resize_due(st, 100.0 + step * 2 + 0.01, price) is True)

    # The 99.9% gate at -20% from the high: ~$25 per 0.01 LIT with LIT ~$3.13 (owner's live case).
    deep = base_state(dynamic_dd_enabled=True, dynamic_dd_high=3.91285, dynamic_dd_tier=99.9)
    s99 = bot._compound_step_usd(deep, 3.13)
    s40 = bot._compound_step_usd(dict(deep, dynamic_dd_tier=40.0), 3.17)
    check("99.9% gate: ~$25 of compound per +0.01 LIT", 23.0 < s99 < 27.0, s99)
    check("40% gate: a much smaller step (~$6.60)", 5.5 < s40 < 7.5, s40)


async def t_compound_resize_never_changes_any_bucket():
    # Owner's condition (2026-10-24): the resize rule must not touch the Rest / Cover-drop /
    # Compound buckets -- it only reads Compound. Run the real slow refresh with all three buckets
    # funded, once without and once with a resize, and compare every bucket.
    rows = [
        {"id": 1, "side": "sell", "status": "filled", "realized_profit_usd": 7.0,
         "profit_bucket_destination": "profit_bucket_rest_usd"},
        {"id": 2, "side": "sell", "status": "filled", "realized_profit_usd": 11.0,
         "profit_bucket_destination": "profit_bucket_cover_drop_usd"},
        {"id": 3, "side": "sell", "status": "filled", "realized_profit_usd": 40.0,
         "profit_bucket_destination": "profit_bucket_compound_usd"},
    ]
    keys = ("profit_bucket_rest_usd", "profit_bucket_cover_drop_usd", "profit_bucket_compound_usd")
    for label, base_compound in (("no resize", 39.0), ("resize", 0.0)):
        bot, fake = make_bot(base_state(capital_usd=44561.0), orders=[dict(r) for r in rows])
        st = dict(fake.state)
        st["compound_resize"] = {"at": None, "compound_usd": base_compound, "capital_usd": 44561.0}
        before = await bot._bucket_balances()
        await bot._v2_slow_refresh(st, 3.0)
        after = await bot._bucket_balances()
        check(f"{label}: all three buckets identical before/after",
              all(abs(before[k] - after[k]) < 1e-9 for k in keys), (before, after))
        check(f"{label}: the state's bucket fields equal the ledger's",
              all(abs(float(st[k]) - after[k]) < 1e-9 for k in keys), {k: st[k] for k in keys})
        check(f"{label}: buckets are 7 / 11 / 40",
              [round(after[k], 6) for k in keys] == [7.0, 11.0, 40.0], after)
        resized = st.get("order_size_lit") is None or (st.get("compound_resize") or {}).get("at") is not None
        check(f"{label}: resize happened = {label == 'resize'}", resized == (label == "resize"),
              st.get("compound_resize"))


async def t_compound_resize_only_ever_adds_to_the_order_size():
    # Owner (2026-10-24): "compounding should increase size not decrease it". Live, a full
    # recompute from available cash shrank orders 44.3 -> 43.3 -> 40.1 LIT. Now a compound resize
    # adds exactly the new compound dollars spread over the same lines, even when cash is low.
    rows = [{"id": 3, "side": "sell", "status": "filled", "realized_profit_usd": 200.0, "closes_level": 5,
             "filled_qty": 1.0, "profit_bucket_destination": "profit_bucket_compound_usd"}]
    st0 = base_state(capital_usd=44561.0, usdc_balance=10.0, dynamic_dd_enabled=True,
                     dynamic_dd_high=3.91285, dynamic_dd_tier=40.0, order_size_lit=40.0)
    bot, fake = make_bot(st0, orders=[dict(r) for r in rows])
    st = dict(fake.state)
    step = bot._compound_step_usd(st, 3.2)
    st["compound_resize"] = {"at": None, "compound_usd": 200.0 - 3 * step, "capital_usd": 44561.0}
    await bot._v2_slow_refresh(st, 3.2)
    check("3 steps of new compound -> exactly +0.03 LIT (never a recompute from cash)",
          abs(float(st["order_size_lit"]) - 40.03) < 1e-6, st.get("order_size_lit"))
    check("the resize is logged with the new size",
          abs(float(st["compound_resize"]["order_size_lit"]) - 40.03) < 1e-4, st.get("compound_resize"))
    before = float(st["order_size_lit"])
    await bot._v2_slow_refresh(st, 3.2)
    check("no new compound -> size unchanged", float(st["order_size_lit"]) == before, st.get("order_size_lit"))


async def t_bucket_totals_come_from_the_cached_ledger_and_match_a_fresh_read():
    # 2026-10-24: the buckets re-read every sell ever made every 15s (~700 new rows a day). They
    # now come from the in-memory ledger copy that reconcile keeps current, reloaded every 15 min.
    old_reload = core.ROWS_CACHE_RELOAD_S
    core.ROWS_CACHE_RELOAD_S = 10 ** 9
    try:
        buy = {"id": 1, "level": 900, "side": "buy", "status": "filled", "filled_qty": 2.0,
               "filled_price": 3.00, "size": 2.0}
        sell_row = {"id": 2, "level": 901, "side": "sell", "closes_level": 900, "client_order_index": 555,
                    "status": "pending", "limit_price": 3.10, "size": 2.0}
        filled_sell = FakeOrder(555, order_index=77, status="filled",
                                filled_base_amount=2.0, filled_quote_amount=2.0 * 3.10, remaining_base_amount=0.0)
        bot, fake = make_bot(base_state(profit_mode="compound"), orders=[buy, sell_row],
                             orders_by_co={555: filled_sell})
        b0 = await bot._bucket_balances()
        check("cache loaded, no profit yet", abs(b0["profit_bucket_compound_usd"]) < 1e-9, b0)
        await bot.reconcile_pending_orders(profit_mode="compound")
        b1 = await bot._bucket_balances()
        check("a fill written by reconcile shows in the buckets without a reload",
              abs(b1["profit_bucket_compound_usd"] - 0.2) < 1e-6, b1)
        bot._rows_cache = None
        b2 = await bot._bucket_balances()
        check("cached totals equal a fresh full read", all(abs(b1[k] - b2[k]) < 1e-9 for k in b1), (b1, b2))
    finally:
        core.ROWS_CACHE_RELOAD_S = old_reload


# ── Curve sizing (2026-10-25) ────────────────────────────────────────────────────────────────────

def t_curve_spends_exactly_the_budget_down_to_the_floor_price():
    # The whole curve, summed line by line from the top to 0.1% of it, costs exactly B; biggest
    # right at the top, the floor at the bottom, never below the floor anywhere.
    P, step = 3.16, math.log(1.00125)
    plan = core.curve_plan(P, math.log(P), step, 10, 1.0)
    budget = 27_000.0
    ln, total, sizes = 0, 0.0, []
    while True:
        px = core.grid_engine.line_price(math.log(P), ln, step)
        if px <= plan["F"]:
            break
        q = core.curve_size(px, plan, budget)
        total += q * px; sizes.append(q); ln -= 1
    check("curve costs exactly the budget", abs(total - budget) < 0.01, total)
    check("sizes only shrink going down", all(a >= b - 1e-12 for a, b in zip(sizes, sizes[1:])))
    check("bottom lines sit on the 1 LIT floor", abs(sizes[-1] - 1.0) < 1e-6, sizes[-1])
    check("top size matches the research table (~107 LIT at $3.16, $27k, n=10)", 100 < sizes[0] < 114, sizes[0])
    check("~5,500 lines down to 99.9%", 5400 < plan["lines"] < 5600, plan["lines"])
    check("a budget below the floor reserve gives the floor, never less",
          abs(core.curve_size(P, plan, plan["R"] * 0.5) - 1.0) < 1e-9)


def t_sizing_mode_only_one_is_ever_on():
    check("both off -> flat", core.sizing_mode({}) == "flat")
    check("gates only -> dynamic", core.sizing_mode({"dynamic_dd_enabled": True}) == "dynamic")
    check("curve wins if both flags are set", core.sizing_mode({"dynamic_dd_enabled": True, "curve_enabled": True}) == "curve")
    st = {"spacing_pct": 0.125, "gate_spacing_growth_enabled": True, "dynamic_dd_enabled": True,
          "curve_enabled": True, "gate_spacing_multiplier_value": 2.0}
    check("curve mode never uses the gate spacing multiplier", core.effective_spacing_pct(st) == 0.125)


async def t_curve_plans_at_switch_on_and_moves_up_only_at_a_new_top():
    P = 3.16
    step = math.log(1.00125)
    rows = _grid_rows(P, held=[], sells_for=[], buys_at=[-1, -2])   # two resting buys, 2.16 LIT each
    bot, fake = make_bot(base_state(usdc_balance=27_000.0, capital_usd=27_000.0, grid_anchor_price=P,
                                     curve_enabled=True, curve_n=10, curve_floor_lit=1), orders=rows)
    st = fake.state
    holdings = await bot.current_holdings()
    resting = await bot.resting_orders_by_level()
    size_at = await bot._curve_sizer(st, P, math.log(P), step, holdings, resting)
    check("switch-on plans at the current price", abs(st["curve_top"] - P) < 1e-12, st.get("curve_top"))
    check("cash = all spendable USDC, money in resting buys included",
          abs(st["curve_cash_usd"] - 27_000.0) < 1e-6, st["curve_cash_usd"])
    top_size = size_at(P)
    check("the top buy is big (~107 LIT)", 100 < top_size < 114, top_size)
    check("10% lower is smaller (~38 LIT)", 33 < size_at(P * 0.9) < 43, size_at(P * 0.9))
    check("curve_state published for the panel", (st.get("curve_state") or {}).get("next_buy_size") is not None)
    plans = [r for r in fake.runs if r.get("action") == "curve_replan"]
    await bot._curve_sizer(st, P * 0.97, math.log(P), step, holdings, resting)
    await bot._curve_sizer(st, P * 1.0005, math.log(P), step, holdings, resting)
    check("no re-plan below the top or less than a line above it",
          len([r for r in fake.runs if r.get("action") == "curve_replan"]) == len(plans) and st["curve_top"] == P)
    st["profit_bucket_compound_usd"] = 270.0
    bigger = (await bot._curve_sizer(st, P, math.log(P), step, holdings, resting))(P)
    check("new compound profit makes the curve bigger right away", bigger > top_size, (bigger, top_size))
    await bot._curve_sizer(st, P * 1.002, math.log(P), step, holdings, resting)
    check("a full line above the top re-plans at the new top", abs(st["curve_top"] - P * 1.002) < 1e-12, st["curve_top"])
    check("profit is part of the cash at the new plan, not counted twice",
          abs(bot._curve_budget(st) - st["curve_cash_usd"]) < 1e-9)


def t_mirror_spends_exactly_the_budget_with_its_peak_below_the_top():
    # Mirror (peak 10% below the top): same total cost as the plain curve, biggest DOLLARS at -10%,
    # equal dollars at the same distance above and below the peak. peak=0 is the old curve exactly.
    P, step = 3.05, math.log(1.0025)
    plain = core.curve_plan(P, math.log(P), step, 10, 1.0)
    old_style = core.curve_plan(P, math.log(P), step, 10, 1.0, 0.0)
    check("peak 0 = the old curve, line for line", plain["W"] == old_style["W"] and plain["R"] == old_style["R"])
    plan = core.curve_plan(P, math.log(P), step, 10, 1.0, 0.10)
    budget = 20_000.0
    ln, total, dollars = 0, 0.0, []
    while True:
        px = core.grid_engine.line_price(math.log(P), ln, step)
        if px <= plan["F"]:
            break
        q = core.curve_size(px, plan, budget)
        total += q * px; dollars.append((q * px, px)); ln -= 1
    check("mirror costs exactly the budget", abs(total - budget) < 0.01, total)
    best = max(dollars)[1]
    check("biggest order ~10% below the top", abs(best / P - 0.90) < 0.003, best / P)
    d = lambda frac: core.curve_size(P * frac, plan, budget) * P * frac
    check("same dollars 5% above and 5% below the peak", abs(d(0.95) - d(0.85)) / d(0.95) < 0.01, (d(0.95), d(0.85)))
    check("top order smaller than at the peak", d(1.0) < d(0.90) * 0.5, (d(1.0), d(0.90)))
    check("above the top counts as the top", abs(core.curve_size(P * 1.01, plan, budget) - core.curve_size(plan["P"], plan, budget)) < 1e-9)
    check("never below the 1 LIT floor", min(core.curve_size(px, plan, budget) for _, px in dollars) >= 1.0 - 1e-12)


async def t_crash_reserve_holds_profit_and_deploys_once_at_minus_30():
    P = 3.05
    step = math.log(1.0025)
    bot, fake = make_bot(base_state(usdc_balance=20_000.0, capital_usd=20_000.0, grid_anchor_price=P,
                                     curve_enabled=True, curve_n=10, curve_floor_lit=1, curve_peak_pct=10,
                                     reserve_enabled=True, reserve_deploy_pct=30), orders=[])
    st = fake.state
    sizer = lambda px: bot._curve_sizer(st, px, math.log(P), step, {}, {})
    await sizer(P)
    check("reserve starts empty at switch-on", bot._reserve_usd(st) == 0 and st["reserve_profit_base_usd"] == 0.0)
    check("curve plans all free cash", abs(st["curve_cash_usd"] - 20_000.0) < 1e-6, st["curve_cash_usd"])
    budget0 = bot._curve_budget(st)
    st["profit_bucket_compound_usd"] = 500.0
    st["usdc_balance"] = 20_500.0
    check("all new profit goes to the reserve", abs(bot._reserve_usd(st) - 500.0) < 1e-9, bot._reserve_usd(st))
    check("the curve does not grow from reserved profit", abs(bot._curve_budget(st) - budget0) < 1e-9)
    _, _, avail = bot._funding(st, {}, {})
    check("no buy may spend the reserve", abs(avail - 20_000.0) < 1e-6, avail)
    await sizer(P * 1.003)                     # new top: re-plan without the reserve
    check("a new top re-plans without the reserve", abs(st["curve_cash_usd"] - 20_000.0) < 1e-6
          and abs(bot._reserve_usd(st) - 500.0) < 1e-9, (st["curve_cash_usd"], bot._reserve_usd(st)))
    top = st["curve_top"]
    await sizer(top * 0.705)
    check("no deploy above -30%", not [r for r in fake.runs if r.get("action") == "reserve_deployed"])
    await sizer(top * 0.70)
    dep = [r for r in fake.runs if r.get("action") == "reserve_deployed"]
    check("deploys at -30%", len(dep) == 1, dep)
    check("re-plans at the deploy price", abs(st["curve_top"] - top * 0.70) < 1e-12, st["curve_top"])
    check("cash now includes the reserve", abs(st["curve_cash_usd"] - 20_500.0) < 1e-6, st["curve_cash_usd"])
    check("reserve empty after deploy", bot._reserve_usd(st) == 0 and st["reserve_deploys"] == 1)
    await sizer(top * 0.69)
    check("no second deploy with an empty reserve",
          len([r for r in fake.runs if r.get("action") == "reserve_deployed"]) == 1)
    st["profit_bucket_compound_usd"] = 600.0
    check("refills from new profit", abs(bot._reserve_usd(st) - 100.0) < 1e-9, bot._reserve_usd(st))


async def t_reserve_switched_on_later_keeps_the_profit_already_in_the_budget():
    P = 3.05
    step = math.log(1.0025)
    bot, fake = make_bot(base_state(usdc_balance=20_000.0, capital_usd=20_000.0, grid_anchor_price=P,
                                     curve_enabled=True, curve_n=10, curve_floor_lit=1), orders=[])
    st = fake.state
    await bot._curve_sizer(st, P, math.log(P), step, {}, {})
    st["profit_bucket_compound_usd"] = 300.0
    before = bot._curve_budget(st)
    st["reserve_enabled"] = True
    await bot._curve_sizer(st, P, math.log(P), step, {}, {})
    check("turning the reserve on keeps the budget", abs(bot._curve_budget(st) - before) < 1e-9, (before, bot._curve_budget(st)))
    check("and starts the reserve at 0", bot._reserve_usd(st) == 0)
    st["curve_enabled"] = False
    st["profit_bucket_compound_usd"] = 900.0
    check("outside curve mode the reserve holds nothing back", bot._reserve_usd(st) == 0)


# ── Re-anchor keeps lots next to their cost (2026-10-26) ───────────────────────────────────────

def _lot(i, level, qty, price):
    return {"id": i, "level": level, "side": "buy", "status": "filled", "filled_qty": qty,
            "filled_price": price, "size": qty}


def t_reanchor_merges_lots_that_land_on_one_wider_line():
    # Four 0.125% lots inside one 0.5% line: merged there (average cost), each sell one line up --
    # never pushed up a line per collision.
    P = 3.17
    buys = [_lot(i + 1, 100 + i, 10.0, round(P * 1.00125 ** -i, 4)) for i in range(4)]
    step = math.log(1.005)
    moves, mapping = core._reanchor_moves(buys, [], 5000, P, step, merge=True)
    check("4 nearby lots share one line at 0.5%", len(set(mapping.values())) <= 2, mapping)
    after = core.holdings_from_rows([dict(b, level=moves[b["id"]][1]) for b in buys], [])
    check("total LIT and cost unchanged", abs(sum(h["qty"] for h in after.values()) - 40) < 1e-9
          and abs(sum(h["qty"] * h["cost"] for h in after.values()) - sum(b["filled_qty"] * b["filled_price"] for b in buys)) < 1e-6)
    anchor = math.log(P) - 5000 * step
    worst = max(core.grid_engine.sell_target(ln, h["cost"], anchor, step, 0.005, core.round_price) / h["cost"] - 1
                for ln, h in after.items())
    check("every sell within 2 spacings of its cost", worst <= 0.0101, worst)
    moves2, mapping2 = core._reanchor_moves(buys, [], 5000, P, step, merge=False)
    check("without merging they could not share (old behaviour kept for merge=False)",
          len(set(mapping2.values())) == 4, mapping2)


def t_reanchor_merges_a_partly_sold_lot_only_when_the_costs_stay_exact():
    P = 3.17
    old = _lot(1, 10, 20.0, 3.19)
    part_sell = {"id": 2, "closes_level": 10, "side": "sell", "filled_qty": 5.0}
    new = _lot(3, 11, 10.0, 3.1905)                    # bought after the partial sell: merge exact
    step = math.log(1.005)
    moves, mapping = core._reanchor_moves([old, new], [part_sell], 5000, P, step, merge=True)
    check("non-interleaved lots may share a line", mapping[10] == mapping[11], mapping)
    late_sell = {"id": 4, "closes_level": 10, "side": "sell", "filled_qty": 5.0}   # after lot 11's buy
    moves, mapping = core._reanchor_moves([old, new], [part_sell, late_sell], 5000, P, step, merge=True)
    check("a lot sold after the other lot's buy never shares (its cost would mix)",
          mapping[10] != mapping[11], mapping)
    held = core.holdings_from_rows([old, new], [part_sell, late_sell])
    after = core.holdings_from_rows(
        [dict(b, level=moves[b["id"]][1]) for b in (old, new)],
        [dict(x, closes_level=moves[x["id"]][1]) for x in (part_sell, late_sell)])
    check("each lot keeps its exact qty and cost",
          sorted((round(h["qty"], 9), round(h["cost"], 9)) for h in held.values())
          == sorted((round(h["qty"], 9), round(h["cost"], 9)) for h in after.values()), (held, after))


def t_reanchor_collision_goes_to_the_nearest_line_not_far_up():
    # A partly-sold lot holds the nearest line; the lot that cannot share it goes one line away,
    # and never to a line whose sell would be below its cost.
    P = 3.17
    step = math.log(1.0025)
    old = _lot(1, 10, 20.0, 3.20)
    s1 = {"id": 5, "closes_level": 10, "side": "sell", "filled_qty": 5.0}
    other = _lot(3, 11, 10.0, 3.2001)
    s2 = {"id": 6, "closes_level": 10, "side": "sell", "filled_qty": 1.0}
    moves, mapping = core._reanchor_moves([old, other], [s1, s2], 5000, P, step, merge=True)
    check("collided lot lands one line from the other", abs(mapping[11] - mapping[10]) == 1, mapping)
    anchor = math.log(P) - 5000 * step
    for lv, cost in ((10, 3.20), (11, 3.2001)):
        nxt = core.grid_engine.line_price(anchor, mapping[lv] + 1, step)
        check(f"lot {lv}: its sell line is at or above cost", nxt >= cost - 1e-9, (nxt, cost))


async def t_spacing_change_asks_for_the_clean_reset():
    bot, fake = make_bot(base_state(spacing_pct=0.25, internal_spacing_pct=0.125, grid_anchor_price=3.10),
                          orders=[])
    bot.fetch_current_price = lambda: _async_return(3.10)
    await bot.tick()
    check("a spacing change requests the clean reset (cancel-all, empty book, merge)",
          fake.state.get("grid_reset_requested") is True, fake.state)
    check("and logs it", any(r.get("action") == "spacing_change_clean_reset" for r in fake.runs), fake.runs)


async def main():
    t_precision_and_minimum_enforcement()
    t_curve_spends_exactly_the_budget_down_to_the_floor_price()
    t_sizing_mode_only_one_is_ever_on()
    t_mirror_spends_exactly_the_budget_with_its_peak_below_the_top()
    t_reanchor_merges_lots_that_land_on_one_wider_line()
    t_reanchor_merges_a_partly_sold_lot_only_when_the_costs_stay_exact()
    t_reanchor_collision_goes_to_the_nearest_line_not_far_up()
    t_order_fill_amounts_uses_real_human_decimal_units()
    t_order_is_terminal_uses_remaining_amount_primarily()
    t_is_rate_limit_error_matches_429_and_nonce_not_unrelated_errors()
    t_capital_corrected_multiplier_is_bounded()
    t_rate_limit_matching_ignores_prices_that_contain_429()
    t_rounding_does_not_shift_the_real_fill_price_bin()
    t_cover_for_tier_matches_the_live_gates()
    t_capital_corrected_spacing_multiplier_matches_verified_values()
    t_capital_corrected_spacing_multiplier_corrects_for_depleted_cash()
    t_effective_spacing_off_by_default_is_the_plain_dashboard_value()
    t_effective_spacing_widens_by_the_persisted_multiplier_when_both_flags_are_on()
    t_dynamic_dd_tier_escalates_instantly_at_the_raw_gate()
    t_dynamic_dd_tier_blocks_deescalation_inside_the_hysteresis_band()
    t_dynamic_dd_tier_deescalates_once_past_the_hysteresis_margin()
    t_dynamic_dd_tier_applies_the_same_band_at_every_gate()
    t_dynamic_dd_tier_lets_a_real_recovery_fall_straight_through()
    t_dynamic_dd_tier_with_no_prior_tier_uses_the_raw_gate()
    t_default_init_is_byte_identical_to_worker4s_old_hardcoded_behavior()
    t_overridden_init_uses_its_own_tables_and_tag_not_worker4s()
    t_run_lit_grid_live_signature_defaults_match_worker4_exactly()
    for t in (
              t_reset_grid_sends_one_cancel_all_while_orders_rest_on_the_exchange,
              t_reset_grid_reanchors_once_the_exchange_is_clear,
              t_reset_grid_never_reanchors_on_a_balance_mismatch,
              t_reset_grid_does_nothing_when_the_active_orders_read_fails,
              t_passed_level_market_sell_is_floored_at_the_lots_cost,
              t_reset_grid_waits_for_a_row_it_cannot_settle_yet,
              t_flatten_uses_one_cancel_all_not_one_cancel_per_order,
              t_cancel_requested_resolves_to_filled_if_a_fill_raced_it,
              t_holdings_survives_rounding_via_explicit_closes_level,
              t_holdings_partial_sell_leaves_correct_remaining_quantity,
              t_holdings_aggregate_sell_closes_multiple_buys_at_one_level,
              t_holdings_repeat_cycle_at_the_same_level_is_not_erased,
              t_balance_divergence_pauses_new_orders,
              t_balance_check_fails_closed_on_the_very_first_call,
              t_real_balances_prefers_margin_balance_over_plain_balance,
              t_real_balances_reads_non_margin_lit_from_balance,
              t_tick_spacing_change_does_not_advance_if_cancel_fails,
              t_dynamic_order_size_does_not_thrash_on_real_boundary_chop,
              t_dynamic_order_size_persists_multiplier_and_base_capital_on_a_tier_switch,
              t_dynamic_order_size_refreshes_base_capital_every_time_it_returns_to_base_tier,
              t_dynamic_order_size_never_touches_multiplier_fields_when_growth_flag_is_off,
              t_dynamic_order_size_resize_without_a_tier_change_never_touches_the_multiplier,
              t_tick_does_not_rewrite_an_unchanged_resting_order,
        t_tick_skips_new_decisions_when_reconciliation_fails,
              t_flatten_sells_each_held_level_separately_with_correct_closes_level,
              t_flatten_does_not_report_completion_if_a_sell_failed,
              t_flatten_does_not_report_completion_if_a_cancel_failed,
              t_flatten_does_not_duplicate_sell_for_a_level_with_an_unresolved_resting_sell,
              t_flatten_logs_dust_stuck_distinctly_for_an_unsellable_remainder,
              t_current_holdings_paginates_past_a_single_page,
              t_touch_lock_heartbeat_detects_lock_loss_mid_tick,
              t_reconcile_logs_a_warning_for_a_long_unresolved_order,
              t_tick_blocks_new_entries_while_an_order_is_stale_unresolved,
              t_reconcile_falls_back_to_active_orders_when_the_co_index_lookup_misses,
              t_reconcile_checks_active_orders_at_most_once_per_pass,
              t_reconcile_marks_a_row_vanished_from_both_lookups_as_rejected_once_stale,
              t_tick_spacing_change_unsticks_once_the_vanished_order_resolves,
              t_flatten_aborts_if_the_lock_is_lost_during_the_cancel_loop,
              t_flatten_aborts_if_the_lock_is_lost_during_the_sell_loop,
              t_market_sell_level_refuses_without_the_lock,
              t_heartbeat_fails_closed_on_an_unverifiable_write,
              t_reconcile_credits_realized_profit_to_the_active_bucket,
              t_profit_bucket_balance_untouched_by_a_mode_switch,
              t_reconcile_isolates_a_per_row_write_failure_without_losing_other_rows_deltas,
              t_cancelled_buy_releases_its_reservation_automatically,
        t_a_partly_filled_open_buy_does_not_trip_the_balance_pause,
        t_dynamic_drawdown_sizes_on_available_cash_and_follows_the_gates,
        t_dynamic_drawdown_resize_uses_cash_left_not_the_full_investment,
              t_reconcile_row_write_failure_forces_a_fresh_balance_check_next_tick,
              t_check_balance_divergence_does_not_advance_timer_if_the_save_fails,
              t_tick_persists_cash_delta_even_when_price_is_unavailable,
              t_tick_fails_closed_if_the_cash_delta_persist_write_itself_fails,
              t_tick_persists_a_fresh_derived_bucket_snapshot_before_maintain_window,
              t_cover_drop_room_rises_automatically_once_a_funded_position_sells,
              t_bucket_balances_recompute_correctly_on_every_call,
              t_reconcile_uses_real_quote_delta_across_multiple_partial_fill_passes,
              t_tick_resizes_immediately_when_compound_bucket_grows,
              t_rest_cap_below_cap_profit_stays_in_rest,
              t_rest_cap_full_rest_overflows_to_chosen_bucket,
              t_rest_cap_withdrawal_reopens_rest,
              t_rest_cap_ignored_outside_rest_mode_or_without_cap,
              t_tick_passes_rest_cap_from_state,
              t_rate_limited_errors_back_off_before_retrying,
              t_a_resting_order_that_just_left_the_book_is_not_marked_rejected,
              t_compound_resizes_once_it_adds_a_hundredth_of_a_lit,
              t_compound_resize_never_changes_any_bucket,
              t_compound_resize_only_ever_adds_to_the_order_size,
              t_bucket_totals_come_from_the_cached_ledger_and_match_a_fresh_read,
              t_curve_plans_at_switch_on_and_moves_up_only_at_a_new_top,
              t_crash_reserve_holds_profit_and_deploys_once_at_minus_30,
              t_reserve_switched_on_later_keeps_the_profit_already_in_the_budget,
              t_spacing_change_asks_for_the_clean_reset):
        try:
            await t()
        except Exception as e:
            import traceback
            traceback.print_exc()
            FAIL.append(f"{t.__name__} raised {e}")
    print(f"\n==== {len(PASS)} passed, {len(FAIL)} failed ====")
    if FAIL:
        for f in FAIL:
            print("  FAILED:", f)
        sys.exit(1)


asyncio.run(main())
