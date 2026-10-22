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


def make_bot(state, orders=None, signer_fail=False, signer_err=None, cancel_err=None,
             orders_by_co=None, assets=None, order_api_fail=False, account_api_fail=False,
             active_orders_by_co=None, active_orders_fail=False):
    bot = LitGridLive.__new__(LitGridLive)
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

async def t_place_grid_order_writes_ledger_before_sending():
    bot, fake = make_bot(base_state())
    await bot.place_grid_order(900, "buy", 3.10, 1.70)
    check("the ledger row exists and ends 'open' after a successful real placement",
          fake.orders[0]["status"] == "open", fake.orders[0])
    check("the real order was actually sent to the (fake) exchange",
          len(bot.client.placed) == 1, bot.client.placed)


async def t_place_grid_order_records_explicit_closes_level():
    bot, fake = make_bot(base_state())
    await bot.place_grid_order(901, "sell", 3.15, 1.70, closes_level=900)
    check("a sell's closes_level is recorded exactly as given, never recomputed from a price",
          fake.orders[0]["closes_level"] == 900, fake.orders[0])


async def t_place_grid_order_rejected_by_exchange():
    bot, fake = make_bot(base_state(), signer_err="insufficient margin")
    await bot.place_grid_order(900, "buy", 3.10, 1.70)
    check("an exchange rejection marks the ledger row 'rejected'",
          fake.orders[0]["status"] == "rejected", fake.orders[0])


async def t_place_grid_order_unknown_outcome_stays_pending():
    bot, fake = make_bot(base_state(), signer_fail=True)
    row_id = await bot.place_grid_order(900, "buy", 3.10, 1.70)
    check("an unknown send outcome leaves the ledger row 'pending'",
          fake.orders[0]["status"] == "pending", fake.orders[0])
    check("the row id is still returned", row_id == fake.orders[0]["id"], row_id)


# ── Cancel: intermediate state, not assumed final ───────────────────────────────────────────────

async def t_cancel_marks_cancel_requested_not_cancelled_directly():
    # External audit finding: a clean cancel ack is not proof of the REAL final exchange state
    # (a fill can race the cancel). cancel_order_row must not jump straight to 'cancelled'.
    row = {"id": 1, "exchange_order_id": 55}
    bot, fake = make_bot(base_state(), orders=[row])
    ok = await bot.cancel_order_row(row)
    check("a clean cancel send returns True", ok is True, ok)
    check("the row is marked 'cancel_requested', an intermediate state -- not 'cancelled' directly",
          fake.orders[0]["status"] == "cancel_requested", fake.orders[0])


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


async def t_cancel_order_row_checks_the_sdk_error():
    row = {"id": 1, "exchange_order_id": 55}
    bot, fake = make_bot(base_state(), cancel_err="cancel rejected")
    ok = await bot.cancel_order_row(row)
    check("a cancel the exchange explicitly rejects returns False", ok is False, ok)


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

async def t_maintain_window_places_buys_in_the_active_down_window():
    bot, fake = make_bot(base_state(levels_down=3, order_size_lit=1.70, usdc_balance=500.0))
    force_not_cold_start(bot)
    step = math.log(1 + 0.125 / 100)
    price = 3.10
    cur_lvl = level_of(price, step)
    await bot.maintain_window(fake.state, price)
    buy_levels = {o["level"] for o in fake.orders if o["side"] == "buy"}
    expected = {cur_lvl - 1, cur_lvl - 2, cur_lvl - 3}
    check("a buy is placed at every empty level in the active down-window",
          buy_levels == expected, (buy_levels, expected))


async def t_maintain_window_sell_price_is_exactly_one_step_above_real_cost():
    real_cost = 3.10
    orders = [{"id": 1, "level": 900, "side": "buy", "status": "filled",
               "filled_qty": 1.70, "filled_price": real_cost}]
    bot, fake = make_bot(base_state(levels_down=0, order_size_lit=1.70), orders=orders)
    await bot.maintain_window(fake.state, real_cost)
    sell_rows = [o for o in fake.orders if o["side"] == "sell"]
    expected_price = round_price(real_cost * 1.00125)
    check("the sell is placed exactly one spacing step above the real cost (direct multiplication, no floor())",
          len(sell_rows) == 1 and abs(sell_rows[0]["limit_price"] - expected_price) < 1e-9,
          (sell_rows, expected_price))
    check("the sell's closes_level is the real buy's level, set explicitly",
          sell_rows[0]["closes_level"] == 900, sell_rows[0])


async def t_maintain_window_cancels_conflicting_buy_and_defers_the_sell():
    # External audit finding: a sell could be placed at a price where a buy is ALREADY resting,
    # without cancelling it first -- a same-price self-trade risk. FOURTH-PASS FIX (P1-4): a
    # cancel ack is only a SENT request, not confirmation -- so the sell must be DEFERRED to the
    # next tick (after reconciliation confirms the conflict is actually gone), never placed in
    # the same breath as an unconfirmed cancel.
    step = math.log(1 + 0.125 / 100)
    real_cost = math.exp(900 * step)
    sell_price = round_price(real_cost * 1.00125)
    sell_lvl = level_of(sell_price, step)
    conflicting_buy = {"id": 1, "level": sell_lvl, "side": "buy", "status": "open",
                        "client_order_index": 1, "exchange_order_id": 99,
                        "limit_price": sell_price, "size": 1.70}
    held = {"id": 2, "level": 900, "side": "buy", "status": "filled",
            "filled_qty": 1.70, "filled_price": real_cost}
    bot, fake = make_bot(base_state(levels_down=0, order_size_lit=1.70), orders=[conflicting_buy, held])
    await bot.maintain_window(fake.state, real_cost)
    check("the conflicting resting buy at the sell's price is cancelled",
          99 in bot.client.cancelled, bot.client.cancelled)
    sells = [o for o in fake.orders if o["side"] == "sell"]
    check("the sell is DEFERRED, not placed in the same tick as an unconfirmed cancel",
          len(sells) == 0, sells)
    fake.orders[0]["status"] = "cancelled"  # simulate reconciliation confirming the cancel
    await bot.maintain_window(fake.state, real_cost)
    sells = [o for o in fake.orders if o["side"] == "sell"]
    check("once the conflict is confirmed gone, the sell is placed on the following tick",
          len(sells) == 1, sells)


async def t_maintain_window_conflict_check_matches_by_real_price_not_recomputed_level():
    # External audit finding (P2-8): the old conflict check keyed off a RECOMPUTED display level
    # (level_of(sell_price, step)), which can legitimately differ from a resting buy's own
    # stored level -- the same boundary-rounding hazard as the fill-pairing bug. The check must
    # match on the real price tick, never a recomputed level.
    step = math.log(1 + 0.125 / 100)
    real_cost = math.exp(900 * step)
    sell_price = round_price(real_cost * 1.00125)
    wrong_level = level_of(sell_price, step) + 1  # deliberately not the recomputed display level
    conflicting_buy = {"id": 1, "level": wrong_level, "side": "buy", "status": "open",
                        "client_order_index": 1, "exchange_order_id": 99,
                        "limit_price": sell_price, "size": 1.70}
    held = {"id": 2, "level": 900, "side": "buy", "status": "filled",
            "filled_qty": 1.70, "filled_price": real_cost}
    bot, fake = make_bot(base_state(levels_down=0, order_size_lit=1.70), orders=[conflicting_buy, held])
    await bot.maintain_window(fake.state, real_cost)
    check("the conflicting buy is found and cancelled by its REAL price, even though its stored "
          "level differs from the sell's recomputed display level",
          99 in bot.client.cancelled, bot.client.cancelled)


async def t_maintain_window_respects_real_usdc_minus_resting_commitments():
    # External audit finding: available cash must subtract what's ALREADY committed to this
    # bot's own resting buy orders, not just read the raw account balance.
    already_resting = {"id": 1, "level": 850, "side": "buy", "status": "open",
                        "client_order_index": 1, "limit_price": 10.0, "size": 1.0}  # $10 committed
    bot, fake = make_bot(base_state(levels_down=5, order_size_lit=1.70, usdc_balance=15.0),
                          orders=[already_resting])
    await bot.maintain_window(fake.state, 3.10)
    new_buys = [o for o in fake.orders if o["side"] == "buy" and o["id"] != 1]
    total_new_cost = sum(o["limit_price"] * o["size"] for o in new_buys)
    check("new buy spend stays within real cash MINUS what's already committed to resting buys",
          total_new_cost <= 5.0 + 1e-6, (total_new_cost, new_buys))


async def t_maintain_window_respects_capital_usd_as_a_ceiling_not_just_cash():
    # External audit finding: the cap must also respect capital_usd, not just real account cash
    # (which can be larger than the user intends this strategy to use).
    bot, fake = make_bot(base_state(levels_down=10, order_size_lit=1.70, usdc_balance=500.0, capital_usd=5.0))
    await bot.maintain_window(fake.state, 3.10)
    buys = [o for o in fake.orders if o["side"] == "buy"]
    total_cost = sum(o["limit_price"] * o["size"] for o in buys)
    check("total buy notional stays within capital_usd even though real cash is much larger",
          total_cost <= 5.0 + 1e-6, (total_cost, buys))


async def t_maintain_window_max_open_buys_is_a_persistent_lifetime_cap():
    # External audit finding: the old cap was a concurrent snapshot that reset once a cycle
    # completed. lifetime_buy_count must prevent a SECOND buy even after the first fully cycles.
    orders = [
        {"id": 1, "level": 900, "side": "buy", "status": "filled", "filled_qty": 1.70, "filled_price": 3.10},
        {"id": 2, "level": 901, "side": "sell", "closes_level": 900, "status": "filled",
         "filled_qty": 1.70, "filled_price": 3.1039},
    ]
    bot, fake = make_bot(base_state(levels_down=5, order_size_lit=1.70, usdc_balance=500.0,
                                     max_open_buys=1, lifetime_buy_count=1), orders=orders)
    await bot.maintain_window(fake.state, 3.10)
    new_buys = [o for o in fake.orders if o["side"] == "buy" and o["id"] not in (1, 2)]
    check("no new buy is placed once lifetime_buy_count already reached max_open_buys, "
          "even though the prior cycle fully completed and freed capacity",
          len(new_buys) == 0, new_buys)


async def t_maintain_window_increments_lifetime_buy_count_persistently():
    bot, fake = make_bot(base_state(levels_down=3, order_size_lit=1.70, usdc_balance=500.0,
                                     max_open_buys=1, lifetime_buy_count=0))
    force_not_cold_start(bot)
    await bot.maintain_window(fake.state, 3.10)
    check("lifetime_buy_count is incremented and persisted after the one allowed buy",
          fake.state["lifetime_buy_count"] == 1, fake.state["lifetime_buy_count"])
    buys = [o for o in fake.orders if o["side"] == "buy"]
    check("exactly one buy was placed", len(buys) == 1, buys)


async def t_maintain_window_recomputes_order_size_when_missing():
    bot, fake = make_bot(base_state(levels_down=1, order_size_lit=None, capital_usd=500, drawdown_pct=10))
    await bot.maintain_window(fake.state, 3.10)
    check("order_size_lit is recomputed from capital/spacing/drawdown",
          fake.state["order_size_lit"] is not None and fake.state["order_size_lit"] > 0,
          fake.state.get("order_size_lit"))


async def t_maintain_window_never_cancels_a_resting_buy_just_because_price_moved():
    # Direct request (eighth pass): window-chasing removed entirely -- a resting buy is no
    # longer cancelled just because price drifted far enough that its own level fell outside
    # the window's current edges. Only an explicit spacing change or a flatten cancels it now;
    # repeated cancel/replace cycles on pure price movement used to be able to burn through a
    # one-shot allowance with zero real fills ever happening.
    stale = {"id": 1, "level": 500, "side": "buy", "status": "open", "client_order_index": 1,
             "exchange_order_id": 77, "limit_price": 1.0, "size": 1.70}
    bot, fake = make_bot(base_state(levels_down=3, order_size_lit=1.70, usdc_balance=500.0), orders=[stale])
    force_not_cold_start(bot)
    await bot.maintain_window(fake.state, 3.10)
    check("a resting buy far from current price is left alone, not cancelled",
          fake.orders[0]["status"] == "open", fake.orders[0])
    check("no cancel request was ever sent for it", 77 not in bot.client.cancelled, bot.client.cancelled)


async def t_maintain_window_entries_blocked_still_maintains_existing_sells():
    orders = [{"id": 1, "level": 900, "side": "buy", "status": "filled",
               "filled_qty": 1.70, "filled_price": 3.10}]
    bot, fake = make_bot(base_state(levels_down=3, order_size_lit=1.70, usdc_balance=500.0), orders=orders)
    await bot.maintain_window(fake.state, 3.10, entries_allowed=False)
    new_orders = [o for o in fake.orders if o["id"] != 1]
    check("a sell for existing inventory is still placed while entries are blocked",
          any(o["side"] == "sell" for o in new_orders), new_orders)
    check("no NEW buys are placed while entries are blocked",
          not any(o["side"] == "buy" for o in new_orders), new_orders)


# ── Spacing change ───────────────────────────────────────────────────────────────────────────────

async def t_tick_cancels_everything_on_a_spacing_change():
    resting = {"id": 1, "level": 900, "side": "buy", "status": "open", "client_order_index": 1,
               "exchange_order_id": 77, "limit_price": 3.10, "size": 1.70}
    # A real confirmed-cancelled order, so reconciliation can actually clear it this same tick
    # (fix P1-4 requires the cancel to be CONFIRMED gone, not just requested, before advancing).
    confirmed_cancelled = FakeOrder(1, order_index=77, status="canceled", remaining_base_amount=0.0)
    bot, fake = make_bot(base_state(spacing_pct=0.25, internal_spacing_pct=0.125,
                                     order_size_lit=1.70, usdc_balance=500.0), orders=[resting],
                          orders_by_co={1: confirmed_cancelled})
    bot.fetch_current_price = lambda: _async_return(3.10)
    await bot.tick()
    check("a spacing change's resting order ends up confirmed cancelled",
          fake.orders[0]["status"] == "cancelled", fake.orders[0])
    check("internal_spacing_pct is updated once the cancel succeeded",
          fake.state["internal_spacing_pct"] == 0.25, fake.state)


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


async def t_tick_fill_is_recorded_and_its_sell_placed_in_the_same_tick():
    # Speed fix must not hide a fill: a buy the exchange reports filled is recorded, its cash
    # applied, and its sell (one line up) placed within that same tick -- the per-tick
    # holdings cache must see the fill reconciliation just wrote.
    lp = round(3.10 / 1.00125, 4)
    resting = {"id": 1, "level": -1, "side": "buy", "status": "open", "client_order_index": 1,
               "exchange_order_id": 77, "limit_price": lp, "size": 1.70}
    filled = FakeOrder(1, order_index=77, status="filled", filled_base_amount=1.70,
                       filled_quote_amount=round(1.70 * lp, 6), remaining_base_amount=0.0)
    bot, fake = make_bot(base_state(order_size_lit=1.70, usdc_balance=500.0, grid_anchor_price=3.10,
                                     levels_down=3),
                          orders=[resting], orders_by_co={1: filled})
    force_not_cold_start(bot)
    bot._last_balance_check = time.time()  # isolate the reconcile cash path from the periodic refresh
    bot.fetch_current_price = lambda: _async_return(3.0995)
    await bot.tick()
    sells = [o for o in fake.orders if o["side"] == "sell"]
    check("the fill is recorded", fake.orders[0]["status"] == "filled", fake.orders[0])
    check("its cash is applied", abs(fake.state["usdc_balance"] - (500.0 - 1.70 * lp)) < 1e-6,
          fake.state["usdc_balance"])
    check("its sell is placed one line up in the same tick",
          len(sells) == 1 and sells[0]["closes_level"] == -1 and abs(sells[0]["limit_price"] - 3.10) < 1e-9,
          sells)


async def t_tick_skips_new_decisions_when_reconciliation_fails():
    pending = {"id": 1, "level": 900, "side": "buy", "client_order_index": 555,
               "status": "pending", "limit_price": 3.10, "size": 1.70}
    bot, fake = make_bot(base_state(usdc_balance=500.0), orders=[pending], order_api_fail=True)
    bot.fetch_current_price = lambda: _async_return(3.10)
    await bot.tick()
    check("no new buys are placed when reconciliation itself failed this tick",
          not any(o["side"] == "buy" and o["id"] != 1 for o in fake.orders), fake.orders)


async def t_tick_refetches_state_after_balance_check():
    # External audit finding: maintain_window used to receive the STALE (pre-balance-check)
    # usdc_balance, since check_balance_divergence wrote a fresh value to the DB without the
    # caller's local `state` object being updated.
    bot, fake = make_bot(base_state(usdc_balance=0.0, levels_down=3, order_size_lit=1.70),
                          assets=[FakeAsset("USDC", balance=0, locked_balance=0, margin_balance=500.0)])
    force_not_cold_start(bot)
    bot.fetch_current_price = lambda: _async_return(3.10)
    await bot.tick()
    buys = [o for o in fake.orders if o["side"] == "buy"]
    check("buys are placed using the FRESH balance just read, not the stale $0 state at tick's start",
          len(buys) > 0, (buys, fake.state.get("usdc_balance")))


# ── Flatten ──────────────────────────────────────────────────────────────────────────────────────

async def t_flatten_sells_each_held_level_separately_with_correct_closes_level():
    # External audit finding: a single lump-sum flatten sell at a fake level=-1 broke the
    # ledger's level-based matching entirely. Flatten must sell per-level with real closes_level.
    held_a = {"id": 1, "level": 900, "side": "buy", "status": "filled",
              "filled_qty": 1.70, "filled_price": 3.10}
    held_b = {"id": 2, "level": 910, "side": "buy", "status": "filled",
              "filled_qty": 2.00, "filled_price": 3.15}
    bot, fake = make_bot(base_state(), orders=[held_a, held_b], assets=[FakeAsset("LIT", 0.0, 0.0)])
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: 3.10
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
    check("flatten correctly refuses to report completion while dust remains unsellable",
          not any(r["action"] == "flatten_completed" for r in fake.runs), fake.runs)


# ── Atomic one-shot buy allowance ────────────────────────────────────────────────────────────────

async def t_reserve_buy_allowance_is_an_atomic_conditional_patch():
    # External audit finding (P1-1): the allowance counter used to be written AFTER the order
    # was sent, as a separate, non-atomic step -- an ambiguous send (crash/timeout) could leave
    # the slot unconsumed. It must now be reserved BEFORE the order is ever attempted, atomically.
    bot, fake = make_bot(base_state(lifetime_buy_count=5))
    ok = await bot._reserve_buy_allowance(5)
    check("reservation succeeds when the expected count matches the current real state",
          ok == 6, ok)
    stale = await bot._reserve_buy_allowance(5)
    check("a second reservation against a now-stale expected count fails closed (None), "
          "never double-spending the same slot",
          stale is None, stale)


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


async def t_maintain_window_stops_immediately_once_the_lock_is_lost_mid_loop():
    # The heartbeat is now checked BEFORE each action (fifth-pass fix), so losing the lock on the
    # SECOND call should let exactly one buy through, then stop -- never finishing the window.
    bot, fake = make_bot(base_state(levels_down=3, order_size_lit=1.70, usdc_balance=500.0))
    force_not_cold_start(bot)
    orig_touch = bot._touch_lock_heartbeat
    calls = {"n": 0}

    async def losing_touch():
        calls["n"] += 1
        if calls["n"] >= 2:
            bot._lock_held = False
        return await orig_touch()
    bot._touch_lock_heartbeat = losing_touch
    await bot.maintain_window(fake.state, 3.10)
    buys = [o for o in fake.orders if o["side"] == "buy"]
    check("placement stops immediately once the lock is detected lost, not after finishing the window",
          len(buys) == 1, buys)


# ── Stale cash between balance refreshes ────────────────────────────────────────────────────────

async def t_tick_applies_fresh_fill_cash_delta_when_balance_refresh_is_skipped():
    # External audit finding (P2-7): the cash figure used for the spending cap could be stale by
    # up to the full 60s refresh interval even though a buy was JUST confirmed filled by
    # reconciliation this same tick. The confirmed fill's real cash impact must be applied to the
    # in-memory figure immediately when the periodic refresh didn't also run this tick.
    pending_buy = {"id": 1, "level": 900, "side": "buy", "client_order_index": 777,
                   "status": "pending", "limit_price": 3.10, "size": 1.70}
    filled = FakeOrder(777, order_index=55, status="filled",
                        filled_base_amount=1.70, filled_quote_amount=1.70 * 3.10, remaining_base_amount=0.0)
    bot, fake = make_bot(base_state(usdc_balance=10.0, levels_down=1, order_size_lit=1.70, capital_usd=500),
                          orders=[pending_buy], orders_by_co={777: filled})
    bot._last_balance_check = time.time()  # periodic refresh not due this tick
    bot.fetch_current_price = lambda: _async_return(3.10)
    await bot.tick()
    new_buys = [o for o in fake.orders if o["side"] == "buy" and o["id"] != 1]
    check("a same-tick fill's real cash cost is applied immediately, so a new buy is not placed "
          "against stale (pre-fill) cash that's no longer actually available",
          len(new_buys) == 0, (new_buys, fake.state.get("usdc_balance")))


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
    orig_cancel = bot.cancel_order_row

    async def losing_cancel(row):
        ok = await orig_cancel(row)
        if row["id"] == 1:
            bot._lock_held = False
        return ok
    bot.cancel_order_row = losing_cancel
    await bot.flatten_all()
    check("only the first cancel went out before the lock loss was noticed",
          sorted(bot.client.cancelled) == [50], bot.client.cancelled)
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


async def t_place_grid_order_refuses_without_a_verified_lock():
    bot, fake = make_bot(base_state(lock_owner="someone-else"))
    row_id = await bot.place_grid_order(900, "buy", 3.10, 1.70)
    check("place_grid_order refuses to send when the lock can't be verified as still owned",
          row_id is None, row_id)
    check("no ledger row was written", fake.orders == [], fake.orders)
    check("no real order was sent", bot.client.placed == [], bot.client.placed)


# ── Cash correction persists across ticks ───────────────────────────────────────────────────────

async def t_tick_persists_the_cash_correction_so_it_survives_the_next_tick():
    # External audit finding (P2, fourth independent audit): a same-tick cash correction used to
    # only live in a local variable -- the next tick's get_state() returned the stale pre-fill
    # balance again, since nothing wrote the corrected figure back.
    pending_buy = {"id": 1, "level": 900, "side": "buy", "client_order_index": 777,
                   "status": "pending", "limit_price": 3.10, "size": 1.70}
    filled = FakeOrder(777, order_index=55, status="filled",
                        filled_base_amount=1.70, filled_quote_amount=1.70 * 3.10, remaining_base_amount=0.0)
    bot, fake = make_bot(base_state(usdc_balance=10.0, levels_down=0, order_size_lit=None, capital_usd=500),
                          orders=[pending_buy], orders_by_co={777: filled})
    bot._last_balance_check = time.time()
    bot.fetch_current_price = lambda: _async_return(3.10)
    await bot.tick()
    check("the corrected cash figure is written back to the database, not just held in memory",
          abs(float(fake.state["usdc_balance"]) - (10.0 - 1.70 * 3.10)) < 1e-6, fake.state["usdc_balance"])


# ── Eighth-pass changes (direct request + seventh independent audit) ───────────────────────────

async def t_maintain_window_cold_start_fills_via_real_market_buys():
    # Cold start: levels_up market buys, one per lot, held at grid lines 0..levels_up-1.
    bot, fake = make_bot(base_state(levels_up=3, levels_down=15, order_size_lit=1.70,
                                     usdc_balance=500.0, capital_usd=500))
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: 3.10
    await bot.maintain_window(fake.state, 3.10)
    buys = [o for o in fake.orders if o["side"] == "buy"]
    check("a cold start market-buys exactly levels_up lots, one order each",
          len(buys) == 3 and sorted(o["level"] for o in buys) == [0, 1, 2]
          and all(abs(o["size"] - 1.70) < 1e-9 for o in buys), buys)
    check("the cold-start buys are sent via create_market_order, not a resting limit",
          len(bot.client.placed) == 3 and all("order_type" not in kwargs for kwargs in bot.client.placed),
          bot.client.placed)
    check("the grid is anchored at the starting price",
          fake.state.get("grid_anchor_price") == 3.10, fake.state.get("grid_anchor_price"))


async def t_cold_start_refuses_an_investment_bigger_than_the_real_balance():
    # Direct request: $500 investment with only $499.89 in the account must not start.
    bot, fake = make_bot(base_state(levels_up=5, levels_down=5, order_size_lit=2.16,
                                     usdc_balance=499.89, lit_balance=0.0, capital_usd=500))
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: 2.86
    logged = []
    orig = bot.log_run
    async def spy(action, detail):
        logged.append(action)
        await orig(action, detail)
    bot.log_run = spy
    await bot.maintain_window(fake.state, 2.86)
    check("no order is placed when the investment is more than the real balance",
          fake.orders == [] and bot.client.placed == [], fake.orders)
    check("the refusal is logged", "investment_exceeds_balance" in logged, logged)


async def t_levels_up_and_levels_down_are_independent():
    bot, fake = make_bot(base_state(levels_up=4, levels_down=15, order_size_lit=1.0,
                                     usdc_balance=5000.0, capital_usd=5000))
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: 3.10
    await bot.maintain_window(fake.state, 3.10)
    cold_start_buys = [o for o in fake.orders if o["side"] == "buy"]
    check("the cold start buys exactly levels_up lots, ignoring levels_down",
          len(cold_start_buys) == 4, cold_start_buys)


async def t_grid_after_cold_start_is_exactly_spacing_from_start_price():
    # Direct request: 5 up / 15 down at 0.125% -- sells at P*1.00125^k (k=1..5), buys at
    # P/1.00125^k (k=1..15), measured from the price the bot started at. No gap at the top.
    P = 2.8790
    bot, fake = make_bot(base_state(levels_up=5, levels_down=15, order_size_lit=2.16,
                                     usdc_balance=500.0, capital_usd=500))
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: P
    await bot.maintain_window(fake.state, P)
    for o in fake.orders:
        o["status"] = "filled"; o["filled_qty"] = o["size"]; o["filled_price"] = 2.8801
        o["filled_quote"] = o["size"] * 2.8801
    fake.state["usdc_balance"] = 500.0 - 5 * 2.16 * 2.8801
    await bot.maintain_window(fake.state, P)
    sells = sorted(float(o["limit_price"]) for o in fake.orders if o["side"] == "sell")
    buys = sorted((float(o["limit_price"]) for o in fake.orders
                   if o["side"] == "buy" and o["status"] != "filled"), reverse=True)
    want_sells = [core.round_price(P * 1.00125 ** k) for k in range(1, 6)]
    want_buys = [core.round_price(P * 1.00125 ** -k) for k in range(1, 16)]
    check("5 sells at exactly +0.125%, +0.25% ... +0.625% from the start price",
          sells == want_sells, (sells, want_sells))
    check("15 buys at exactly -0.125%, -0.25% ... -1.875% from the start price",
          buys == want_buys, (buys, want_buys))


async def t_trailing_down_keeps_levels_down_buys_below_price():
    # Direct request (trailing down): after the buy at line -1 fills, the 15 buys move down one
    # line (-2..-16) so there are always levels_down buys below price; -1 itself is held and
    # never bought again.
    P = 2.87055
    held = [{"id": 10 + k, "level": k, "side": "buy", "status": "filled", "filled_qty": 2.16,
             "filled_price": 2.8706, "size": 2.16} for k in range(-1, 5)]
    sells = [{"id": 30 + k, "level": k + 1, "side": "sell", "status": "open", "closes_level": k,
              "client_order_index": 300 + k, "exchange_order_id": 3000 + k, "size": 2.16,
              "limit_price": core.round_price(P * 1.00125 ** (k + 1))} for k in range(-1, 5)]
    buys = [{"id": 60 - k, "level": k, "side": "buy", "status": "open",
             "client_order_index": 600 - k, "exchange_order_id": 6000 - k, "size": 2.16,
             "limit_price": core.round_price(P * 1.00125 ** k)} for k in range(-16, -1)]
    bot, fake = make_bot(base_state(levels_up=5, levels_down=15, order_size_lit=2.16,
                                     usdc_balance=500.0, grid_anchor_price=P),
                          orders=held + sells + buys)
    await bot.maintain_window(fake.state, round(P / 1.00125, 5))
    open_buys = sorted(o["level"] for o in fake.orders if o["side"] == "buy" and o["status"] in ("open", "pending"))
    check("15 buys stay below price, on lines -2..-16", open_buys == list(range(-16, -1)), open_buys)
    check("no buy on the held line -1", -1 not in open_buys, open_buys)


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


async def t_a_buy_fill_creates_its_sell_and_one_bottom_buy_never_the_same_line():
    # 5 up / 15 down means always 15 buys below: a buy fill at -1 creates its sell one line up
    # (line 0) and one new buy at the bottom (-16), paid from capital while capital has room.
    P = 2.87055
    rows = _grid_rows(P, held=range(-1, 5), sells_for=range(0, 5), buys_at=range(-15, -1))
    bot, fake = make_bot(base_state(levels_up=5, levels_down=15, order_size_lit=2.16,
                                     usdc_balance=500.0, grid_anchor_price=P,
                                     profit_bucket_cover_drop_usd=0.0), orders=rows)
    before = {o["id"] for o in fake.orders}
    await bot.maintain_window(fake.state, round(P * 1.00125 ** -1 * 0.99995, 5))
    new = [o for o in fake.orders if o["id"] not in before]
    bottom = [o for o in new if o["side"] == "buy"]
    check("the filled buy gets its sell one line up",
          any(o["side"] == "sell" and o["closes_level"] == -1
              and abs(o["limit_price"] - core.round_price(P)) < 1e-9 for o in new), new)
    check("one new buy at the bottom (-16) keeps 15 buys below price",
          [o["level"] for o in bottom] == [-16], new)
    check("it is paid from capital while capital has room (cover-drop untouched)",
          bottom and bottom[0]["funded_from_bucket_usd"] == 0.0, bottom)
    check("no market buy is sent after a buy fill",
          all("order_type" in kw for kw in bot.client.placed), bot.client.placed)


async def t_trailing_down_uses_cover_drop_only_after_capital_is_used_up():
    # Capital exhausted (capital_usd covers only what's already committed): the bottom buy is
    # paid from the cover-drop bucket; with that empty too, no buy and one "no money" log.
    P = 2.87055
    rows = _grid_rows(P, held=range(-1, 5), sells_for=range(0, 5), buys_at=range(-15, -1))
    for cover, expect_buy in ((10.0, True), (0.0, False)):
        bot, fake = make_bot(base_state(levels_up=5, levels_down=15, order_size_lit=2.16,
                                         usdc_balance=500.0, capital_usd=1.0, grid_anchor_price=P,
                                         profit_bucket_cover_drop_usd=cover), orders=[dict(r) for r in rows])
        logged = []
        orig = bot.log_run
        async def spy(action, detail, orig=orig, logged=logged):
            logged.append(action)
            await orig(action, detail)
        bot.log_run = spy
        before = {o["id"] for o in fake.orders}
        await bot.maintain_window(fake.state, round(P * 1.00125 ** -1 * 0.99995, 5))
        new_buys = [o for o in fake.orders if o["id"] not in before and o["side"] == "buy"]
        if expect_buy:
            check("with capital used up, the bottom buy is paid from cover-drop",
                  len(new_buys) == 1 and new_buys[0]["funded_from_bucket_usd"] > 6.0, new_buys)
        else:
            check("with capital and cover-drop both used up, no buy and a 'no money' log",
                  new_buys == [] and "no_funds_for_buy" in logged, (new_buys, logged))


async def t_never_buys_the_same_line_twice_while_price_bounces():
    # Direct concern: buy at -1 fills, price bounces up a bit (not enough to sell) and comes back
    # down -- the bot must not buy -1 again until that lot's sell fills.
    P = 2.87055
    rows = _grid_rows(P, held=range(-1, 5), sells_for=range(-1, 5), buys_at=range(-16, -1))
    bot, fake = make_bot(base_state(levels_up=5, levels_down=15, order_size_lit=2.16,
                                     usdc_balance=500.0, grid_anchor_price=P), orders=rows)
    for px in (P * 1.00125 ** -0.5, P * 1.00125 ** -1.2, P * 1.00125 ** -0.3, P * 1.00125 ** -1.05):
        await bot.maintain_window(fake.state, round(px, 5))
    buys_on_minus1 = [o for o in fake.orders if o["side"] == "buy" and o["level"] == -1]
    check("line -1 is bought exactly once through the bounce", len(buys_on_minus1) == 1, buys_on_minus1)


async def t_no_funds_logs_once_and_stays_quiet():
    P = 2.87055
    rows = _grid_rows(P, held=range(-1, 5), sells_for=range(-1, 5), buys_at=range(-15, -1))
    bot, fake = make_bot(base_state(levels_up=5, levels_down=15, order_size_lit=2.16,
                                     usdc_balance=2.0, capital_usd=500, grid_anchor_price=P), orders=rows)
    logged = []
    orig = bot.log_run
    async def spy(action, detail):
        logged.append(action)
        await orig(action, detail)
    bot.log_run = spy
    before = len(fake.orders)
    await bot.maintain_window(fake.state, round(P / 1.00125 ** 1.05, 5))
    await bot.maintain_window(fake.state, round(P / 1.00125 ** 1.05, 5))
    check("no buy is placed without money", len(fake.orders) == before, fake.orders[before:])
    check("'no money' is logged once, not every tick", logged.count("no_funds_for_buy") == 1, logged)


async def t_trailing_up_keeps_levels_up_sells_and_twenty_orders():
    # Price rose through line 1: the sell at line 1 filled (lot 0 sold). Expect: a limit buy one
    # line below that sell (line 0), a market buy for a new lot at line 5 (its sell will sit at
    # line 6, the new top), and the lowest buy (-15) cancelled -- still 20 orders, 5 sells.
    P = 2.87055
    rows = _grid_rows(P, held=range(1, 5), sells_for=range(1, 5), buys_at=range(-15, 0), sold=[0])
    price = round(P * 1.00125 ** 1.3, 5)
    bot, fake = make_bot(base_state(levels_up=5, levels_down=15, order_size_lit=2.16,
                                     usdc_balance=500.0, grid_anchor_price=P), orders=rows)
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: price
    before = {o["id"] for o in fake.orders}
    await bot.maintain_window(fake.state, price)
    new = [o for o in fake.orders if o["id"] not in before]
    market = [kw for kw in bot.client.placed if "order_type" not in kw]
    check("the filled sell gets its buy one line below it (line 0)",
          [o["level"] for o in new if o["side"] == "buy" and o["limit_price"] < price] == [0], new)
    check("trailing up market-buys exactly one lot for line 5",
          len(market) == 1 and [o["level"] for o in new if o["side"] == "buy" and o["limit_price"] > price] == [5],
          (market, new))
    check("the lowest buy (-15) is cancelled to keep the grid at 20",
          next(o for o in fake.orders if o["side"] == "buy" and o["level"] == -15 and o["id"] in before)["status"] == "cancel_requested",
          [o for o in fake.orders if o["level"] == -15])
    for o in new:
        if o["side"] == "buy" and o["limit_price"] > price:
            o["status"] = "filled"; o["filled_qty"] = 2.16; o["filled_price"] = price
    for o in fake.orders:
        if o["status"] == "cancel_requested":
            o["status"] = "cancelled"
    await bot.maintain_window(fake.state, price)
    open_rows = [o for o in fake.orders if o["status"] in ("open", "pending")]
    sells_open = sorted(o["level"] for o in open_rows if o["side"] == "sell")
    check("once the lot fills, its sell is placed at the new top (line 6)",
          any(o["side"] == "sell" and o["closes_level"] == 5
              and abs(o["limit_price"] - core.round_price(P * 1.00125 ** 6)) < 1e-9 for o in open_rows), open_rows)
    check("5 sells above price", len(sells_open) == 5, sells_open)
    check("20 orders in total", len(open_rows) == 20, len(open_rows))
    check("no second trailing buy while 5 lots are held", len([kw for kw in bot.client.placed if "order_type" not in kw]) == 1,
          bot.client.placed)


async def t_a_lot_whose_sell_level_price_already_passed_is_sold_at_market():
    # Live bug: lot at -6 had its sell level (-5, 2.8259) below the market (2.836) -- the
    # post-only sell was cancelled on arrival, re-placed and cancelled 25+ times.
    P = 2.84365
    rows = _grid_rows(P, held=[-6], sells_for=[], buys_at=range(-11, -6))
    price = round(P * 1.00125 ** -2.7, 5)
    bot, fake = make_bot(base_state(levels_up=1, levels_down=5, order_size_lit=2.18,
                                     usdc_balance=500.0, grid_anchor_price=P), orders=rows)
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: price
    await bot.maintain_window(fake.state, price)
    limit_sells = [kw for kw in bot.client.placed if "order_type" in kw and kw.get("is_ask")]
    market_sells = [kw for kw in bot.client.placed if "order_type" not in kw and kw.get("is_ask")]
    check("no post-only sell is placed below the market", limit_sells == [], limit_sells)
    check("the lot is sold once at market instead", len(market_sells) == 1, bot.client.placed)
    await bot.maintain_window(fake.state, price)
    check("while that market sell is in flight it is not sent again",
          len([kw for kw in bot.client.placed if "order_type" not in kw and kw.get("is_ask")]) == 1,
          bot.client.placed)


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


async def t_gap_in_the_sell_ladder_is_filled_by_moving_the_top_sell_down():
    # Live 20:31: lot 20 was sold at market in a spike, leaving no sell on line 21 while sells
    # sat on 18,19,20,22..26. The top sell (line 26) is cancelled, then re-placed on line 21.
    P = 2.83365
    lots = [17, 18, 19, 21, 22, 23, 24, 25]
    rows = _grid_rows(P, held=lots, sells_for=lots, buys_at=range(12, 17))
    for r in rows:
        if r["side"] == "buy" and r["status"] == "filled" and r["level"] == 25:
            r["filled_price"] = round(P * 1.00125 ** 19.9, 4)  # trailing lot bought near line 19.9
    price = round(P * 1.00125 ** 17.6, 5)
    bot, fake = make_bot(base_state(levels_up=5, levels_down=5, order_size_lit=2.16,
                                     usdc_balance=500.0, grid_anchor_price=P), orders=rows)
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: price
    await bot.maintain_window(fake.state, price)
    top = next(r for r in fake.orders if r["side"] == "sell" and r.get("closes_level") == 25 and r["id"] < 100)
    check("the top sell (line 26) is cancelled to fill the gap", top["status"] == "cancel_requested", top)
    top["status"] = "cancelled"
    await bot.maintain_window(fake.state, price)
    moved = [r for r in fake.orders if r["side"] == "sell" and r.get("closes_level") == 25
             and r["status"] in ("open", "pending")]
    check("that lot's sell is re-placed on the gap line (21)",
          len(moved) == 1 and abs(moved[0]["limit_price"] - core.round_price(P * 1.00125 ** 21)) < 1e-9, moved)
    lines = sorted(round(math.log(r["limit_price"] / P) / math.log(1.00125)) for r in fake.orders
                   if r["side"] == "sell" and r["status"] in ("open", "pending"))
    check("the sell ladder is now contiguous (18..25)", lines == list(range(18, 26)), lines)


async def t_gap_fill_never_moves_a_sell_below_that_lots_cost():
    P = 2.83365
    lots = [17, 18, 19, 21, 22, 23, 24, 25]
    rows = _grid_rows(P, held=lots, sells_for=lots, buys_at=range(12, 17))  # lot 25 cost = line 25
    price = round(P * 1.00125 ** 17.6, 5)
    bot, fake = make_bot(base_state(levels_up=5, levels_down=5, order_size_lit=2.16,
                                     usdc_balance=500.0, grid_anchor_price=P), orders=rows)
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: price
    await bot.maintain_window(fake.state, price)
    check("a lot that cost more than the gap price keeps its sell",
          not any(r["status"] == "cancel_requested" for r in fake.orders), [r for r in fake.orders if r["status"] == "cancel_requested"])


async def t_dust_lot_does_not_pin_the_buy_ladder():
    # Live 2026-10-19 14:46-18:40: a buy cancelled after a 0.24 LIT partial fill left a lot at
    # line 49 that can never be sold (exchange minimum 1 LIT). Counted as held, it kept the 5
    # buys on 44..48 while price sat at line 55 and every real lot was at 73+ -- no trade for
    # 4+ hours. Dust must be ignored by the window: buys move to 51..55, right under price.
    P = 2.83365
    lots = [73, 74, 75, 76, 77]
    rows = _grid_rows(P, held=lots, sells_for=lots, buys_at=range(44, 49))
    rows.append({"id": 500, "level": 49, "side": "buy", "status": "filled", "filled_qty": 0.24,
                 "filled_price": round(P * 1.00125 ** 49, 4), "size": 2.16})
    price = round(P * 1.00125 ** 55.6, 5)
    bot, fake = make_bot(base_state(levels_up=5, levels_down=5, order_size_lit=2.16,
                                     usdc_balance=500.0, grid_anchor_price=P), orders=rows)
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: price
    logged = []
    orig = bot.log_run
    async def spy(action, detail, orig=orig):
        logged.append((action, detail))
        return await orig(action, detail)
    bot.log_run = spy
    await bot.maintain_window(fake.state, price)
    old = [r for r in fake.orders if r["side"] == "buy" and 44 <= r["level"] <= 48 and r["id"] < 500]
    check("the stale buys under the dust (44..48) are cancelled",
          all(r["status"] == "cancel_requested" for r in old), old)
    new_buys = sorted(r["level"] for r in fake.orders if r["side"] == "buy"
                      and r["status"] in ("open", "pending") and r["id"] > 500)
    check("new buys go right under price (51..55)", new_buys == list(range(51, 56)), new_buys)
    check("no sell is attempted for the 0.24 LIT dust",
          not any(r["side"] == "sell" and r.get("closes_level") == 49 for r in fake.orders))
    check("the dust is logged", any(a == "dust_lots_ignored" and d["levels"] == [49] for a, d in logged), logged)
    n = len(logged)
    await bot.maintain_window(fake.state, price)
    check("and logged only once", not any(a == "dust_lots_ignored" for a, _ in logged[n:]), logged[n:])


async def t_dust_lot_does_not_block_gap_fill():
    # Same live state: a dust lot has no sell, so it counted as a "free lot" and the top-sell
    # gap fill (which only runs when every lot has a sell) could never fire.
    P = 2.83365
    lots = [17, 18, 19, 21, 22, 23, 24, 25]
    rows = _grid_rows(P, held=lots, sells_for=lots, buys_at=range(12, 17))
    for r in rows:
        if r["side"] == "buy" and r["status"] == "filled" and r["level"] == 25:
            r["filled_price"] = round(P * 1.00125 ** 19.9, 4)
    rows.append({"id": 500, "level": 10, "side": "buy", "status": "filled", "filled_qty": 0.12,
                 "filled_price": round(P * 1.00125 ** 10, 4), "size": 2.16})
    price = round(P * 1.00125 ** 17.6, 5)
    bot, fake = make_bot(base_state(levels_up=5, levels_down=5, order_size_lit=2.16,
                                     usdc_balance=500.0, grid_anchor_price=P), orders=rows)
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: price
    await bot.maintain_window(fake.state, price)
    top = next(r for r in fake.orders if r["side"] == "sell" and r.get("closes_level") == 25 and r["id"] < 100)
    check("gap fill still cancels the top sell with a dust lot present",
          top["status"] == "cancel_requested", top)


async def t_dynamic_drawdown_sizes_on_available_cash_and_follows_the_gates():
    # Toggle on: high = price at switch-on, tier 10, size = spendable cash spread down to 10%
    # below the high. A 6% drop switches to 20% and re-sizes on the cash left; a further fall
    # past 20% -> 80%; back above -5% -> 10% again (same gates both ways).
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
    check("22% drop -> tier 80", sizes["drop22"][0] == 80, sizes)
    check("back within 5% of the high -> tier 10 again", sizes["back"][0] == 10, sizes)
    check("the high does not move on the way down", sizes["drop22"][2] == P, sizes)
    check("each switch is logged", [d["to"] for a, d in logged if a == "dynamic_drawdown_switch"] == [10, 20, 80, 10], logged)
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


async def t_dynamic_drawdown_off_keeps_the_normal_sizing():
    P = 2.83365
    bot, fake = make_bot(base_state(levels_up=5, levels_down=5, order_size_lit=None,
                                     usdc_balance=500.0, grid_anchor_price=P),
                          orders=_grid_rows(P, held=range(0, 5), sells_for=range(0, 5), buys_at=[]))
    await bot.maintain_window(fake.state, P * 0.999)
    check("toggle off: never writes a dynamic tier", fake.state.get("dynamic_dd_tier") is None, fake.state.get("dynamic_dd_tier"))


async def t_gap_fill_never_moves_a_cold_start_sell_down_to_breakeven():
    # Cold-start lots 0..4 all cost about the start price. Price dipping just under line 0
    # leaves line 0 empty -- moving the top sell there would sell at cost. Must not happen.
    P = 2.87055
    rows = _grid_rows(P, held=range(0, 5), sells_for=range(0, 5), buys_at=range(-5, 0))
    for r in rows:
        if r["side"] == "buy" and r["status"] == "filled":
            r["filled_price"] = P
    price = round(P * 1.00125 ** -0.3, 5)
    bot, fake = make_bot(base_state(levels_up=5, levels_down=5, order_size_lit=2.16,
                                     usdc_balance=500.0, grid_anchor_price=P), orders=rows)
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: price
    await bot.maintain_window(fake.state, price)
    check("no sell is moved down to breakeven", not any(r["status"] == "cancel_requested" for r in fake.orders),
          [r for r in fake.orders if r["status"] == "cancel_requested"])


async def t_trailing_up_counts_an_in_flight_buy_even_after_price_passes_its_band():
    # Live 2026-10-18 22:50-23:00: a trailing market buy was still unconfirmed when price had
    # already risen past its 0.5% band; the old check ("buy priced above the market") stopped
    # counting it and bought again -- 9 lots held against levels_up=5.
    P = 2.83365
    rows = _grid_rows(P, held=range(1, 5), sells_for=range(1, 5), buys_at=range(-4, 1), sold=[0])
    p0 = round(P * 1.00125 ** 1.3, 5)
    rows.append({"id": 500, "level": 5, "side": "buy", "status": "open", "client_order_index": 5000,
                 "exchange_order_id": 50000, "limit_price": core.round_price(p0 * 1.005), "size": 2.16, "order_kind": "market"})
    price = round(p0 * 1.008, 5)  # price now ABOVE that buy's band
    bot, fake = make_bot(base_state(levels_up=5, levels_down=5, order_size_lit=2.16,
                                     usdc_balance=500.0, grid_anchor_price=P), orders=rows)
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: price
    await bot.maintain_window(fake.state, price)
    check("an in-flight trailing buy is still counted after price passes its band -- no second buy",
          not any("order_type" not in kw and not kw.get("is_ask") for kw in bot.client.placed),
          bot.client.placed)


async def t_fast_rise_replay_never_holds_more_than_levels_up():
    # Replays a very fast rise tick by tick: price climbs 0.2% per tick (1.6 grid lines), limit
    # orders fill when price reaches them, and every MARKET order is only confirmed TWO ticks
    # after it was sent. Held lots + in-flight market buys must never exceed levels_up, and once
    # price settles the grid must hold exactly levels_up lots with levels_up sells.
    P = 2.83365
    levels_up, levels_down = 5, 5
    rows = _grid_rows(P, held=range(0, 5), sells_for=range(0, 5), buys_at=range(-5, 0))
    bot, fake = make_bot(base_state(levels_up=levels_up, levels_down=levels_down, order_size_lit=2.16,
                                     usdc_balance=2000.0, capital_usd=2000, grid_anchor_price=P),
                          orders=rows)
    born, kind = {}, {}
    worst = 0
    price = P * 1.0003
    for tick in range(45):
        price = round(price * 1.002, 5) if tick < 30 else price
        bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE, px=price: px
        for o in fake.orders:
            born.setdefault(o["id"], tick)
            if o["status"] == "cancel_requested":
                o["status"] = "cancelled"
            elif o["status"] in ("open", "pending"):
                fill_at = None
                if kind.get(o["id"]) == "market":
                    if tick - born[o["id"]] >= 2:
                        fill_at = price
                elif o["side"] == "sell" and o["limit_price"] <= price:
                    fill_at = o["limit_price"]
                elif o["side"] == "buy" and o["limit_price"] >= price:
                    fill_at = o["limit_price"]
                if fill_at is not None:
                    o["status"] = "filled"; o["filled_qty"] = o["size"]; o["filled_price"] = fill_at
                    o["filled_quote"] = o["size"] * fill_at
        ids_before = {o["id"] for o in fake.orders}
        n_calls = len(bot.client.placed)
        await bot.maintain_window(fake.state, price)
        new_rows = [o for o in fake.orders if o["id"] not in ids_before]
        for r, kw in zip(new_rows, bot.client.placed[n_calls:]):
            kind[r["id"]] = "market" if "order_type" not in kw else "limit"
        held = await bot.current_holdings()
        in_flight = [o for o in fake.orders if o["side"] == "buy" and o["status"] in ("open", "pending")
                     and kind.get(o["id"]) == "market"]
        worst = max(worst, len(held) + len(in_flight))
    held = await bot.current_holdings()
    open_sells = [o for o in fake.orders if o["side"] == "sell" and o["status"] in ("open", "pending")]
    check("through a very fast rise, held lots + in-flight market buys never exceed levels_up",
          worst <= levels_up, worst)
    check("after it settles, exactly levels_up lots are held", len(held) == levels_up, sorted(held))
    check("and exactly levels_up sells are resting", len(open_sells) == levels_up,
          sorted(o["limit_price"] for o in open_sells))


async def t_fast_drop_replay_keeps_the_grid_consistent():
    # Same replay, price FALLING 0.2% per tick: buys fill as price passes them. At every tick:
    # never more than levels_down open buys, never two open buys on one line, never a buy on a
    # held line, and every held lot ends up with exactly one sell.
    P = 2.83365
    levels_up, levels_down = 5, 5
    rows = _grid_rows(P, held=range(0, 5), sells_for=range(0, 5), buys_at=range(-5, 0))
    bot, fake = make_bot(base_state(levels_up=levels_up, levels_down=levels_down, order_size_lit=2.16,
                                     usdc_balance=5000.0, capital_usd=5000, grid_anchor_price=P),
                          orders=rows)
    born, kind = {}, {}
    problems = []
    price = P * 0.9997
    for tick in range(45):
        price = round(price * 0.998, 5) if tick < 30 else price
        bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE, px=price: px
        for o in fake.orders:
            born.setdefault(o["id"], tick)
            if o["status"] == "cancel_requested":
                o["status"] = "cancelled"
            elif o["status"] in ("open", "pending"):
                fill_at = None
                if kind.get(o["id"]) == "market":
                    if tick - born[o["id"]] >= 2:
                        fill_at = price
                elif o["side"] == "sell" and o["limit_price"] <= price:
                    fill_at = o["limit_price"]
                elif o["side"] == "buy" and o["limit_price"] >= price:
                    fill_at = o["limit_price"]
                if fill_at is not None:
                    o["status"] = "filled"; o["filled_qty"] = o["size"]; o["filled_price"] = fill_at
                    o["filled_quote"] = o["size"] * fill_at
        ids_before = {o["id"] for o in fake.orders}
        n_calls = len(bot.client.placed)
        await bot.maintain_window(fake.state, price)
        for r, kw in zip([o for o in fake.orders if o["id"] not in ids_before], bot.client.placed[n_calls:]):
            kind[r["id"]] = "market" if "order_type" not in kw else "limit"
        held = await bot.current_holdings()
        open_buys = [o["level"] for o in fake.orders if o["side"] == "buy" and o["status"] in ("open", "pending")]
        if len(open_buys) > levels_down:
            problems.append((tick, "too many buys", sorted(open_buys)))
        if len(open_buys) != len(set(open_buys)):
            problems.append((tick, "two buys on one line", sorted(open_buys)))
        if set(open_buys) & set(held):
            problems.append((tick, "buy on a held line", sorted(set(open_buys) & set(held))))
        if any(kind.get(o["id"]) == "market" and o["side"] == "buy" for o in fake.orders if born.get(o["id"], -1) == tick):
            problems.append((tick, "market buy during a drop", None))
    held = await bot.current_holdings()
    sells_by_lot = {}
    for o in fake.orders:
        if o["side"] == "sell" and o["status"] in ("open", "pending"):
            sells_by_lot[o["closes_level"]] = sells_by_lot.get(o["closes_level"], 0) + 1
    check("through a very fast drop the grid stays consistent (buy count, no doubles, no held-line buys)",
          problems == [], problems[:5])
    check("every held lot has exactly one sell after a fast drop",
          sorted(held) == sorted(sells_by_lot) and set(sells_by_lot.values()) <= {1},
          (sorted(held), sells_by_lot))


async def t_orders_are_placed_nearest_to_price_first_alternating_sides():
    # 2026-10-18 audit: sells went in the order each level was first ever bought, and always
    # before every buy. Now every new order goes in nearest to price first, alternating sides.
    P = 2.83365
    rows = _grid_rows(P, held=[3, 1, 4, 0, 2], sells_for=[], buys_at=[])  # bought out of order
    price = round(P * 1.00125 ** 0.4, 5)
    bot, fake = make_bot(base_state(levels_up=5, levels_down=5, order_size_lit=2.16,
                                     usdc_balance=500.0, grid_anchor_price=P), orders=rows)
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: price
    await bot.maintain_window(fake.state, price)
    placed = [("S" if kw["is_ask"] else "B", kw["price"]) for kw in bot.client.placed if "order_type" in kw]
    want = []
    for k in range(1, 6):
        want.append(("S", core.price_to_int(core.round_price(P * 1.00125 ** k))))
        want.append(("B", core.price_to_int(core.round_price(P * 1.00125 ** -k))))
    check("orders go in nearest to price first, alternating sell/buy", placed == want, (placed, want))


async def t_sells_are_still_placed_when_new_buys_are_not_allowed():
    # The sell queue must still be flushed when entries are off (bot disabled or paused).
    P = 2.83365
    rows = _grid_rows(P, held=[2, 0, 1], sells_for=[], buys_at=[])
    price = round(P * 1.00125 ** 0.4, 5)
    bot, fake = make_bot(base_state(levels_up=5, levels_down=5, order_size_lit=2.16,
                                     usdc_balance=500.0, grid_anchor_price=P), orders=rows)
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: price
    await bot.maintain_window(fake.state, price, entries_allowed=False)
    sells = [kw["price"] for kw in bot.client.placed if kw.get("is_ask")]
    buys = [kw for kw in bot.client.placed if not kw.get("is_ask")]
    check("with entries off, every held lot still gets its sell, nearest first",
          sells == [core.price_to_int(core.round_price(P * 1.00125 ** k)) for k in (1, 2, 3)], sells)
    check("and no buy is placed", buys == [], buys)


async def t_drawdown_coverage_counts_book_buys_plus_what_free_money_can_still_buy():
    # 5 lots held, 5 buys on the book (-1..-5), and free money for exactly 3 more lines (-6..-8):
    # coverage = how far below price line -8 is.
    P = 2.83365
    rows = _grid_rows(P, held=range(0, 5), sells_for=range(0, 5), buys_at=range(-5, 0))
    lp = lambda k: core.round_price(P * 1.00125 ** k)
    held_cost = sum(P * 1.00125 ** k * 2.16 for k in range(0, 5))
    resting_cost = sum(lp(k) * 2.16 for k in range(-5, 0))
    extra = sum(2.16 * P * 1.00125 ** k for k in (-6, -7, -8)) + 0.01
    price = round(P * 1.00125 ** 0.3, 5)
    bot, fake = make_bot(base_state(levels_up=5, levels_down=5, order_size_lit=2.16,
                                     usdc_balance=1000.0, capital_usd=held_cost + resting_cost + extra,
                                     grid_anchor_price=P), orders=rows)
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: price
    await bot.maintain_window(fake.state, price)
    want = round((1 - P * 1.00125 ** -8 / price) * 100, 2)
    check("coverage = distance to the deepest line the book + free money can pay for",
          fake.state.get("drawdown_coverage_pct") == want, (fake.state.get("drawdown_coverage_pct"), want))
    fake.state["profit_bucket_cover_drop_usd"] = 2.16 * P * 1.00125 ** -9 + 0.01
    await bot.maintain_window(fake.state, price)
    want9 = round((1 - P * 1.00125 ** -9 / price) * 100, 2)
    check("money in the cover-drop bucket extends the coverage by the lines it pays for",
          fake.state.get("drawdown_coverage_pct") == want9, (fake.state.get("drawdown_coverage_pct"), want9))


async def t_trailing_up_never_double_buys_while_a_market_buy_is_in_flight():
    P = 2.87055
    rows = _grid_rows(P, held=range(1, 5), sells_for=range(1, 5), buys_at=range(-14, 1), sold=[0])
    price = round(P * 1.00125 ** 1.3, 5)
    rows.append({"id": 500, "level": 5, "side": "buy", "status": "pending", "client_order_index": 5000,
                 "limit_price": core.round_price(price * 1.005), "size": 2.16, "order_kind": "market"})
    bot, fake = make_bot(base_state(levels_up=5, levels_down=15, order_size_lit=2.16,
                                     usdc_balance=500.0, grid_anchor_price=P), orders=rows)
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: price
    await bot.maintain_window(fake.state, price)
    check("an in-flight trailing buy is counted -- no second market buy",
          not any("order_type" not in kw for kw in bot.client.placed), bot.client.placed)


async def t_maintain_window_cold_start_budget_uses_real_price_not_theoretical_level_price():
    # The deep levels' theoretical grid price is much cheaper than live price -- a cold start's
    # REAL cost is what the live price actually charges, not each level's own (cheaper)
    # theoretical price, which would understate real spend and let too many levels buy.
    bot, fake = make_bot(base_state(levels_down=10, order_size_lit=1.0, usdc_balance=500.0, capital_usd=5.0))
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: 3.10
    await bot.maintain_window(fake.state, 3.10)
    buys = [o for o in fake.orders if o["side"] == "buy"]
    check("cold-start budget gating uses the real live price, capping spend correctly",
          len(buys) == 1, buys)


async def t_maintain_window_reverts_to_resting_limit_ladder_after_the_first_ever_fill():
    already_bought = {"id": 1, "level": 900, "side": "buy", "status": "filled",
                       "filled_qty": 1.70, "filled_price": 3.00, "size": 1.70}
    sold = {"id": 2, "level": 901, "side": "sell", "closes_level": 900, "status": "filled",
            "filled_qty": 1.70, "filled_price": 3.10}
    bot, fake = make_bot(base_state(levels_down=2, order_size_lit=1.70, usdc_balance=500.0),
                          orders=[already_bought, sold])
    await bot.maintain_window(fake.state, 3.10)
    buys = [o for o in fake.orders if o["side"] == "buy" and o["id"] not in (1, 2)]
    check("once any buy has ever filled, new buys go back to the ordinary resting-limit ladder",
          len(buys) > 0, buys)
    check("they're sent via create_order (limit), never create_market_order",
          all("order_type" in kwargs for kwargs in bot.client.placed), bot.client.placed)


async def t_maintain_window_accumulates_resting_buys_as_price_drifts_without_cancelling_old_ones():
    # Direct request (eighth pass): window-chasing removed. A resting buy placed on an earlier
    # tick must still be there after a later tick moves the window far away from it.
    already_bought = {"id": 1, "level": 1000, "side": "buy", "status": "filled",
                       "filled_qty": 1.70, "filled_price": 5.0, "size": 1.70}
    sold = {"id": 2, "level": 1001, "side": "sell", "closes_level": 1000, "status": "filled",
            "filled_qty": 1.70, "filled_price": 5.1}
    bot, fake = make_bot(base_state(levels_down=1, order_size_lit=1.0, usdc_balance=5000.0, capital_usd=5000),
                          orders=[already_bought, sold])
    step = math.log(1 + 0.125 / 100)
    price_high = math.exp(1000 * step)
    await bot.maintain_window(fake.state, price_high)
    first_buys = {o["level"] for o in fake.orders if o["side"] == "buy" and o["id"] not in (1, 2)}
    price_low = math.exp(990 * step)
    await bot.maintain_window(fake.state, price_low)
    second_buys = {o["level"] for o in fake.orders if o["side"] == "buy" and o["id"] not in (1, 2)}
    check("the earlier tick's resting buy is still there, not cancelled by the window moving away",
          first_buys.issubset(second_buys), (first_buys, second_buys))


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


async def t_funded_from_bucket_usd_is_written_in_the_same_insert_as_the_order():
    bot, fake = make_bot(base_state(levels_down=1, order_size_lit=1.70, usdc_balance=500.0,
                                     capital_usd=0, profit_bucket_cover_drop_usd=20.0))
    force_not_cold_start(bot)
    await bot.maintain_window(fake.state, 3.10)
    buys = [o for o in fake.orders if o["side"] == "buy"]
    check("the order's own row already carries its bucket-funded tag -- no separate PATCH needed",
          len(buys) == 1 and float(buys[0].get("funded_from_bucket_usd") or 0) > 0, buys)


async def t_mixed_funding_does_not_double_charge_the_base_budget():
    # External audit reproduction (seventh independent audit): a cover_drop-funded position was
    # ALSO being charged against the base capital_usd budget, on top of correctly reducing
    # cover_drop's own derived figure -- double-charging the same dollar against both budgets.
    cover_credit = {"id": 90, "side": "sell", "status": "filled", "realized_profit_usd": 10.0,
                    "profit_bucket_destination": "profit_bucket_cover_drop_usd"}
    cover_funded_holding = {"id": 1, "level": 900, "side": "buy", "status": "filled",
                             "filled_qty": 1.0, "filled_price": 10.0, "size": 1.0,
                             "funded_from_bucket_usd": 10.0}
    bot, fake = make_bot(base_state(levels_down=1, order_size_lit=1.0, usdc_balance=500.0, capital_usd=10.0),
                          orders=[cover_credit, cover_funded_holding])
    await bot.maintain_window(fake.state, 3.10)
    new_buys = [o for o in fake.orders if o["side"] == "buy" and o["id"] != 1]
    check("the base budget is not charged for a position entirely funded by cover_drop -- a new "
          "buy still gets placed using the full, untouched base budget",
          len(new_buys) == 1, new_buys)


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


async def t_tick_applies_cash_delta_from_the_spacing_change_reconcile_too():
    # External audit finding (sixth independent audit): the spacing-change branch called
    # reconcile_pending_orders() a second time and discarded its returned delta outright -- a
    # fill confirmed during that cancel-triggered pass was durably marked 'filled', but its cash
    # impact was never applied anywhere, permanently.
    resting = {"id": 1, "level": 900, "side": "buy", "status": "open", "client_order_index": 1,
               "exchange_order_id": 77, "limit_price": 3.10, "size": 1.70}
    bot, fake = make_bot(base_state(spacing_pct=0.25, internal_spacing_pct=0.125,
                                     usdc_balance=10.0, order_size_lit=1.70), orders=[resting])
    bot._last_balance_check = time.time()  # skip the periodic real-balance refresh this tick
    bot.fetch_current_price = lambda: _async_return(3.10)
    calls = {"n": 0}

    async def account_orders(authorization, client_order_indexes, account_index, _request_timeout=None):
        calls["n"] += 1
        if calls["n"] == 1:
            return FakeOrdersResp([FakeOrder(1, order_index=77, status="open", remaining_base_amount=1.70)])
        return FakeOrdersResp([FakeOrder(1, order_index=77, status="filled",
                                          filled_base_amount=1.70, filled_quote_amount=1.70 * 3.10,
                                          remaining_base_amount=0.0)])
    bot._order_api.account_orders = account_orders
    await bot.tick()
    check("a fill confirmed during the spacing-change cancel pass still has its cash delta applied",
          abs(float(fake.state["usdc_balance"]) - (10.0 - 1.70 * 3.10)) < 1e-6, fake.state["usdc_balance"])


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
    bot.check_balance_divergence = lambda: _async_return((True, False))
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


async def t_maintain_window_cover_drop_bucket_extends_buying_past_capital_usd():
    # Direct request: cover_drop spends ON TOP OF capital_usd, never replacing it, only once the
    # base budget is exhausted. Under the pure-derived model (seventh pass), "decremented by
    # what's spent" is no longer a write -- it's just that the spent amount is now RESERVED
    # (tagged on each still-open/filled buy), so the NEXT _bucket_balances() call derives a
    # correspondingly smaller available figure automatically.
    bot, fake = make_bot(base_state(levels_down=3, order_size_lit=1.70, usdc_balance=500.0,
                                     capital_usd=0), orders=[
        {"id": 90, "side": "sell", "status": "filled", "realized_profit_usd": 20.0,
         "profit_bucket_destination": "profit_bucket_cover_drop_usd"},
    ])
    state = dict(fake.state)
    state["profit_bucket_cover_drop_usd"] = 20.0
    await bot.maintain_window(state, 3.10)
    buys = [o for o in fake.orders if o["side"] == "buy"]
    check("buys are placed using the cover-drop bucket even though capital_usd alone is exhausted",
          len(buys) > 0, buys)
    total_cost = sum(o["limit_price"] * o["size"] for o in buys)
    buckets = await bot._bucket_balances()
    check("the derived cover-drop figure reflects exactly what's now reserved by those buys",
          abs(buckets["profit_bucket_cover_drop_usd"] - (20.0 - total_cost)) < 1e-6, buckets)


async def t_maintain_window_compound_bucket_increases_order_size():
    bot_flat, fake_flat = make_bot(base_state(levels_down=1, order_size_lit=None, capital_usd=500,
                                               drawdown_pct=10, profit_bucket_compound_usd=0.0))
    await bot_flat.maintain_window(fake_flat.state, 3.10)
    flat_size = fake_flat.state["order_size_lit"]

    bot_comp, fake_comp = make_bot(base_state(levels_down=1, order_size_lit=None, capital_usd=500,
                                               drawdown_pct=10, profit_bucket_compound_usd=500.0))
    await bot_comp.maintain_window(fake_comp.state, 3.10)
    compound_size = fake_comp.state["order_size_lit"]
    check("a nonzero compound bucket increases the recomputed order size",
          compound_size > flat_size, (compound_size, flat_size))


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


async def t_maintain_window_rejected_buy_is_not_charged_against_any_budget():
    bot, fake = make_bot(base_state(levels_down=1, order_size_lit=1.70, usdc_balance=500.0,
                                     capital_usd=0, profit_bucket_cover_drop_usd=20.0),
                          signer_err="insufficient margin")
    force_not_cold_start(bot)
    await bot.maintain_window(fake.state, 3.10)
    buys = [o for o in fake.orders if o["side"] == "buy"]
    check("the rejected order is still logged in the ledger", len(buys) == 1, buys)
    check("the rejected order's ledger row is marked rejected", buys[0]["status"] == "rejected", buys[0])
    check("a confirmed rejection is never charged against the cover-drop bucket",
          float(fake.state["profit_bucket_cover_drop_usd"]) == 20.0, fake.state["profit_bucket_cover_drop_usd"])


async def t_maintain_window_ambiguous_buy_send_is_still_charged_conservatively():
    bot, fake = make_bot(base_state(levels_down=1, order_size_lit=1.70, usdc_balance=500.0, capital_usd=0),
                          orders=[{"id": 90, "side": "sell", "status": "filled", "realized_profit_usd": 20.0,
                                   "profit_bucket_destination": "profit_bucket_cover_drop_usd"}],
                          signer_fail=True)  # network failure -- ambiguous, not a clean rejection
    state = dict(fake.state)
    state["profit_bucket_cover_drop_usd"] = 20.0
    await bot.maintain_window(state, 3.10)
    buys = [o for o in fake.orders if o["side"] == "buy"]
    check("an ambiguous send still writes a pending ledger row",
          len(buys) == 1 and buys[0]["status"] == "pending", buys)
    # A 'pending' row is still in OPEN_STATUSES, so it's still counted as reserved -- deliberately
    # conservative, same philosophy as the one-shot allowance counter.
    buckets = await bot._bucket_balances()
    check("an ambiguous send is still reserved against the bucket, conservatively",
          buckets["profit_bucket_cover_drop_usd"] < 20.0, buckets)


async def t_maintain_window_compound_bucket_also_extends_the_spending_ceiling():
    # External audit finding (sixth pass): compounding inflated the SIZING basis but the
    # SPENDING ceiling only ever used capital_usd (plus cover_drop) -- the two must agree.
    bot, fake = make_bot(base_state(levels_down=5, order_size_lit=1.70, usdc_balance=5000.0,
                                     capital_usd=0, profit_bucket_compound_usd=500.0))
    force_not_cold_start(bot)
    await bot.maintain_window(fake.state, 3.10)
    buys = [o for o in fake.orders if o["side"] == "buy"]
    total_cost = sum(o["limit_price"] * o["size"] for o in buys)
    check("the compound bucket also extends the spending ceiling, not just the sizing basis",
          total_cost > 0 and total_cost <= 500.0 + 1e-6, (total_cost, buys))


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
    bot, fake = make_bot(base_state(order_size_lit=1.70, levels_down=1, capital_usd=500,
                                     drawdown_pct=10, usdc_balance=5000.0), orders=[old_sell])
    bot.fetch_current_price = lambda: _async_return(3.10)
    await bot.tick()
    check("crediting the compound bucket triggers an immediate resize reflecting the bigger basis",
          fake.state["order_size_lit"] is not None and fake.state["order_size_lit"] > 1.70,
          fake.state["order_size_lit"])


# ── Window hysteresis ────────────────────────────────────────────────────────────────────────────

async def t_maintain_window_uses_hysteresis_guard_for_the_window_center():
    # External audit finding (P2-11): the active window used to recenter from the live price with
    # no hysteresis, so a resting buy sitting right at a boundary could be cancelled before ever
    # getting a chance to fill, wasting a one-shot allowance slot on nothing.
    step = math.log(1 + 0.125 / 100)
    lvl = 900
    boundary_price = math.exp((lvl + 1) * step)
    noise_price = boundary_price * 1.00001  # just barely over the boundary, within the guard band
    bot, fake = make_bot(base_state(levels_down=1, order_size_lit=1.70, usdc_balance=500.0))
    bot._window_center = lvl  # established on a prior tick
    resting_buy = {"id": 1, "level": lvl - 1, "side": "buy", "status": "open", "client_order_index": 1,
                   "exchange_order_id": 50, "limit_price": round_price(math.exp((lvl - 1) * step)),
                   "size": 1.70}
    fake.orders.append(resting_buy)
    await bot.maintain_window(fake.state, noise_price)
    check("boundary noise within the guard band does not shift the window center",
          bot._window_center == lvl, bot._window_center)
    check("a resting buy at the edge of the (unshifted) window is not cancelled on pure noise",
          fake.orders[0]["status"] == "open", fake.orders[0])


# ── Lock heartbeat ───────────────────────────────────────────────────────────────────────────────

async def t_lock_heartbeat_touched_after_each_order_placement():
    bot, fake = make_bot(base_state(levels_down=3, order_size_lit=1.70, usdc_balance=500.0))
    force_not_cold_start(bot)
    heartbeats = []
    orig_sb = bot.sb
    async def spying_sb(method, path, body=None):
        if method == "PATCH" and path.startswith(core.TABLE_STATE) and body and "lock_heartbeat" in body:
            heartbeats.append(body["lock_heartbeat"])
        return await orig_sb(method, path, body)
    bot.sb = spying_sb
    await bot.maintain_window(fake.state, 3.10)
    check("the lock heartbeat is touched at least once per order placed this tick",
          len(heartbeats) >= 3, len(heartbeats))


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


def t_plan_reanchor_puts_each_lot_near_its_cost_on_the_new_grid():
    A, old = 2.83365, math.log(1.00125)
    P = 3.40
    lots = {146: 3.4006, 147: 3.4048, 150: 3.4176, 140: 3.3752}
    rows = _reanchor_ledger(A, old, lots, closed=range(0, 30))
    buys, sells = _split(rows)
    levels = [r[k] for r in rows for k in ("level", "closes_level") if r.get(k) is not None]
    plan = core.plan_reanchor(buys, sells, levels, P, 0.5)
    check("a plan is produced", plan is not None)
    anchor, moves, mapping = plan
    new = math.log(1.005)
    check("the current price is exactly a line of the new grid",
          abs(anchor * math.exp(round(math.log(P / anchor) / new) * new) / P - 1) < 1e-9)
    check("every new line number is above every line number already in the ledger",
          min(mapping.values()) > max(abs(x) for x in levels), (mapping, max(levels)))
    for k, cost in lots.items():
        sell = anchor * math.exp((mapping[k] + 1) * new)
        check(f"lot bought at {cost} sells 0.25%-0.75% above cost on the new grid",
              0.0025 - 1e-9 <= sell / cost - 1 <= 0.0075 + 1e-9, sell / cost - 1)
    after = core.holdings_from_rows(
        [dict(b, level=moves[b["id"]][1]) if b["id"] in moves else b for b in buys], sells)
    check("total LIT held is unchanged", abs(sum(h["qty"] for h in after.values()) - 8.0) < 1e-9, after)
    check("total cost basis is unchanged",
          abs(sum(h["qty"] * h["cost"] for h in after.values()) - sum(2.0 * c for c in lots.values())) < 1e-9)
    check("only the held lots' rows move, closed history keeps its old line numbers",
          set(moves) == {r["id"] for r in rows if r["level"] in lots and r["side"] == "buy"}, moves)


def t_plan_reanchor_keeps_a_partly_sold_lot_on_its_own_line():
    A, old = 2.83365, math.log(1.00125)
    rows = _reanchor_ledger(A, old, {146: 3.4006, 147: 3.4010})
    rows.append({"id": 50, "level": 147, "side": "sell", "status": "cancelled", "closes_level": 146,
                 "filled_qty": 0.5, "filled_price": 3.4048})
    rows.append({"id": 51, "level": 146, "side": "buy", "status": "filled", "filled_qty": 1.0,
                 "filled_price": 3.3990, "size": 2.0})
    buys, sells = _split(rows)
    before = core.holdings_from_rows(buys, sells)
    levels = [r[k] for r in rows for k in ("level", "closes_level") if r.get(k) is not None]
    anchor, moves, mapping = core.plan_reanchor(buys, sells, levels, 3.40, 0.5)
    check("the partly sold lot and the whole lot get different lines", mapping[146] != mapping[147], mapping)
    check("the partial sell row follows its lot", moves.get(50) == ("closes_level", mapping[146]), moves)
    after = core.holdings_from_rows(
        [dict(b, level=moves[b["id"]][1]) if b["id"] in moves else b for b in buys],
        [dict(s, closes_level=moves[s["id"]][1]) if s["id"] in moves else s for s in sells])
    check("the partly sold lot keeps exactly its qty and cost",
          abs(after[mapping[146]]["qty"] - before[146]["qty"]) < 1e-9
          and abs(after[mapping[146]]["cost"] - before[146]["cost"]) < 1e-9, (before, after))


def t_plan_reanchor_places_dust_after_real_lots():
    A, old = 2.83365, math.log(1.00125)
    rows = _reanchor_ledger(A, old, {146: 3.4006})
    rows.append({"id": 40, "level": 145, "side": "buy", "status": "filled", "filled_qty": 1.2,
                 "filled_price": 3.4000, "size": 1.2})
    rows.append({"id": 41, "level": 146, "side": "sell", "status": "cancelled", "closes_level": 145,
                 "filled_qty": 1.0, "filled_price": 3.4040})
    buys, sells = _split(rows)
    levels = [r[k] for r in rows for k in ("level", "closes_level") if r.get(k) is not None]
    anchor, moves, mapping = core.plan_reanchor(buys, sells, levels, 3.40, 0.5)
    new = math.log(1.005)
    want = round(math.log(3.4006 / anchor) / new)
    check("the real lot gets its own nearest line even though dust sits next to it",
          mapping[146] == want, (mapping, want))
    check("the dust lot is moved off that line", mapping[145] != mapping[146], mapping)


async def t_tick_spacing_change_reanchors_held_lots_and_sells_near_cost():
    A = 2.83365
    old = math.log(1.00125)
    P = 3.40
    held = {146: 3.4006, 147: 3.4048, 148: 3.4091}
    rows = _reanchor_ledger(A, old, held, closed=range(0, 10))
    nid = max(r["id"] for r in rows) + 1
    for j, k in enumerate(held):
        rows.append({"id": nid + j, "level": k + 1, "side": "sell", "status": "open", "closes_level": k,
                     "client_order_index": 700 + j, "exchange_order_id": 7000 + j, "size": 2.0,
                     "limit_price": round(A * math.exp((k + 1) * old), 4)})
    cancelled = {700 + j: FakeOrder(700 + j, order_index=7000 + j, status="canceled",
                                    remaining_base_amount=0.0) for j in range(len(held))}
    bot, fake = make_bot(base_state(spacing_pct=0.5, internal_spacing_pct=0.125, grid_anchor_price=A,
                                     levels_up=5, levels_down=5, order_size_lit=2.0, usdc_balance=500.0),
                          orders=rows, orders_by_co=cancelled)
    bot.fetch_current_price = lambda: _async_return(P)
    before = await bot._compute_holdings()
    await bot.tick()
    check("internal_spacing_pct advances to the new spacing", fake.state["internal_spacing_pct"] == 0.5, fake.state)
    check("the grid is re-anchored", fake.state["grid_anchor_price"] != A, fake.state.get("grid_anchor_price"))
    check("the change is logged with the lots moved",
          any(r["action"] == "spacing_changed_rearmed" and r["detail"].get("lots_moved") for r in fake.runs),
          fake.runs)
    after = await bot._compute_holdings()
    check("same LIT held after re-anchoring",
          abs(sum(h["qty"] for h in after.values()) - sum(h["qty"] for h in before.values())) < 1e-9)
    check("same cost basis after re-anchoring",
          abs(sum(h["qty"] * h["cost"] for h in after.values())
              - sum(h["qty"] * h["cost"] for h in before.values())) < 1e-9)
    force_not_cold_start(bot)
    n0 = len(fake.orders)
    await bot.maintain_window(fake.state, P)
    new_sells = [o for o in fake.orders[n0:] if o["side"] == "sell"]
    new_buys = [o for o in fake.orders[n0:] if o["side"] == "buy" and o.get("order_kind") != "market"]
    lot_cost = {lv: h["cost"] for lv, h in after.items()}
    check("sells are re-placed for the held LIT", sum(o["size"] for o in new_sells) >= 6.0 - 1e-9, new_sells)
    check("every sell sits 0.25%-0.75% above its lot's cost (not at an old-line price)",
          new_sells and all(0.0025 - 1e-4 <= float(o["limit_price"]) / lot_cost[o["closes_level"]] - 1 <= 0.0075 + 1e-4
                            for o in new_sells),
          [(o["limit_price"], lot_cost.get(o["closes_level"])) for o in new_sells])
    check("every new resting buy is below price", all(float(o["limit_price"]) < P for o in new_buys),
          [o["limit_price"] for o in new_buys])
    check("new buys are 0.5% apart",
          all(abs(b / a - 1.005) < 1e-3 for a, b in zip(sorted(float(o["limit_price"]) for o in new_buys),
                                                         sorted(float(o["limit_price"]) for o in new_buys)[1:])),
          sorted(float(o["limit_price"]) for o in new_buys))


async def t_tick_spacing_change_without_anchor_keeps_old_behavior():
    rows = _reanchor_ledger(1.0, math.log(1.00125), {900: 3.10})
    bot, fake = make_bot(base_state(spacing_pct=0.5, internal_spacing_pct=0.125), orders=rows)
    bot.fetch_current_price = lambda: _async_return(3.10)
    await bot.tick()
    check("unanchored grid: spacing advances", fake.state["internal_spacing_pct"] == 0.5, fake.state)
    check("unanchored grid: no anchor is invented and no row is moved",
          fake.state.get("grid_anchor_price") is None and fake.orders[-1]["level"] == 900)



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


async def t_two_instances_in_one_process_never_touch_each_others_rows():
    # Real __init__ (not the __new__-bypass make_bot() harness), real place_grid_order() body,
    # a plain recording stub standing in for the network call -- proving the SAME in-memory
    # process can run a Worker 4 instance and a Worker 3 instance side by side with every write
    # going to each one's own table, never the other's (the exact property the live twin needs).
    calls = []

    async def record(method, path, body=None):
        calls.append((method, path))
        return [dict(body or {}, id=len(calls))]

    w4 = core.LitGridLive(None)
    w3 = core.LitGridLive(None, table_state="lighter_lit_grid_live_worker3_state",
                           table_orders="lighter_lit_grid_live_worker3_orders",
                           table_runs="lighter_lit_grid_live_worker3_runs", tag="-worker3")
    w4.sb = w3.sb = record
    w4._lock_held = w3._lock_held = True
    await w4.place_grid_order(900, "buy", 3.10, 1.70)
    await w3.place_grid_order(900, "buy", 3.10, 2.0)
    w4_calls = [c for c in calls if c[1] == core.TABLE_ORDERS]
    w3_calls = [c for c in calls if c[1] == "lighter_lit_grid_live_worker3_orders"]
    check("Worker 4's order went to Worker 4's own table", len(w4_calls) == 1, calls)
    check("Worker 3's order went to Worker 3's own table, never Worker 4's", len(w3_calls) == 1, calls)
    check("Worker 4's calls (lock/order/run) never mention 'worker3'",
          all("worker3" not in c[1] for c in calls[:3]), calls[:3])
    check("Worker 3's calls (lock/order/run) all stay on its own 'worker3' tables",
          all("worker3" in c[1] for c in calls[3:]), calls[3:])
    check("the two bots' lock ids differ (never collide in logs or lock ownership)",
          w4._lock_id != w3._lock_id, (w4._lock_id, w3._lock_id))


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
    check("tier 80 (20% gate): cover = (80-20)/(1-0.20) = 75",
          abs(core.cover_for_tier(80.0) - 75.0) < 1e-9)


def t_capital_corrected_spacing_multiplier_matches_verified_values():
    # 2026-10-22: replaces the old flat 1/2/3/4x table. Values below are the exact numbers
    # verified against the real sizing code and backtested in
    # research/lit-constant-profit-spacing-2026-10-22/PROPOSAL.md.
    base_cover = core.cover_for_tier(10.0)
    for tier, want in ((10.0, 1.0), (20.0, 1.2566), (40.0, 1.8257), (80.0, 2.7386)):
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
          core.dynamic_dd_tier_for_drop(20.0, 10.0) == 80.0)


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
          core.dynamic_dd_tier_for_drop(19.5, 80.0) == 80.0)
    check("20% gate: 18.9% de-escalates to 40 (past the band)",
          core.dynamic_dd_tier_for_drop(18.9, 80.0) == 40.0)


def t_dynamic_dd_tier_lets_a_real_recovery_fall_straight_through():
    # A genuine large recovery (not noise) must land wherever the raw gate says, in one step --
    # the band only guards the ONE gate that produced the current tier, never stacks per gate.
    check("drop falling from deep (old_tier 80) straight to 3% lands at base (10) in one step",
          core.dynamic_dd_tier_for_drop(3.0, 80.0) == 10.0)
    check("drop falling from deep (old_tier 80) to 15% lands at 40 in one step",
          core.dynamic_dd_tier_for_drop(15.0, 80.0) == 40.0)


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


async def t_tick_gate_switch_reanchors_to_the_wider_spacing_next_tick():
    # Direct research finding: starting narrow and staying flat into a deep drawdown gate can
    # collapse orders below the exchange minimum. With the growth flag on, a dynamic_dd_tier
    # already persisted at 40 (3rd tier) must make a fresh grid use 3x the dashboard spacing --
    # same held-lot re-anchor mechanics as t_tick_spacing_change_reanchors_held_lots_and_sells_near_cost,
    # just driven by a tier switch instead of a raw dashboard spacing edit.
    A = 2.83365
    old = math.log(1.00125)
    P = 3.40
    held = {146: 3.4006, 147: 3.4048, 148: 3.4091}
    rows = _reanchor_ledger(A, old, held, closed=range(0, 10))
    nid = max(r["id"] for r in rows) + 1
    for j, k in enumerate(held):
        rows.append({"id": nid + j, "level": k + 1, "side": "sell", "status": "open", "closes_level": k,
                     "client_order_index": 700 + j, "exchange_order_id": 7000 + j, "size": 2.0,
                     "limit_price": round(A * math.exp((k + 1) * old), 4)})
    cancelled = {700 + j: FakeOrder(700 + j, order_index=7000 + j, status="canceled",
                                    remaining_base_amount=0.0) for j in range(len(held))}
    bot, fake = make_bot(base_state(
        spacing_pct=0.125, internal_spacing_pct=0.125, grid_anchor_price=A,
        gate_spacing_growth_enabled=True, dynamic_dd_enabled=True, dynamic_dd_tier=40.0, dynamic_dd_high=4.0,
        gate_spacing_multiplier_value=3.0,
        levels_up=5, levels_down=5, order_size_lit=2.0, usdc_balance=500.0, lit_balance=6.0,
    ), orders=rows, orders_by_co=cancelled,
       assets=[FakeAsset("USDC", 500.0, 0.0), FakeAsset("LIT", 6.0, 0.0)])
    bot.fetch_current_price = lambda: _async_return(P)
    await bot.tick()
    check("internal_spacing_pct advances to 0.125 x3 = 0.375 (the 3rd-tier effective spacing)",
          abs(float(fake.state["internal_spacing_pct"]) - 0.375) < 1e-9, fake.state["internal_spacing_pct"])
    check("the grid is re-anchored (anchor price changed)", fake.state["grid_anchor_price"] != A, fake.state.get("grid_anchor_price"))
    force_not_cold_start(bot)
    n0 = len(fake.orders)
    await bot.maintain_window(fake.state, P)
    new_sells = [o for o in fake.orders[n0:] if o["side"] == "sell"]
    new_buys = [o for o in fake.orders[n0:] if o["side"] == "buy" and o.get("order_kind") != "market"]
    check("sells exist and are placed", len(new_sells) >= 1, new_sells)
    check("new sells sit 0.375% apart (not the plain 0.125% dashboard value), not bunched on old 0.125% lines",
          len(new_sells) >= 2 and all(abs(b / a - 1.00375) < 2e-3 for a, b in
                                  zip(sorted(float(o["limit_price"]) for o in new_sells),
                                      sorted(float(o["limit_price"]) for o in new_sells)[1:])),
          sorted(float(o["limit_price"]) for o in new_sells))
    check("new buys also sit 0.375% apart",
          len(new_buys) >= 2 and all(abs(b / a - 1.00375) < 2e-3 for a, b in
                                 zip(sorted(float(o["limit_price"]) for o in new_buys),
                                     sorted(float(o["limit_price"]) for o in new_buys)[1:])),
          sorted(float(o["limit_price"]) for o in new_buys))


async def t_tick_gate_spacing_growth_off_keeps_old_behavior_even_with_a_tier_recorded():
    # Regression guard: a bot with dynamic_dd on and a deep tier already recorded, already
    # anchored and holding a real lot from an earlier run (not a fresh cold start), but the
    # growth flag OFF (the default, and every bot before this feature existed) must never
    # widen or re-anchor because of the tier.
    A = 2.9
    held = {"id": 1, "level": 900, "side": "buy", "status": "filled", "filled_qty": 1.70,
            "filled_price": 2.90, "size": 1.70}
    bot, fake = make_bot(base_state(
        spacing_pct=0.125, internal_spacing_pct=0.125, grid_anchor_price=A, dynamic_dd_enabled=True,
        dynamic_dd_tier=80.0, dynamic_dd_high=4.0, order_size_lit=2.0, usdc_balance=500.0, lit_balance=1.70,
    ), orders=[held], assets=[FakeAsset("USDC", 500.0, 0.0), FakeAsset("LIT", 1.70, 0.0)])
    bot.fetch_current_price = lambda: _async_return(3.10)
    await bot.tick()
    check("no spacing change is detected -- internal_spacing_pct stays at the plain 0.125",
          fake.state.get("internal_spacing_pct") == 0.125, fake.state.get("internal_spacing_pct"))
    check("no reanchor fired (anchor price unchanged)", fake.state.get("grid_anchor_price") == A, fake.state.get("grid_anchor_price"))


async def main():
    t_precision_and_minimum_enforcement()
    t_order_fill_amounts_uses_real_human_decimal_units()
    t_order_is_terminal_uses_remaining_amount_primarily()
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
    t_plan_reanchor_puts_each_lot_near_its_cost_on_the_new_grid()
    t_plan_reanchor_keeps_a_partly_sold_lot_on_its_own_line()
    t_plan_reanchor_places_dust_after_real_lots()
    for t in (t_place_grid_order_writes_ledger_before_sending,
              t_place_grid_order_records_explicit_closes_level,
              t_place_grid_order_rejected_by_exchange,
              t_place_grid_order_unknown_outcome_stays_pending,
              t_cancel_marks_cancel_requested_not_cancelled_directly,
              t_cancel_requested_resolves_to_filled_if_a_fill_raced_it,
              t_cancel_order_row_checks_the_sdk_error,
              t_holdings_survives_rounding_via_explicit_closes_level,
              t_holdings_partial_sell_leaves_correct_remaining_quantity,
              t_holdings_aggregate_sell_closes_multiple_buys_at_one_level,
              t_holdings_repeat_cycle_at_the_same_level_is_not_erased,
              t_balance_divergence_pauses_new_orders,
              t_balance_check_fails_closed_on_the_very_first_call,
              t_real_balances_prefers_margin_balance_over_plain_balance,
              t_real_balances_reads_non_margin_lit_from_balance,
              t_maintain_window_places_buys_in_the_active_down_window,
              t_maintain_window_sell_price_is_exactly_one_step_above_real_cost,
              t_maintain_window_cancels_conflicting_buy_and_defers_the_sell,
              t_maintain_window_conflict_check_matches_by_real_price_not_recomputed_level,
              t_maintain_window_respects_real_usdc_minus_resting_commitments,
              t_maintain_window_respects_capital_usd_as_a_ceiling_not_just_cash,
              t_maintain_window_max_open_buys_is_a_persistent_lifetime_cap,
              t_maintain_window_increments_lifetime_buy_count_persistently,
              t_maintain_window_recomputes_order_size_when_missing,
              t_maintain_window_never_cancels_a_resting_buy_just_because_price_moved,
              t_maintain_window_entries_blocked_still_maintains_existing_sells,
              t_tick_cancels_everything_on_a_spacing_change,
              t_tick_spacing_change_does_not_advance_if_cancel_fails,
              t_tick_gate_switch_reanchors_to_the_wider_spacing_next_tick,
              t_dynamic_order_size_does_not_thrash_on_real_boundary_chop,
              t_dynamic_order_size_persists_multiplier_and_base_capital_on_a_tier_switch,
              t_dynamic_order_size_refreshes_base_capital_every_time_it_returns_to_base_tier,
              t_dynamic_order_size_never_touches_multiplier_fields_when_growth_flag_is_off,
              t_tick_gate_spacing_growth_off_keeps_old_behavior_even_with_a_tier_recorded,
              t_two_instances_in_one_process_never_touch_each_others_rows,
              t_tick_spacing_change_reanchors_held_lots_and_sells_near_cost,
              t_tick_spacing_change_without_anchor_keeps_old_behavior,
              t_tick_does_not_rewrite_an_unchanged_resting_order,
        t_tick_fill_is_recorded_and_its_sell_placed_in_the_same_tick,
        t_tick_skips_new_decisions_when_reconciliation_fails,
              t_tick_refetches_state_after_balance_check,
              t_flatten_sells_each_held_level_separately_with_correct_closes_level,
              t_flatten_does_not_report_completion_if_a_sell_failed,
              t_flatten_does_not_report_completion_if_a_cancel_failed,
              t_flatten_does_not_duplicate_sell_for_a_level_with_an_unresolved_resting_sell,
              t_flatten_logs_dust_stuck_distinctly_for_an_unsellable_remainder,
              t_reserve_buy_allowance_is_an_atomic_conditional_patch,
              t_current_holdings_paginates_past_a_single_page,
              t_touch_lock_heartbeat_detects_lock_loss_mid_tick,
              t_maintain_window_stops_immediately_once_the_lock_is_lost_mid_loop,
              t_tick_applies_fresh_fill_cash_delta_when_balance_refresh_is_skipped,
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
              t_place_grid_order_refuses_without_a_verified_lock,
              t_tick_persists_the_cash_correction_so_it_survives_the_next_tick,
              t_reconcile_credits_realized_profit_to_the_active_bucket,
              t_profit_bucket_balance_untouched_by_a_mode_switch,
              t_maintain_window_cover_drop_bucket_extends_buying_past_capital_usd,
              t_maintain_window_compound_bucket_increases_order_size,
              t_reconcile_isolates_a_per_row_write_failure_without_losing_other_rows_deltas,
              t_tick_applies_cash_delta_from_the_spacing_change_reconcile_too,
              t_cancelled_buy_releases_its_reservation_automatically,
              t_maintain_window_cold_start_fills_via_real_market_buys,
              t_levels_up_and_levels_down_are_independent,
        t_cold_start_refuses_an_investment_bigger_than_the_real_balance,
        t_grid_after_cold_start_is_exactly_spacing_from_start_price,
        t_trailing_down_keeps_levels_down_buys_below_price,
        t_a_buy_fill_creates_its_sell_and_one_bottom_buy_never_the_same_line,
        t_trailing_down_uses_cover_drop_only_after_capital_is_used_up,
        t_never_buys_the_same_line_twice_while_price_bounces,
        t_no_funds_logs_once_and_stays_quiet,
        t_trailing_up_keeps_levels_up_sells_and_twenty_orders,
        t_trailing_up_never_double_buys_while_a_market_buy_is_in_flight,
        t_trailing_up_counts_an_in_flight_buy_even_after_price_passes_its_band,
        t_fast_rise_replay_never_holds_more_than_levels_up,
        t_fast_drop_replay_keeps_the_grid_consistent,
        t_orders_are_placed_nearest_to_price_first_alternating_sides,
        t_sells_are_still_placed_when_new_buys_are_not_allowed,
        t_drawdown_coverage_counts_book_buys_plus_what_free_money_can_still_buy,
        t_a_partly_filled_open_buy_does_not_trip_the_balance_pause,
        t_gap_in_the_sell_ladder_is_filled_by_moving_the_top_sell_down,
        t_gap_fill_never_moves_a_sell_below_that_lots_cost,
        t_gap_fill_never_moves_a_cold_start_sell_down_to_breakeven,
        t_dust_lot_does_not_pin_the_buy_ladder,
        t_dust_lot_does_not_block_gap_fill,
        t_dynamic_drawdown_sizes_on_available_cash_and_follows_the_gates,
        t_dynamic_drawdown_resize_uses_cash_left_not_the_full_investment,
        t_dynamic_drawdown_off_keeps_the_normal_sizing,
        t_a_lot_whose_sell_level_price_already_passed_is_sold_at_market,
              t_maintain_window_cold_start_budget_uses_real_price_not_theoretical_level_price,
              t_maintain_window_reverts_to_resting_limit_ladder_after_the_first_ever_fill,
              t_maintain_window_accumulates_resting_buys_as_price_drifts_without_cancelling_old_ones,
              t_reconcile_row_write_failure_forces_a_fresh_balance_check_next_tick,
              t_check_balance_divergence_does_not_advance_timer_if_the_save_fails,
              t_funded_from_bucket_usd_is_written_in_the_same_insert_as_the_order,
              t_mixed_funding_does_not_double_charge_the_base_budget,
              t_tick_persists_cash_delta_even_when_price_is_unavailable,
              t_tick_fails_closed_if_the_cash_delta_persist_write_itself_fails,
              t_tick_persists_a_fresh_derived_bucket_snapshot_before_maintain_window,
              t_maintain_window_rejected_buy_is_not_charged_against_any_budget,
              t_maintain_window_ambiguous_buy_send_is_still_charged_conservatively,
              t_maintain_window_compound_bucket_also_extends_the_spending_ceiling,
              t_cover_drop_room_rises_automatically_once_a_funded_position_sells,
              t_bucket_balances_recompute_correctly_on_every_call,
              t_reconcile_uses_real_quote_delta_across_multiple_partial_fill_passes,
              t_tick_resizes_immediately_when_compound_bucket_grows,
              t_rest_cap_below_cap_profit_stays_in_rest,
              t_rest_cap_full_rest_overflows_to_chosen_bucket,
              t_rest_cap_withdrawal_reopens_rest,
              t_rest_cap_ignored_outside_rest_mode_or_without_cap,
              t_tick_passes_rest_cap_from_state,
              t_maintain_window_uses_hysteresis_guard_for_the_window_center,
              t_lock_heartbeat_touched_after_each_order_placement,
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
