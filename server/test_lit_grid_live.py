"""Offline tests for lit_grid_live. No network, no real money -- same plain-script convention as
test_core.py / test_lit_grid_paper.py (python3 test_lit_grid_live.py), Supabase and the Lighter
SDK both faked in-memory."""
import asyncio, math, os, sys

os.environ.setdefault("NEXT_PUBLIC_SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")
sys.path.insert(0, "/Users/julio/trading-bot/server")

import lit_grid_live as core
from lit_grid_live import (
    LitGridLive, round_price, round_size, clamp_order_size, price_to_int, size_to_int,
    _order_fill_amounts, MIN_BASE_AMOUNT, PRICE_DECIMALS, SIZE_DECIMALS,
    run_lit_grid_live,
)
from lit_grid_paper import level_of

PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{('  -> ' + str(extra)) if extra and not cond else ''}")


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
                if "status=in.(pending,open)" in path:
                    rows = [r for r in rows if r.get("status") in ("pending", "open")]
                elif "status=eq.filled&side=eq.buy" in path:
                    rows = [r for r in rows if r.get("status") == "filled" and r.get("side") == "buy"]
                elif "status=eq.filled&side=eq.sell" in path:
                    rows = [r for r in rows if r.get("status") == "filled" and r.get("side") == "sell"]
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
                 filled_base_amount=0, filled_quote_amount=0):
        self.client_order_index = client_order_index
        self.order_index = order_index
        self.status = status
        self.filled_base_amount = filled_base_amount
        self.filled_quote_amount = filled_quote_amount


class FakeOrdersResp:
    def __init__(self, orders):
        self.orders = orders


class FakeOrderApi:
    def __init__(self, orders_by_co=None):
        self.orders_by_co = orders_by_co or {}

    async def account_orders(self, authorization, client_order_indexes, account_index, _request_timeout=None):
        co_idxs = [int(x) for x in client_order_indexes.split(",")]
        return FakeOrdersResp([self.orders_by_co[c] for c in co_idxs if c in self.orders_by_co])


class FakeAsset:
    def __init__(self, symbol, balance, locked_balance=0):
        self.symbol = symbol
        self.balance = balance
        self.locked_balance = locked_balance


class FakeAccount:
    def __init__(self, assets):
        self.assets = assets


class FakeAccountResp:
    def __init__(self, assets):
        self.accounts = [FakeAccount(assets)]


class FakeAccountApi:
    def __init__(self, assets=None):
        self.assets = assets or []

    async def account(self, by, value, _headers=None, _request_timeout=None):
        return FakeAccountResp(self.assets)


class FakeSignerClient:
    ORDER_TYPE_LIMIT = "limit"
    ORDER_TIME_IN_FORCE_POST_ONLY = "post_only"

    def __init__(self, fail=False, err=None):
        self.fail = fail
        self.err = err
        self.placed = []
        self.cancelled = []

    async def create_order(self, **kwargs):
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
        return object(), object(), None

    def create_auth_token_with_expiry(self):
        return "fake-token", None


def base_state(**over):
    st = {
        "enabled": True, "spacing_pct": 0.125, "levels_up": 15, "levels_down": 3,
        "capital_usd": 500, "drawdown_pct": 10, "order_size_lit": 1.70,
        "live_price": None, "history_reset_at": None,
        "lock_owner": None, "lock_heartbeat": None,
    }
    st.update(over)
    return st


def make_bot(state, orders=None, signer_fail=False, signer_err=None,
             orders_by_co=None, assets=None):
    bot = LitGridLive.__new__(LitGridLive)
    bot._lock_id = "test"
    bot._lock_held = True
    bot._lock_checked_at = 0.0
    bot._lock_blocked_logged = False
    bot._last_level = None
    bot.live = core.LiveBook(core.MARKET_ID)
    bot._book_ws_connected_at = 0.0
    bot.account_index = 1
    bot._auth_token = None
    bot._auth_token_expiry_at = 0.0
    bot._last_balance_check = 0.0
    bot._balance_paused = False
    bot.client = FakeSignerClient(fail=signer_fail, err=signer_err)
    bot._order_api = FakeOrderApi(orders_by_co)
    bot._account_api = FakeAccountApi(assets)
    fake = FakeDb(state, orders)
    bot.sb = fake.sb
    return bot, fake


def t_precision_and_minimum_enforcement():
    check("price rounds to 4 decimals", round_price(3.123456) == 3.1235, round_price(3.123456))
    check("size rounds to 2 decimals", round_size(1.236) == 1.24, round_size(1.236))
    check("a size at or above the 1.00 LIT minimum is accepted",
          clamp_order_size(1.70) == 1.70, clamp_order_size(1.70))
    check("a size that rounds below the 1.00 LIT minimum is refused (None), never placed undersized",
          clamp_order_size(0.994) is None, clamp_order_size(0.994))
    check("a size exactly at the minimum is accepted",
          clamp_order_size(MIN_BASE_AMOUNT) == MIN_BASE_AMOUNT, clamp_order_size(MIN_BASE_AMOUNT))
    check("price_to_int scales by 10**PRICE_DECIMALS",
          price_to_int(3.1012) == round(3.1012 * 10 ** PRICE_DECIMALS), price_to_int(3.1012))
    check("size_to_int scales by 10**SIZE_DECIMALS",
          size_to_int(1.70) == round(1.70 * 10 ** SIZE_DECIMALS), size_to_int(1.70))


def t_order_fill_amounts_price_is_unit_invariant():
    # The PRICE computed from filled_quote/filled_base is a ratio -- correct regardless of the
    # open raw-vs-scaled ambiguity flagged in the module docstring. Only the raw qty depends on it.
    o = FakeOrder(1, filled_base_amount=170, filled_quote_amount=170 * 31012)
    qty, price = _order_fill_amounts(o)
    check("fill price is computed correctly from the quote/base ratio regardless of scale",
          abs(price - 31012) < 1e-6, price)
    check("no fill yet reads as (0.0, None), never a fabricated price",
          _order_fill_amounts(FakeOrder(2, filled_base_amount=0)) == (0.0, None),
          _order_fill_amounts(FakeOrder(2, filled_base_amount=0)))


async def t_place_grid_order_writes_ledger_before_sending():
    bot, fake = make_bot(base_state())
    row_id = await bot.place_grid_order(900, "buy", 3.10, 1.70)
    check("the ledger row exists and ends 'open' after a successful real placement",
          fake.orders[0]["status"] == "open", fake.orders[0])
    check("the real order was actually sent to the (fake) exchange",
          len(bot.client.placed) == 1, bot.client.placed)
    check("the placed order carries the same client_order_index the ledger row recorded",
          bot.client.placed[0]["client_order_index"] == fake.orders[0]["client_order_index"],
          (bot.client.placed[0]["client_order_index"], fake.orders[0]["client_order_index"]))


async def t_place_grid_order_rejected_by_exchange():
    bot, fake = make_bot(base_state(), signer_err="insufficient margin")
    await bot.place_grid_order(900, "buy", 3.10, 1.70)
    check("an exchange rejection marks the ledger row 'rejected', never silently dropped",
          fake.orders[0]["status"] == "rejected", fake.orders[0])


async def t_place_grid_order_unknown_outcome_stays_pending():
    # Direct safety requirement: a crash/timeout mid-send must NEVER be assumed as success or
    # failure -- the row stays 'pending' so reconciliation checks the exchange for the real
    # answer, rather than risking a duplicate order on a retry.
    bot, fake = make_bot(base_state(), signer_fail=True)
    row_id = await bot.place_grid_order(900, "buy", 3.10, 1.70)
    check("an unknown send outcome leaves the ledger row 'pending', not assumed either way",
          fake.orders[0]["status"] == "pending", fake.orders[0])
    check("the row id is still returned so the caller can track it", row_id == fake.orders[0]["id"], row_id)


async def t_reconcile_detects_a_fill_the_bot_never_saw_happen():
    # The core restart-safety scenario: we think an order is 'pending'/'open', but the exchange
    # already filled it (e.g. the fill happened between our last check and a crash/restart).
    pending_row = {"id": 1, "level": 900, "side": "buy", "client_order_index": 555,
                   "status": "open", "limit_price": 3.10, "size": 1.70}
    exchange_order = FakeOrder(555, order_index=42, status="filled",
                                filled_base_amount=170, filled_quote_amount=170 * 310)
    bot, fake = make_bot(base_state(), orders=[pending_row], orders_by_co={555: exchange_order})
    await bot.reconcile_pending_orders()
    row = fake.orders[0]
    check("reconciliation updates the ledger row to 'filled' from the exchange's real report",
          row["status"] == "filled", row)
    check("the REAL filled price (not our limit price) is recorded",
          abs(row["filled_price"] - 310.0) < 1e-6, row["filled_price"])
    check("the REAL filled quantity is recorded",
          abs(row["filled_qty"] - 1.70) < 1e-6, row["filled_qty"])


async def t_reconcile_leaves_truly_unknown_orders_pending():
    pending_row = {"id": 1, "level": 900, "side": "buy", "client_order_index": 999,
                   "status": "pending", "limit_price": 3.10, "size": 1.70}
    bot, fake = make_bot(base_state(), orders=[pending_row], orders_by_co={})  # exchange has no record
    await bot.reconcile_pending_orders()
    check("an order the exchange has no record of yet stays 'pending', not assumed lost",
          fake.orders[0]["status"] == "pending", fake.orders[0])


async def t_current_holdings_respects_tied_pairing():
    orders = [
        {"id": 1, "level": 900, "side": "buy", "status": "filled", "filled_qty": 1.70, "filled_price": 3.10},
        {"id": 2, "level": 901, "side": "buy", "status": "filled", "filled_qty": 1.68, "filled_price": 3.12},
        {"id": 3, "level": 901, "side": "sell", "status": "filled", "filled_qty": 1.70, "filled_price": 3.1},
    ]
    bot, fake = make_bot(base_state(), orders=orders)
    holdings = await bot.current_holdings()
    check("a buy at L closed by a filled sell at L+1 is NOT in current holdings",
          900 not in holdings, holdings)
    check("a buy at L with no matching sell at L+1 yet IS in current holdings",
          901 in holdings and abs(holdings[901]["qty"] - 1.68) < 1e-9, holdings)


async def t_balance_divergence_pauses_new_orders():
    # Ledger says 5 LIT held; real exchange says only 2 -- must pause, never trust bookkeeping
    # over the real balance.
    orders = [{"id": 1, "level": 900, "side": "buy", "status": "filled",
               "filled_qty": 5.0, "filled_price": 3.10}]
    bot, fake = make_bot(base_state(), orders=orders, assets=[FakeAsset("LIT", 2.0, 0.0)])
    safe = await bot.check_balance_divergence()
    check("a real divergence beyond tolerance blocks new order placement", safe is False, safe)
    check("the pause is logged", any(r["action"] == "balance_divergence_paused" for r in fake.runs), fake.runs)


async def t_balance_matches_allows_new_orders():
    orders = [{"id": 1, "level": 900, "side": "buy", "status": "filled",
               "filled_qty": 1.70, "filled_price": 3.10}]
    bot, fake = make_bot(base_state(), orders=orders, assets=[FakeAsset("LIT", 1.70, 0.0)])
    safe = await bot.check_balance_divergence()
    check("ledger matching the real exchange balance allows new order placement", safe is True, safe)


async def t_maintain_window_places_buys_in_the_active_down_window():
    bot, fake = make_bot(base_state(levels_down=3, order_size_lit=1.70))
    step = math.log(1 + 0.125 / 100)
    price = 3.10
    cur_lvl = level_of(price, step)
    await bot.maintain_window(fake.state, price)
    buy_levels = {o["level"] for o in fake.orders if o["side"] == "buy"}
    expected = {cur_lvl - 1, cur_lvl - 2, cur_lvl - 3}
    check("a buy is placed at every empty level in the active down-window, nowhere else",
          buy_levels == expected, (buy_levels, expected))


async def t_maintain_window_places_sells_for_held_levels():
    orders = [{"id": 1, "level": 900, "side": "buy", "status": "filled",
               "filled_qty": 1.70, "filled_price": 3.10}]
    bot, fake = make_bot(base_state(levels_down=0, order_size_lit=1.70), orders=orders)
    await bot.maintain_window(fake.state, 3.10)
    sell_rows = [o for o in fake.orders if o["side"] == "sell"]
    check("a sell is placed one level above a held (filled) buy",
          len(sell_rows) == 1 and sell_rows[0]["level"] == 901, sell_rows)


async def t_maintain_window_recomputes_order_size_when_missing():
    # The settings route nulls out order_size_lit after a spacing/capital/drawdown change --
    # maintain_window must recompute and persist it (not silently treat missing as zero and
    # place nothing forever).
    bot, fake = make_bot(base_state(levels_down=1, order_size_lit=None, capital_usd=500, drawdown_pct=10))
    await bot.maintain_window(fake.state, 3.10)
    check("order_size_lit is recomputed from capital/spacing/drawdown, not left null",
          fake.state["order_size_lit"] is not None and fake.state["order_size_lit"] > 0,
          fake.state.get("order_size_lit"))
    check("a buy is actually placed using the recomputed size",
          any(o["side"] == "buy" for o in fake.orders), fake.orders)


async def t_maintain_window_cancels_buys_that_drifted_out_of_window():
    stale = {"id": 1, "level": 500, "side": "buy", "status": "open", "client_order_index": 1,
             "exchange_order_id": 77, "limit_price": 1.0, "size": 1.70}
    bot, fake = make_bot(base_state(levels_down=3, order_size_lit=1.70), orders=[stale])
    await bot.maintain_window(fake.state, 3.10)  # real price is far above level 500
    check("a resting buy far outside the active window gets cancelled",
          fake.orders[0]["status"] == "cancelled", fake.orders[0])
    check("cancellation actually hit the (fake) exchange", 77 in bot.client.cancelled, bot.client.cancelled)


async def t_flatten_cancels_resting_orders_and_market_sells_holdings():
    resting = {"id": 1, "level": 902, "side": "buy", "status": "open", "client_order_index": 1,
               "exchange_order_id": 55, "limit_price": 3.00, "size": 1.70}
    held = {"id": 2, "level": 900, "side": "buy", "status": "filled",
            "filled_qty": 1.70, "filled_price": 3.10}
    bot, fake = make_bot(base_state(), orders=[resting, held])
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: 3.10
    await bot.flatten_all()
    check("every resting order is cancelled on the (fake) exchange", 55 in bot.client.cancelled, bot.client.cancelled)
    check("a real market sell order is placed for the full held quantity",
          len(bot.client.placed) == 1 and bot.client.placed[0]["base_amount"] == core.size_to_int(1.70),
          bot.client.placed)
    check("the bot ends disabled after flattening", fake.state["enabled"] is False, fake.state)
    check("flatten_requested is cleared", fake.state["flatten_requested"] is False, fake.state)


async def t_rate_limited_errors_back_off_before_retrying():
    # _run_tick_loop is what run_lit_grid_live() gathers -- exercised directly here since
    # run_lit_grid_live() itself needs real env vars/SDK setup to construct a bot.
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


async def main():
    t_precision_and_minimum_enforcement()
    t_order_fill_amounts_price_is_unit_invariant()
    for t in (t_place_grid_order_writes_ledger_before_sending,
              t_place_grid_order_rejected_by_exchange,
              t_place_grid_order_unknown_outcome_stays_pending,
              t_reconcile_detects_a_fill_the_bot_never_saw_happen,
              t_reconcile_leaves_truly_unknown_orders_pending,
              t_current_holdings_respects_tied_pairing,
              t_balance_divergence_pauses_new_orders,
              t_balance_matches_allows_new_orders,
              t_maintain_window_places_buys_in_the_active_down_window,
              t_maintain_window_places_sells_for_held_levels,
              t_maintain_window_cancels_buys_that_drifted_out_of_window,
              t_maintain_window_recomputes_order_size_when_missing,
              t_flatten_cancels_resting_orders_and_market_sells_holdings,
              t_rate_limited_errors_back_off_before_retrying):
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
