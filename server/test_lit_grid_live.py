"""Offline tests for lit_grid_live. No network, no real money -- same plain-script convention as
test_core.py / test_lit_grid_paper.py (python3 test_lit_grid_live.py), Supabase and the Lighter
SDK both faked in-memory.

Several tests here specifically reproduce findings from the 2026-10-18 external audit (commit
49a64ef) before confirming the fix -- the fixture itself encodes the REAL exchange contract
(e.g. filled_base_amount as a human-decimal, not a raw scaled integer) so a test can't pass
merely by sharing the implementation's own wrong assumption, which is exactly how the original
bugs slipped past the first test suite."""
import asyncio, math, os, sys

os.environ.setdefault("NEXT_PUBLIC_SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")
sys.path.insert(0, "/Users/julio/trading-bot/server")

import lit_grid_live as core
from lit_grid_live import (
    LitGridLive, LiveSnapshot, round_price, round_size, clamp_order_size, price_to_int,
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
                if "status=in.(pending,open)" in path:
                    rows = [r for r in rows if r.get("status") in ("pending", "open")]
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
    """order_index/status/filled_base_amount/filled_quote_amount/remaining_base_amount, all in
    REAL human-decimal units -- matches Lighter's own documented read-schema, not the raw scaled
    integers the request side uses."""
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
    """orders_by_co covers orders a test wants to control explicitly. Any OTHER client_order_index
    asked about is auto-resolved as fully filled from `client.placed` (whatever was actually sent
    to the fake exchange) -- this mirrors a real exchange, which would have a real record of
    anything genuinely submitted, without every test needing to predict a time-derived id."""
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
        "max_open_buys": None,
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


# ── Precision / unit conversion ─────────────────────────────────────────────────────────────────

def t_precision_and_minimum_enforcement():
    check("price rounds to 4 decimals", round_price(3.123456) == 3.1235, round_price(3.123456))
    check("size rounds to 2 decimals", round_size(1.236) == 1.24, round_size(1.236))
    check("a size at or above the 1.00 LIT minimum is accepted",
          clamp_order_size(1.70) == 1.70, clamp_order_size(1.70))
    check("a size that rounds below the 1.00 LIT minimum is refused (None), never placed undersized",
          clamp_order_size(0.994) is None, clamp_order_size(0.994))
    check("price_to_int scales by 10**PRICE_DECIMALS",
          price_to_int(3.1012) == round(3.1012 * 10 ** PRICE_DECIMALS), price_to_int(3.1012))
    check("size_to_int scales by 10**SIZE_DECIMALS",
          size_to_int(1.70) == round(1.70 * 10 ** SIZE_DECIMALS), size_to_int(1.70))


def t_order_fill_amounts_uses_real_human_decimal_units():
    # External audit finding, confirmed independently against Lighter's own read-schema docs
    # (filled_base_amount example: "68.0066", a human-decimal string, not a raw scaled integer):
    # the old code divided by 10**SIZE_DECIMALS AGAIN, turning a real 1.70 LIT fill into 0.017.
    o = FakeOrder(1, filled_base_amount=1.70, filled_quote_amount=5.27)
    qty, price = _order_fill_amounts(o)
    check("fill quantity is the real human-decimal value, not divided by 100 again",
          abs(qty - 1.70) < 1e-9, qty)
    check("fill price is quote/base in real units", abs(price - (5.27 / 1.70)) < 1e-9, price)
    check("no fill yet reads as (0.0, None), never a fabricated price",
          _order_fill_amounts(FakeOrder(2, filled_base_amount=0)) == (0.0, None),
          _order_fill_amounts(FakeOrder(2, filled_base_amount=0)))


def t_order_is_terminal_uses_remaining_amount_primarily():
    check("zero remaining is terminal regardless of status string",
          _order_is_terminal(FakeOrder(1, status="open", remaining_base_amount=0.0)) is True)
    check("nonzero remaining with an ordinary open status is NOT terminal",
          _order_is_terminal(FakeOrder(1, status="open", remaining_base_amount=0.7)) is False)
    check("a canceled-post-only style status is terminal even with remaining reported",
          _order_is_terminal(FakeOrder(1, status="canceled-post-only", remaining_base_amount=1.2)) is True)
    check("a canceled-invalid-balance variant is also recognized (substring match, not an exact enum)",
          _order_is_terminal(FakeOrder(1, status="canceled-invalid-balance", remaining_base_amount=1.0)) is True)


# ── Order placement ──────────────────────────────────────────────────────────────────────────────

async def t_place_grid_order_writes_ledger_before_sending():
    bot, fake = make_bot(base_state())
    await bot.place_grid_order(900, "buy", 3.10, 1.70)
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
    bot, fake = make_bot(base_state(), signer_fail=True)
    row_id = await bot.place_grid_order(900, "buy", 3.10, 1.70)
    check("an unknown send outcome leaves the ledger row 'pending', not assumed either way",
          fake.orders[0]["status"] == "pending", fake.orders[0])
    check("the row id is still returned so the caller can track it", row_id == fake.orders[0]["id"], row_id)


# ── Reconciliation ───────────────────────────────────────────────────────────────────────────────

async def t_reconcile_detects_a_fill_the_bot_never_saw_happen():
    pending_row = {"id": 1, "level": 900, "side": "buy", "client_order_index": 555,
                   "status": "open", "limit_price": 3.10, "size": 1.70}
    exchange_order = FakeOrder(555, order_index=42, status="filled",
                                filled_base_amount=1.70, filled_quote_amount=5.27,
                                remaining_base_amount=0.0)
    bot, fake = make_bot(base_state(), orders=[pending_row], orders_by_co={555: exchange_order})
    ok = await bot.reconcile_pending_orders()
    check("reconciliation reports success when every batch read cleanly", ok is True, ok)
    row = fake.orders[0]
    check("reconciliation updates the ledger row to 'filled' from the exchange's real report",
          row["status"] == "filled", row)
    check("the REAL filled price (not our limit price) is recorded, in real units",
          abs(row["filled_price"] - (5.27 / 1.70)) < 1e-6, row["filled_price"])
    check("the REAL filled quantity is recorded, in real units (not divided by 100)",
          abs(row["filled_qty"] - 1.70) < 1e-6, row["filled_qty"])


async def t_reconcile_leaves_truly_unknown_orders_pending():
    pending_row = {"id": 1, "level": 900, "side": "buy", "client_order_index": 999,
                   "status": "pending", "limit_price": 3.10, "size": 1.70}
    bot, fake = make_bot(base_state(), orders=[pending_row], orders_by_co={})
    await bot.reconcile_pending_orders()
    check("an order the exchange has no record of yet stays 'pending', not assumed lost",
          fake.orders[0]["status"] == "pending", fake.orders[0])


async def t_reconcile_reports_failure_and_does_not_mark_rows():
    pending_row = {"id": 1, "level": 900, "side": "buy", "client_order_index": 555,
                   "status": "pending", "limit_price": 3.10, "size": 1.70}
    bot, fake = make_bot(base_state(), orders=[pending_row], order_api_fail=True)
    ok = await bot.reconcile_pending_orders()
    check("reconciliation reports failure when the read itself raised", ok is False, ok)
    check("the row is left untouched, not silently marked anything",
          fake.orders[0]["status"] == "pending", fake.orders[0])


async def t_reconcile_partial_fill_stays_open_for_further_reconciliation():
    # External audit finding: any positive fill used to be marked terminal immediately, so a
    # LATER fill on the same (still partially open) order was never seen again.
    pending_row = {"id": 1, "level": 900, "side": "buy", "client_order_index": 555,
                   "status": "open", "limit_price": 3.10, "size": 1.70}
    partial_order = FakeOrder(555, order_index=42, status="open",
                               filled_base_amount=0.50, filled_quote_amount=1.55,
                               remaining_base_amount=1.20)
    bot, fake = make_bot(base_state(), orders=[pending_row], orders_by_co={555: partial_order})
    await bot.reconcile_pending_orders()
    row = fake.orders[0]
    check("a genuine partial fill stays 'open', not prematurely marked 'filled'",
          row["status"] == "open", row)
    check("the partial fill's progress is still recorded",
          abs(row["filled_qty"] - 0.50) < 1e-9, row["filled_qty"])

    # Now the rest fills in.
    full_order = FakeOrder(555, order_index=42, status="filled",
                            filled_base_amount=1.70, filled_quote_amount=5.27,
                            remaining_base_amount=0.0)
    bot._order_api = FakeOrderApi({555: full_order})
    await bot.reconcile_pending_orders()
    row = fake.orders[0]
    check("the order is reconciled again on the NEXT pass since it stayed in pending/open",
          row["status"] == "filled", row)
    check("the final full fill quantity is recorded correctly",
          abs(row["filled_qty"] - 1.70) < 1e-9, row["filled_qty"])


async def t_reconcile_cancelled_with_partial_fill_preserves_the_real_quantity():
    pending_row = {"id": 1, "level": 900, "side": "buy", "client_order_index": 555,
                   "status": "open", "limit_price": 3.10, "size": 1.70}
    cancelled_partial = FakeOrder(555, order_index=42, status="canceled-post-only",
                                   filled_base_amount=0.40, filled_quote_amount=1.24,
                                   remaining_base_amount=1.30)
    bot, fake = make_bot(base_state(), orders=[pending_row], orders_by_co={555: cancelled_partial})
    await bot.reconcile_pending_orders()
    row = fake.orders[0]
    check("a cancelled order that did partially fill is marked 'filled' (it DID execute something)",
          row["status"] == "filled", row)
    check("its real partial quantity is preserved, not lost",
          abs(row["filled_qty"] - 0.40) < 1e-9, row["filled_qty"])


# ── Holdings reconstruction (FIFO pairing) ──────────────────────────────────────────────────────

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


async def t_current_holdings_repeat_cycle_at_the_same_level_is_not_erased():
    # THE external audit's core reproduction: buy@900, sell closes it, a NEW buy@900 starts a
    # new cycle. The old "ever sold at this level" set erased this new buy from inventory
    # entirely.
    orders = [
        {"id": 1, "level": 900, "side": "buy", "status": "filled", "filled_qty": 1.70, "filled_price": 3.10},
        {"id": 2, "level": 901, "side": "sell", "status": "filled", "filled_qty": 1.70, "filled_price": 3.1039},
        {"id": 3, "level": 900, "side": "buy", "status": "filled", "filled_qty": 1.65, "filled_price": 3.09},
    ]
    bot, fake = make_bot(base_state(), orders=orders)
    holdings = await bot.current_holdings()
    check("the SECOND cycle's buy at a previously-sold level is correctly tracked as current inventory",
          900 in holdings, holdings)
    check("its real quantity/cost from the NEW buy is used, not lost",
          abs(holdings[900]["qty"] - 1.65) < 1e-9 and abs(holdings[900]["cost"] - 3.09) < 1e-9,
          holdings.get(900))


async def t_current_holdings_aggregates_multiple_open_buys_at_one_level():
    orders = [
        {"id": 1, "level": 900, "side": "buy", "status": "filled", "filled_qty": 1.00, "filled_price": 3.00},
        {"id": 2, "level": 900, "side": "buy", "status": "filled", "filled_qty": 2.00, "filled_price": 3.30},
    ]
    bot, fake = make_bot(base_state(), orders=orders)
    holdings = await bot.current_holdings()
    check("quantity from more than one open buy at a level is SUMMED, never overwritten/lost",
          abs(holdings[900]["qty"] - 3.00) < 1e-9, holdings.get(900))
    expected_cost = (1.00 * 3.00 + 2.00 * 3.30) / 3.00
    check("cost basis is a weighted average across the aggregated buys",
          abs(holdings[900]["cost"] - expected_cost) < 1e-9, holdings.get(900))


# ── Balance divergence (fail-closed) ────────────────────────────────────────────────────────────

async def t_balance_divergence_pauses_new_orders():
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


async def t_balance_check_fails_closed_on_the_very_first_call():
    # External audit finding: an unverifiable balance used to default to "safe to trade" --
    # especially dangerous on the FIRST ever call, where _balance_paused's default (False)
    # meant a startup read failure let trading proceed completely unchecked.
    bot, fake = make_bot(base_state(), account_api_fail=True)
    safe = await bot.check_balance_divergence()
    check("an unverifiable balance on the very first check fails CLOSED, not open", safe is False, safe)


# ── Window maintenance ───────────────────────────────────────────────────────────────────────────

async def t_maintain_window_places_buys_in_the_active_down_window():
    bot, fake = make_bot(base_state(levels_down=3, order_size_lit=1.70, usdc_balance=500.0))
    step = math.log(1 + 0.125 / 100)
    price = 3.10
    cur_lvl = level_of(price, step)
    await bot.maintain_window(fake.state, price)
    buy_levels = {o["level"] for o in fake.orders if o["side"] == "buy"}
    expected = {cur_lvl - 1, cur_lvl - 2, cur_lvl - 3}
    check("a buy is placed at every empty level in the active down-window, nowhere else",
          buy_levels == expected, (buy_levels, expected))


async def t_maintain_window_places_sells_for_held_levels():
    step = math.log(1 + 0.125 / 100)
    real_cost = math.exp(900 * step)  # self-consistent: cost actually corresponds to level 900
    orders = [{"id": 1, "level": 900, "side": "buy", "status": "filled",
               "filled_qty": 1.70, "filled_price": real_cost}]
    bot, fake = make_bot(base_state(levels_down=0, order_size_lit=1.70), orders=orders)
    await bot.maintain_window(fake.state, real_cost)
    sell_rows = [o for o in fake.orders if o["side"] == "sell"]
    check("a sell is placed one level above a held (filled) buy",
          len(sell_rows) == 1 and sell_rows[0]["level"] == 901, sell_rows)


async def t_maintain_window_never_submits_buy_and_sell_at_the_same_level_in_one_tick():
    # External audit's reproduction: a held level-900 lot, current price at level 903 -- the old
    # code placed BOTH a buy and a sell at level 901 in the same tick (stale pre-tick snapshot
    # read by both passes). Sells must win; the conflicting buy must be skipped.
    step = math.log(1 + 0.125 / 100)
    real_cost = math.exp(900 * step)  # self-consistent: cost actually corresponds to level 900
    orders = [{"id": 1, "level": 900, "side": "buy", "status": "filled",
               "filled_qty": 1.70, "filled_price": real_cost}]
    bot, fake = make_bot(base_state(levels_down=3, order_size_lit=1.70, usdc_balance=500.0), orders=orders)
    price = math.exp(903 * step)
    await bot.maintain_window(fake.state, price)
    level_901_sides = {o["side"] for o in fake.orders if o["level"] == 901}
    check("level 901 never has BOTH a buy and a sell placed in the same tick",
          not ({"buy", "sell"} <= level_901_sides), fake.orders)
    check("the sell (closing real inventory) is the one that wins the slot",
          "sell" in level_901_sides, fake.orders)


async def t_maintain_window_respects_real_usdc_balance_as_a_spending_cap():
    # External audit finding: capital_usd was never actually enforced as a spending cap --
    # order_size * however many window levels could far exceed it. Here order_size (1.70) at
    # price ~3.10 costs ~$5.27/buy; with only $12 real USDC, at most 2 buys should ever land.
    bot, fake = make_bot(base_state(levels_down=10, order_size_lit=1.70, usdc_balance=12.0))
    await bot.maintain_window(fake.state, 3.10)
    buys = [o for o in fake.orders if o["side"] == "buy"]
    check("real usdc_balance caps how many buys actually get placed, regardless of window size",
          len(buys) <= 2, (len(buys), fake.orders))
    total_cost = sum(o["limit_price"] * o["size"] for o in buys)
    check("total committed notional never exceeds the real available cash",
          total_cost <= 12.0 + 1e-6, total_cost)


async def t_maintain_window_recomputes_order_size_when_missing():
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
    bot, fake = make_bot(base_state(levels_down=3, order_size_lit=1.70, usdc_balance=500.0), orders=[stale])
    await bot.maintain_window(fake.state, 3.10)
    check("a resting buy far outside the active window gets cancelled",
          fake.orders[0]["status"] == "cancelled", fake.orders[0])
    check("cancellation actually hit the (fake) exchange", 77 in bot.client.cancelled, bot.client.cancelled)


async def t_maintain_window_entries_blocked_still_maintains_existing_sells():
    # External audit finding: disabling used to skip reconciliation/management entirely.
    # entries_allowed=False must still place the sell for an already-held lot.
    orders = [{"id": 1, "level": 900, "side": "buy", "status": "filled",
               "filled_qty": 1.70, "filled_price": 3.10}]
    bot, fake = make_bot(base_state(levels_down=3, order_size_lit=1.70, usdc_balance=500.0), orders=orders)
    await bot.maintain_window(fake.state, 3.10, entries_allowed=False)
    new_orders = [o for o in fake.orders if o["id"] != 1]  # exclude the pre-existing held buy
    check("a sell for existing inventory is still placed while entries are blocked",
          any(o["side"] == "sell" for o in new_orders), new_orders)
    check("no NEW buys are placed while entries are blocked",
          not any(o["side"] == "buy" for o in new_orders), new_orders)


async def t_maintain_window_sell_target_uses_real_cost_under_current_spacing():
    # External audit finding: a held lot's sell price was computed from its STORED level
    # reinterpreted under whatever spacing is currently configured -- wrong after a spacing
    # change. The fix derives the sell target from the lot's real recorded cost instead.
    old_step = math.log(1 + 0.125 / 100)
    real_cost = 3.10
    stored_level = level_of(real_cost, old_step)  # the level this buy was placed/recorded at
    orders = [{"id": 1, "level": stored_level, "side": "buy", "status": "filled",
               "filled_qty": 1.70, "filled_price": real_cost}]
    new_spacing = 0.25  # changed since the buy was placed
    bot, fake = make_bot(base_state(levels_down=0, order_size_lit=1.70, spacing_pct=new_spacing), orders=orders)
    new_step = math.log(1 + new_spacing / 100)
    await bot.maintain_window(fake.state, real_cost)
    sell_rows = [o for o in fake.orders if o["side"] == "sell"]
    expected_level = level_of(real_cost, new_step) + 1
    check("the sell target is computed from the real cost under the CURRENT spacing",
          len(sell_rows) == 1 and sell_rows[0]["level"] == expected_level,
          (sell_rows, expected_level))


async def t_maintain_window_max_open_buys_cap():
    bot, fake = make_bot(base_state(levels_down=5, order_size_lit=1.70, usdc_balance=500.0, max_open_buys=2))
    await bot.maintain_window(fake.state, 3.10)
    buys = [o for o in fake.orders if o["side"] == "buy"]
    check("max_open_buys is a hard, code-enforced cap on new buy placement",
          len(buys) == 2, (len(buys), fake.orders))


# ── Spacing change detection (in tick) ──────────────────────────────────────────────────────────

async def t_tick_cancels_everything_on_a_spacing_change():
    resting = {"id": 1, "level": 900, "side": "buy", "status": "open", "client_order_index": 1,
               "exchange_order_id": 77, "limit_price": 3.10, "size": 1.70}
    bot, fake = make_bot(base_state(spacing_pct=0.25, internal_spacing_pct=0.125,
                                     order_size_lit=1.70, usdc_balance=500.0), orders=[resting])
    bot.fetch_current_price = lambda: _async_return(3.10)
    await bot.tick()
    check("a spacing change triggers a cancel of every resting order",
          fake.orders[0]["status"] == "cancelled", fake.orders[0])
    check("internal_spacing_pct is updated to the new value",
          fake.state["internal_spacing_pct"] == 0.25, fake.state)
    check("order_size_lit is cleared for recompute under the new spacing",
          fake.state["order_size_lit"] is None, fake.state)


async def t_tick_skips_new_decisions_when_reconciliation_fails():
    pending = {"id": 1, "level": 900, "side": "buy", "client_order_index": 555,
               "status": "pending", "limit_price": 3.10, "size": 1.70}
    bot, fake = make_bot(base_state(usdc_balance=500.0), orders=[pending], order_api_fail=True)
    bot.fetch_current_price = lambda: _async_return(3.10)
    await bot.tick()
    check("no new buys are placed when reconciliation itself failed this tick",
          not any(o["side"] == "buy" and o["id"] != 1 for o in fake.orders), fake.orders)


# ── Flatten ──────────────────────────────────────────────────────────────────────────────────────

async def t_flatten_cancels_resting_orders_and_market_sells_holdings():
    resting = {"id": 1, "level": 902, "side": "buy", "status": "open", "client_order_index": 1,
               "exchange_order_id": 55, "limit_price": 3.00, "size": 1.70}
    held = {"id": 2, "level": 900, "side": "buy", "status": "filled",
            "filled_qty": 1.70, "filled_price": 3.10}
    bot, fake = make_bot(base_state(), orders=[resting, held], assets=[FakeAsset("LIT", 0.0, 0.0)])
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: 3.10
    await bot.flatten_all()
    check("every resting order is cancelled on the (fake) exchange", 55 in bot.client.cancelled, bot.client.cancelled)
    check("a real market sell order is placed for the full held quantity",
          len(bot.client.placed) == 1 and bot.client.placed[0]["base_amount"] == core.size_to_int(1.70),
          bot.client.placed)
    check("the bot ends disabled after a VERIFIED-flat flatten", fake.state["enabled"] is False, fake.state)
    check("flatten_requested is cleared only once verified", fake.state["flatten_requested"] is False, fake.state)


async def t_flatten_does_not_report_completion_if_the_market_sell_failed():
    # External audit finding: market_sell_all's return value was ignored entirely -- a stale
    # book returning None still let flatten_all report success.
    held = {"id": 1, "level": 900, "side": "buy", "status": "filled",
            "filled_qty": 1.70, "filled_price": 3.10}
    bot, fake = make_bot(base_state(flatten_requested=True), orders=[held],
                          assets=[FakeAsset("LIT", 1.70, 0.0)])
    bot.live.best_mid = lambda max_age=core.BOOK_MAX_AGE: None  # stale book -- market_sell_all can't act
    await bot.flatten_all()
    check("flatten_requested stays true when the sell never actually happened",
          fake.state["flatten_requested"] is True, fake.state)
    check("the bot is NOT disabled while real exposure remains", fake.state.get("enabled") is not False
          or fake.state.get("enabled") is None, fake.state)
    check("flatten_incomplete is logged, not flatten_completed",
          any(r["action"] == "flatten_incomplete" for r in fake.runs)
          and not any(r["action"] == "flatten_completed" for r in fake.runs), fake.runs)


async def t_flatten_does_not_report_completion_if_a_cancel_failed():
    resting = {"id": 1, "level": 902, "side": "buy", "status": "open", "client_order_index": 1,
               "exchange_order_id": 55, "limit_price": 3.00, "size": 1.70}
    bot, fake = make_bot(base_state(flatten_requested=True), orders=[resting],
                          cancel_err="cancel rejected", assets=[FakeAsset("LIT", 0.0, 0.0)])
    await bot.flatten_all()
    check("a failed cancel leaves the order row NOT marked cancelled",
          fake.orders[0]["status"] != "cancelled", fake.orders[0])
    check("flatten does not report completion when a cancel failed",
          not any(r["action"] == "flatten_completed" for r in fake.runs), fake.runs)


async def t_cancel_order_row_checks_the_sdk_error():
    # External audit finding: cancel_order's returned (tx, resp, err) tuple was never checked --
    # only an exception would have been noticed, not an explicit error in a clean response.
    row = {"id": 1, "exchange_order_id": 55}
    bot, fake = make_bot(base_state(), cancel_err="cancel rejected")
    ok = await bot.cancel_order_row(row)
    check("a cancel the exchange explicitly rejects returns False", ok is False, ok)
    check("the row is NOT marked cancelled when the exchange rejected it",
          len(fake.orders) == 0 or fake.orders[0].get("status") != "cancelled", fake.orders)


# ── Lock heartbeat touched during a busy tick ───────────────────────────────────────────────────

async def t_lock_heartbeat_touched_after_each_order_placement():
    # External audit finding: a tick placing several real orders (each up to ORDER_TIMEOUT=12s)
    # could run past LOCK_STALE_AFTER=30s with a stale heartbeat, since the heartbeat only used
    # to refresh once per outer loop iteration.
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


# ── Rate-limit backoff (unchanged behavior, still covered) ─────────────────────────────────────

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


async def _async_return(value):
    return value


async def main():
    t_precision_and_minimum_enforcement()
    t_order_fill_amounts_uses_real_human_decimal_units()
    t_order_is_terminal_uses_remaining_amount_primarily()
    for t in (t_place_grid_order_writes_ledger_before_sending,
              t_place_grid_order_rejected_by_exchange,
              t_place_grid_order_unknown_outcome_stays_pending,
              t_reconcile_detects_a_fill_the_bot_never_saw_happen,
              t_reconcile_leaves_truly_unknown_orders_pending,
              t_reconcile_reports_failure_and_does_not_mark_rows,
              t_reconcile_partial_fill_stays_open_for_further_reconciliation,
              t_reconcile_cancelled_with_partial_fill_preserves_the_real_quantity,
              t_current_holdings_respects_tied_pairing,
              t_current_holdings_repeat_cycle_at_the_same_level_is_not_erased,
              t_current_holdings_aggregates_multiple_open_buys_at_one_level,
              t_balance_divergence_pauses_new_orders,
              t_balance_matches_allows_new_orders,
              t_balance_check_fails_closed_on_the_very_first_call,
              t_maintain_window_places_buys_in_the_active_down_window,
              t_maintain_window_places_sells_for_held_levels,
              t_maintain_window_never_submits_buy_and_sell_at_the_same_level_in_one_tick,
              t_maintain_window_respects_real_usdc_balance_as_a_spending_cap,
              t_maintain_window_recomputes_order_size_when_missing,
              t_maintain_window_cancels_buys_that_drifted_out_of_window,
              t_maintain_window_entries_blocked_still_maintains_existing_sells,
              t_maintain_window_sell_target_uses_real_cost_under_current_spacing,
              t_maintain_window_max_open_buys_cap,
              t_tick_cancels_everything_on_a_spacing_change,
              t_tick_skips_new_decisions_when_reconciliation_fails,
              t_flatten_cancels_resting_orders_and_market_sells_holdings,
              t_flatten_does_not_report_completion_if_the_market_sell_failed,
              t_flatten_does_not_report_completion_if_a_cancel_failed,
              t_cancel_order_row_checks_the_sdk_error,
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
