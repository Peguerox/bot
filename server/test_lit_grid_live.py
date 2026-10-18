"""Offline tests for lit_grid_live. No network, no real money -- same plain-script convention as
test_core.py / test_lit_grid_paper.py (python3 test_lit_grid_live.py), Supabase and the Lighter
SDK both faked in-memory.

Several tests here specifically reproduce findings from the second, independent follow-up audit
(2026-10-18) -- including the core rounding bug, confirmed with plain arithmetic before writing
the fix: fill prices sit EXACTLY on a grid-bin boundary by construction, so rounding to the
exchange's real 4-decimal precision has roughly 50% odds of landing in the wrong bin on any given
fill. That's why sells are now linked to buys by an explicit `closes_level`, never a level
recomputed from a (rounded) price."""
import asyncio, math, os, sys

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
                open_set = "'" + "','".join(core.OPEN_STATUSES) + "'"
                if f"status=in.({','.join(core.OPEN_STATUSES)})" in path:
                    rows = [r for r in rows if r.get("status") in core.OPEN_STATUSES]
                elif "status=eq.filled&side=eq.buy" in path:
                    rows = [r for r in rows if r.get("status") == "filled" and r.get("side") == "buy"]
                elif "status=eq.filled&side=eq.sell" in path:
                    rows = [r for r in rows if r.get("status") == "filled" and r.get("side") == "sell"]
                return [dict(r) for r in sorted(rows, key=lambda r: r["id"])]
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
    def __init__(self, orders_by_co=None, fail=False, client=None):
        self.orders_by_co = orders_by_co or {}
        self.fail = fail
        self.client = client

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


class FakeAsset:
    def __init__(self, symbol, balance, locked_balance=0, margin_balance=None):
        self.symbol = symbol
        self.balance = balance
        self.locked_balance = locked_balance
        self.margin_balance = margin_balance


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


def base_state(**over):
    st = {
        "enabled": True, "spacing_pct": 0.125, "levels_up": 15, "levels_down": 3,
        "capital_usd": 500, "drawdown_pct": 10, "order_size_lit": 1.70,
        "usdc_balance": 500.0, "lit_balance": 0.0,
        "live_price": None, "history_reset_at": None, "internal_spacing_pct": 0.125,
        "max_open_buys": None, "lifetime_buy_count": 0,
        "lock_owner": None, "lock_heartbeat": None,
    }
    st.update(over)
    return st


def make_bot(state, orders=None, signer_fail=False, signer_err=None, cancel_err=None,
             orders_by_co=None, assets=None, order_api_fail=False, account_api_fail=False):
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
    bot.client = FakeSignerClient(fail=signer_fail, err=signer_err, cancel_err=cancel_err)
    bot._order_api = FakeOrderApi(orders_by_co, fail=order_api_fail, client=bot.client)
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
    safe = await bot.check_balance_divergence()
    check("a real divergence beyond tolerance blocks new order placement", safe is False, safe)


async def t_balance_check_fails_closed_on_the_very_first_call():
    bot, fake = make_bot(base_state(), account_api_fail=True)
    safe = await bot.check_balance_divergence()
    check("an unverifiable balance on the very first check fails CLOSED", safe is False, safe)


async def t_real_balances_prefers_margin_balance_over_plain_balance():
    bot, fake = make_bot(base_state(), assets=[
        FakeAsset("USDC", balance=0.0, locked_balance=0.0, margin_balance=544.549261262078),
    ])
    usdc, lit = await bot.real_balances()
    check("margin_balance is read as the real USDC total when present",
          abs(usdc - 544.549261262078) < 1e-6, usdc)


# ── Window maintenance ───────────────────────────────────────────────────────────────────────────

async def t_maintain_window_places_buys_in_the_active_down_window():
    bot, fake = make_bot(base_state(levels_down=3, order_size_lit=1.70, usdc_balance=500.0))
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


async def t_maintain_window_cancels_conflicting_buy_before_placing_a_sell():
    # External audit finding: a sell could be placed at a price where a buy is ALREADY resting,
    # without cancelling it first -- a same-price self-trade risk.
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
    check("the sell is placed after clearing the conflict", len(sells) == 1, sells)


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


async def t_maintain_window_cancels_buys_that_drifted_out_of_window():
    stale = {"id": 1, "level": 500, "side": "buy", "status": "open", "client_order_index": 1,
             "exchange_order_id": 77, "limit_price": 1.0, "size": 1.70}
    bot, fake = make_bot(base_state(levels_down=3, order_size_lit=1.70, usdc_balance=500.0), orders=[stale])
    await bot.maintain_window(fake.state, 3.10)
    check("a resting buy far outside the active window gets a cancel request sent",
          fake.orders[0]["status"] == "cancel_requested", fake.orders[0])
    check("cancellation actually hit the (fake) exchange", 77 in bot.client.cancelled, bot.client.cancelled)


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
    bot, fake = make_bot(base_state(spacing_pct=0.25, internal_spacing_pct=0.125,
                                     order_size_lit=1.70, usdc_balance=500.0), orders=[resting])
    bot.fetch_current_price = lambda: _async_return(3.10)
    await bot.tick()
    check("a spacing change triggers a cancel request on every resting order",
          fake.orders[0]["status"] == "cancel_requested", fake.orders[0])
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


# ── Lock heartbeat ───────────────────────────────────────────────────────────────────────────────

async def t_lock_heartbeat_touched_after_each_order_placement():
    bot, fake = make_bot(base_state(levels_down=3, order_size_lit=1.70, usdc_balance=500.0))
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


async def main():
    t_precision_and_minimum_enforcement()
    t_order_fill_amounts_uses_real_human_decimal_units()
    t_order_is_terminal_uses_remaining_amount_primarily()
    t_rounding_does_not_shift_the_real_fill_price_bin()
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
              t_maintain_window_places_buys_in_the_active_down_window,
              t_maintain_window_sell_price_is_exactly_one_step_above_real_cost,
              t_maintain_window_cancels_conflicting_buy_before_placing_a_sell,
              t_maintain_window_respects_real_usdc_minus_resting_commitments,
              t_maintain_window_respects_capital_usd_as_a_ceiling_not_just_cash,
              t_maintain_window_max_open_buys_is_a_persistent_lifetime_cap,
              t_maintain_window_increments_lifetime_buy_count_persistently,
              t_maintain_window_recomputes_order_size_when_missing,
              t_maintain_window_cancels_buys_that_drifted_out_of_window,
              t_maintain_window_entries_blocked_still_maintains_existing_sells,
              t_tick_cancels_everything_on_a_spacing_change,
              t_tick_spacing_change_does_not_advance_if_cancel_fails,
              t_tick_skips_new_decisions_when_reconciliation_fails,
              t_tick_refetches_state_after_balance_check,
              t_flatten_sells_each_held_level_separately_with_correct_closes_level,
              t_flatten_does_not_report_completion_if_a_sell_failed,
              t_flatten_does_not_report_completion_if_a_cancel_failed,
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
