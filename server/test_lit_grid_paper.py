"""Offline tests for lit_grid_paper. No network, no real money -- same plain-script convention
as test_core.py (python3 test_lit_grid_paper.py), Supabase I/O faked in-memory."""
import asyncio, math, os, sys
from datetime import datetime, timezone

os.environ.setdefault("NEXT_PUBLIC_SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")
sys.path.insert(0, "/Users/julio/trading-bot/server")

import lit_grid_paper as core
from lit_grid_paper import (
    LitGridPaper, level_of, compute_order_size_lit, levels_for_drawdown, run_lit_grid_paper,
)

PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{('  -> ' + str(extra)) if extra and not cond else ''}")


class FakeDb:
    """In-memory stand-in for the real Supabase REST calls."""
    def __init__(self, state):
        self.state = dict(state)
        self.trades = []
        self.runs = []

    async def sb(self, method, path, body=None):
        if path.startswith(core.TABLE_STATE):
            if method == "GET":
                return [dict(self.state)]
            if method == "PATCH":
                self.state.update(body)
                return [dict(self.state)]
        if path.startswith(core.TABLE_TRADES) and method == "POST":
            self.trades.append(body)
            return [body]
        if path.startswith(core.TABLE_RUNS) and method == "POST":
            self.runs.append(body)
            return [body]
        raise RuntimeError(f"unexpected call {method} {path}")


def make_bot(state):
    bot = LitGridPaper.__new__(LitGridPaper)
    bot._lock_id = "test"
    bot._lock_held = True
    bot._lock_checked_at = 0.0
    bot._lock_blocked_logged = False
    bot._last_level = None
    fake = FakeDb(state)
    bot.sb = fake.sb
    return bot, fake


async def _async_return(value):
    return value


def base_state(**over):
    # drawdown_pct chosen so levels_for_drawdown(spacing, drawdown_pct) == 15, matching the
    # order-size magnitudes every other test in this file was calibrated against before the
    # drawdown_pct/levels split -- see t_levels_for_drawdown_matches_known_values for the
    # function's own correctness check at realistic depths (e.g. 30% -> 286 levels).
    spacing_pct, drawdown_pct, capital_usd = 0.125, 1.858682, 10000
    # order_size_lit defaults to what arm_grid would have computed for this capital/spacing/
    # drawdown at p0=10.0 (the price every direct process_price test in this file uses) --
    # process_price REUSES this stored value when compounding is off (fixed at arm time, not
    # recomputed every tick), so a test calling process_price directly (skipping arm_grid) needs
    # a realistic starting value here, not None/0.
    default_order_size = compute_order_size_lit(capital_usd, 10.0, spacing_pct,
                                                  levels_for_drawdown(spacing_pct, drawdown_pct))
    st = {
        "spacing_pct": spacing_pct, "levels_up": 15, "levels_down": 15, "drawdown_pct": drawdown_pct,
        "capital_usd": capital_usd, "usdc_balance": capital_usd, "lit_balance": 0, "bot_profit_usd": 0,
        "compounding_enabled": False, "order_type": "limit",
        "order_size_lit": default_order_size, "live_price": None, "live_level": None,
        "open_positions_json": {"holdings": {}}, "enabled": True,
        "internal_last_level": None, "internal_spacing_pct": None,
    }
    st.update(over)
    return st


def t_level_math_matches_validated_logic():
    step = math.log(1 + 0.125 / 100)
    check("level_of is the geometric log floor (full-step boundary, not a round() midpoint)",
          level_of(3.1151, step) == math.floor(math.log(3.1151) / step))


def t_levels_for_drawdown_matches_known_values():
    # Same numbers manually validated earlier this session (0.125% spacing): -30% needs 286
    # levels, -10% needs 85 levels -- confirms drawdown_pct sizes the same way the chat math did.
    check("30% drawdown -> 286 levels at 0.125% spacing", levels_for_drawdown(0.125, 30) == 286,
          levels_for_drawdown(0.125, 30))
    check("10% drawdown -> 85 levels at 0.125% spacing", levels_for_drawdown(0.125, 10) == 85,
          levels_for_drawdown(0.125, 10))
    check("a bigger drawdown needs more levels", levels_for_drawdown(0.125, 50) > levels_for_drawdown(0.125, 30))


def t_order_size_scales_with_capital():
    s1 = compute_order_size_lit(10000, 3.1151, 0.125, 286)
    s2 = compute_order_size_lit(20000, 3.1151, 0.125, 286)
    check("order size doubles when capital doubles", abs(s2 - 2 * s1) < 1e-9, (s1, s2))
    check("order size is positive", s1 > 0)


async def t_paired_cycle_buy_then_sell():
    bot, fake = make_bot(base_state(order_type="market"))
    state = fake.state
    start_usdc = state["usdc_balance"]
    step = math.log(1 + 0.125 / 100)
    p0 = 10.0
    # First call just establishes a baseline (nothing to compare the very first price against).
    await bot.process_price(p0, state)
    state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    # Down several levels, then UP PAST the original starting price -- not just back to it. A
    # pure retrace (down one level then back to exactly where it started) nets zero by design:
    # both directions price a fill at the SAME shared level boundary, so undoing the last step
    # you just took is correctly a wash, not free profit. Genuine profit only shows once price
    # moves past where it already was.
    await bot.process_price(p0 * math.exp(-1 * step), state)
    state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    check("a buy fill spends real USDC", state["usdc_balance"] < start_usdc, state["usdc_balance"])
    check("a buy fill credits real LIT", state["lit_balance"] > 0, state["lit_balance"])
    await bot.process_price(p0 * math.exp(1 * step), state)
    state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    sells = [t for t in fake.trades if t["side"] == "sell"]
    buys = [t for t in fake.trades if t["side"] == "buy"]
    check("a drop then a bigger recovery produces at least one completed sell", len(sells) >= 1, fake.trades)
    check("every buy fill is logged with its own row too, not just the closing sell",
          len(buys) >= 1, fake.trades)
    check("no individual sell is ever negative (every pair is exactly one level, always a win or a wash)",
          all(t["pnl_usd"] >= -1e-9 for t in sells), sells)
    check("net profit across the whole round trip is positive", state["bot_profit_usd"] > 0, state["bot_profit_usd"])
    check("the matching sells return lit_balance back to zero", abs(state["lit_balance"]) < 1e-9, state["lit_balance"])
    check("usdc_balance ends above where it started (net profit, back in cash)",
          state["usdc_balance"] > start_usdc, (start_usdc, state["usdc_balance"]))


async def t_seeded_positions_carry_the_real_arm_price_as_cost():
    # Direct correction (2026-10-18, user asked "why is Total PNL negative"): the up-front seed
    # is ONE real market buy at the arm price, distributed across several future sell targets --
    # not several buys at each target's own (higher) price. Every seeded holding must carry the
    # SAME real cost (the arm price), not its own level's price.
    bot, fake = make_bot(base_state(order_type="market", levels_up=5, usdc_balance=10000, lit_balance=0))
    bot.fetch_current_price = lambda: _async_return(10.0)
    await bot.tick()
    state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    holdings = state["open_positions_json"]["holdings"]
    check("5 holdings seeded", len(holdings) == 5, holdings)
    costs = {entry["cost"] for entry in holdings.values()}
    check("every seeded holding shares the exact same real cost (the arm price), not its own level's price",
          len(costs) == 1 and abs(next(iter(costs)) - 10.0) < 1e-9, costs)


async def t_initial_seed_is_proportional_to_levels_up():
    # Confirmed directly against Bitsgap's own docs (2026-10-18): the up-front split is NOT a
    # blind 50/50 -- it's proportional to the configured window. 3 up / 15 down should buy much
    # less LIT than 15 up / 15 down, for the same capital.
    bot_narrow, fake_narrow = make_bot(base_state(order_type="market", levels_up=3, usdc_balance=10000, lit_balance=0))
    bot_wide, fake_wide = make_bot(base_state(order_type="market", levels_up=15, usdc_balance=10000, lit_balance=0))
    for bot in (bot_narrow, bot_wide):
        bot.fetch_current_price = lambda: _async_return(10.0)
        await bot.tick()
    narrow_state = (await bot_narrow.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    wide_state = (await bot_wide.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    check("3 up seeds much less LIT than 15 up, same capital",
          narrow_state["lit_balance"] < wide_state["lit_balance"] / 3,
          (narrow_state["lit_balance"], wide_state["lit_balance"]))
    check("3 up keeps much more USDC in reserve than 15 up",
          narrow_state["usdc_balance"] > wide_state["usdc_balance"],
          (narrow_state["usdc_balance"], wide_state["usdc_balance"]))
    check("3 separate holdings entries seeded (one per level), not one lump sum",
          len(narrow_state["open_positions_json"]["holdings"]) == 3,
          narrow_state["open_positions_json"]["holdings"])


async def t_repeated_chop_profits_on_every_touch():
    # The actual point of a grid bot, confirmed against Bitsgap's docs (2026-10-18): a filled
    # buy immediately arms a specific sell one level above; when THAT fills, it immediately
    # re-arms a buy back at the original level. So pure back-and-forth chop between two adjacent
    # lines profits on EVERY touch, not just once, and not zero.
    bot, fake = make_bot(base_state(order_type="market", usdc_balance=10000, lit_balance=0))
    step = math.log(1 + 0.125 / 100)
    p_hi = 10.0
    p_lo = p_hi * math.exp(-1 * step)  # exactly one level down
    await bot.process_price(p_hi, fake.state)  # establish baseline
    for _ in range(2):  # each iteration is one full down-then-up round trip between the two lines
        await bot.process_price(p_lo, fake.state)
        await bot.process_price(p_hi, fake.state)
    sells = [t for t in fake.trades if t["side"] == "sell"]
    buys = [t for t in fake.trades if t["side"] == "buy"]
    check("chopping between two adjacent lines twice produces two buy fills and two sell fills, not zero or one",
          len(buys) == 2 and len(sells) == 2, fake.trades)
    check("each chop sell profits (buy low, sell high, same two prices every time)",
          all(t["pnl_usd"] > 0 for t in sells), sells)
    check("each chop buy is logged with zero pnl (nothing realized until the matching sell)",
          all(t["pnl_usd"] == 0 for t in buys), buys)


async def t_sell_skipped_without_inventory_no_naked_short():
    # Direct correction (2026-10-18, after a Bitsgap screenshot comparison): this is a Long spot
    # grid. A sell event with no LIT actually held must not execute at all -- no free virtual
    # shorts. lvl still advances past it (there's genuinely no resting order there, unlike
    # running out of USDC which defers).
    bot, fake = make_bot(base_state(order_type="market", lit_balance=0))
    state = fake.state
    step = math.log(1 + 0.125 / 100)
    # price rises with nothing bought yet -- every "sell" event here should just be skipped
    await bot.process_price(10.0 * math.exp(1 * step), state)
    check("no trade is logged when there is no LIT to sell", len(fake.trades) == 0, fake.trades)
    state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    check("usdc_balance is untouched (no phantom proceeds)", state["usdc_balance"] == 10000, state["usdc_balance"])
    check("lit_balance stays at zero (no phantom short position)", state["lit_balance"] == 0, state["lit_balance"])


async def t_buy_blocked_when_usdc_runs_out():
    # Every buy fill must be affordable from real usdc_balance -- order size is never re-derived
    # from the full original capital once some has already been spent.
    tiny_usdc = 50.0  # enough for roughly one fill at this price/order-size, not a big multi-level drop
    bot, fake = make_bot(base_state(order_type="market", usdc_balance=tiny_usdc))
    state = fake.state
    step = math.log(1 + 0.125 / 100)
    await bot.process_price(10.0, state)  # establish baseline
    state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    await bot.process_price(9.0, state)  # a 10-level drop, big enough to exhaust $50 fast
    state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    check("usdc_balance never goes negative", state["usdc_balance"] >= 0, state["usdc_balance"])
    check("the bot's level tracker stopped short of the full drop (deferred, not spent beyond capital)",
          bot._last_level > level_of(9.0, step), bot._last_level)


async def t_compounding_recomputes_order_size_from_realized_profit():
    # Direct correction (2026-10-18): "you can get less money with compounding. It is
    # impossible." Compounding must grow order size from REALIZED profit only (capital_usd +
    # bot_profit_usd), not total real account value (usdc_balance + lit_balance*price) -- that
    # basis can shrink purely from unrealized mark-to-market loss on held inventory during a
    # down-trend, which could make compounding size SMALLER than flat and produce less realized
    # profit than flat across a backtest -- the exact thing just reported as "impossible", and
    # confirmed as a real bug (reproduced in research/grid-bot-2026-10-17/backtest_real_mechanic.py).
    bot_c, fake_c = make_bot(base_state(order_type="market", compounding_enabled=True))
    bot_f, fake_f = make_bot(base_state(order_type="market", compounding_enabled=False))
    step = math.log(1 + 0.125 / 100)
    p0 = 10.0
    for bot, fake in ((bot_c, fake_c), (bot_f, fake_f)):
        await bot.process_price(p0, fake.state)  # establish baseline
        state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
        await bot.process_price(p0 * math.exp(-1 * step), state)
        state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
        await bot.process_price(p0, state)  # realizes a profit (order_size for THIS call is still pre-profit)
        state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
        await bot.process_price(p0, state)  # a no-op tick AFTER the profit, to observe the new order_size

    order_size_compounding = fake_c.state["order_size_lit"]
    order_size_flat = fake_f.state["order_size_lit"]
    check("compounding grows order size after a profitable pair vs. the flat-capital baseline",
          order_size_compounding > order_size_flat, (order_size_compounding, order_size_flat))


async def t_compounding_never_underperforms_flat_during_unrealized_drawdown():
    # The exact scenario that produced the bug: price falls several levels (opening holdings
    # that are now underwater on paper), realized profit is still positive from completed
    # pairs, but total REAL account value (usdc_balance + lit_balance*price) is temporarily
    # below capital_usd purely from unrealized mark-to-market. Compounding's order size must
    # never shrink below the flat baseline in this situation.
    bot, fake = make_bot(base_state(order_type="market", compounding_enabled=True))
    step = math.log(1 + 0.125 / 100)
    p0 = 10.0
    flat_order_size = fake.state["order_size_lit"]
    await bot.process_price(p0, fake.state)  # baseline
    state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    # Fall 20 levels -- opens many holdings now underwater on paper (price kept falling past them)
    await bot.process_price(p0 * math.exp(-20 * step), state)
    state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    total_value = state["usdc_balance"] + state["lit_balance"] * state["live_price"]
    check("total real account value is genuinely below capital_usd here (unrealized drawdown)",
          total_value < state["capital_usd"], (total_value, state["capital_usd"]))
    check("order size never shrinks below the flat baseline despite the unrealized drawdown",
          state["order_size_lit"] >= flat_order_size - 1e-9, (state["order_size_lit"], flat_order_size))


async def t_compounding_never_resizes_an_already_resting_position():
    # Direct correction (2026-10-18): "the old orders that you already have created, they can't
    # compound... it's better to just compound with the new orders." An already-filled holding
    # must keep whatever qty it was bought with forever -- only a BRAND NEW fill, placed after
    # profit has grown the account, should ever use a bigger (compounded) size.
    bot, fake = make_bot(base_state(order_type="market", compounding_enabled=True))
    step = math.log(1 + 0.125 / 100)
    p0 = 10.0
    await bot.process_price(p0, fake.state)  # establish baseline
    s0 = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    await bot.process_price(p0 * math.exp(-1 * step), s0)
    s1 = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    first_qty = list(s1["open_positions_json"]["holdings"].values())[0]["qty"]

    await bot.process_price(p0, s1)  # sells the first holding for a small profit
    s2 = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    check("the sold holding is gone (not lingering to be resized later)",
          len(s2["open_positions_json"]["holdings"]) == 0, s2["open_positions_json"]["holdings"])

    await bot.process_price(p0 * math.exp(-1 * step), s2)  # a brand new buy, placed after profit accrued
    s3 = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    second_qty = list(s3["open_positions_json"]["holdings"].values())[0]["qty"]
    check("a brand new fill after profit accrued uses a bigger (compounded) size",
          second_qty > first_qty, (first_qty, second_qty))


async def t_tick_error_never_propagates():
    # Monkeypatch acquire_lock/tick to always raise, confirm run_lit_grid_paper's own loop
    # catches it rather than letting it escape (the isolation guarantee the whole embedding
    # decision depends on).
    class ExplodingBot:
        def __init__(self, *_):
            self.calls = 0
        async def log_run(self, *_a, **_k):
            pass
        async def acquire_lock(self):
            self.calls += 1
            raise RuntimeError("boom")
        async def tick(self):
            pass
        async def release_lock(self):
            pass

    orig_cls = core.LitGridPaper
    orig_tick_every = core.TICK_EVERY
    core.LitGridPaper = ExplodingBot
    core.TICK_EVERY = 0.02  # fast enough to observe several raised iterations in this test
    try:
        task = asyncio.create_task(run_lit_grid_paper())
        await asyncio.sleep(0.2)
        still_running = not task.done()
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
        check("an exception inside the tick loop does not escape run_lit_grid_paper",
              still_running, "task finished/crashed early" if not still_running else "")
    finally:
        core.LitGridPaper = orig_cls
        core.TICK_EVERY = orig_tick_every


async def t_sub_spacing_noise_never_trades():
    # round() used to make the crossing threshold a MIDPOINT half a spacing step away, while the
    # fill price recorded a full step's move -- so price noise far smaller than the configured
    # spacing could flip the detected level and book a "profitable" round trip that never
    # happened. floor() fixes it: noise that never reaches a real grid line can't move the level.
    bot, fake = make_bot(base_state(order_type="market"))
    step = math.log(1 + 0.125 / 100)
    L = 1000
    mid_price = math.exp((L + 0.5) * step)  # the old round()-midpoint, well within one real level
    for _ in range(10):
        await bot.process_price(mid_price * 1.00001, fake.state)
        await bot.process_price(mid_price * 0.99999, fake.state)
    check("sub-spacing noise around an old round()-midpoint never produces a single trade",
          len(fake.trades) == 0, fake.trades)
    state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    check("bot_profit_usd stays exactly zero (no phantom profit from pure noise)",
          state["bot_profit_usd"] == 0, state["bot_profit_usd"])


async def t_multi_level_move_fills_every_line_crossed():
    # A fast, big move between two ticks (now a real possibility with live polling instead of
    # candle-by-candle walks) must still fill every line it passed through, not just jump to the
    # endpoint and skip the levels in between.
    bot, fake = make_bot(base_state(order_type="market", usdc_balance=10000, lit_balance=0))
    step = math.log(1 + 0.125 / 100)
    p0 = 10.0
    await bot.process_price(p0, fake.state)
    state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    level_before = bot._last_level
    await bot.process_price(p0 * math.exp(-5 * step), state)  # jumps 5 levels down in one tick
    state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    check("a 5-level jump in one tick opens 5 separate holdings, not one",
          len(state["open_positions_json"]["holdings"]) == 5, state["open_positions_json"]["holdings"])
    check("the level tracker lands exactly 5 levels below where it started",
          bot._last_level == level_before - 5, (level_before, bot._last_level))


async def t_restart_resumes_from_persisted_level_not_a_fresh_rearm():
    # A restart must resume from the persisted level, not re-arm from scratch, while
    # open_positions_json (the actual holdings) survives in the DB -- otherwise the tracker and
    # the real position stack go out of sync.
    bot1, fake = make_bot(base_state(order_type="market"))
    bot1.fetch_current_price = lambda: _async_return(9.9)
    await bot1.tick()  # cold start: arms fresh (no persisted level yet), logs grid_armed
    state_after_arm = (await bot1.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    check("arming persists internal_last_level", state_after_arm["internal_last_level"] is not None,
          state_after_arm.get("internal_last_level"))
    runs_before = len(fake.runs)

    # Simulate a restart: a brand-new bot instance, same underlying DB state.
    bot2 = LitGridPaper.__new__(LitGridPaper)
    bot2._lock_id, bot2._lock_held, bot2._lock_checked_at, bot2._lock_blocked_logged = "t2", True, 0.0, False
    bot2._last_level = None
    bot2.sb = fake.sb
    bot2.fetch_current_price = lambda: _async_return(9.8)
    await bot2.tick()
    check("restart resumes the persisted level instead of re-arming from scratch",
          bot2._last_level == state_after_arm["internal_last_level"], bot2._last_level)
    check("restart does not log another grid_armed event", len(fake.runs) == runs_before, fake.runs)


async def t_spacing_change_triggers_rearm():
    # Changing spacing_pct mid-run must re-arm cleanly, not reinterpret the old level index
    # under the new spacing (which would discover a huge fake multi-level jump in one tick).
    bot, fake = make_bot(base_state(order_type="market", spacing_pct=0.125))
    bot.fetch_current_price = lambda: _async_return(9.9)
    await bot.tick()
    runs_before = len(fake.runs)

    fake.state["spacing_pct"] = 0.25  # changed mid-run, same as the dashboard settings route allows
    bot.fetch_current_price = lambda: _async_return(9.8)
    await bot.tick()
    check("a spacing change re-arms instead of walking the old level under the new spacing",
          any(r["action"] == "grid_rearmed_spacing_changed" for r in fake.runs[runs_before:]), fake.runs)
    check("no fills happen on the re-arming tick itself (it only resets the reference point)",
          len(fake.trades) == 0, fake.trades)


async def t_disabling_resets_in_memory_tracking():
    # Toggling off then back on must re-arm fresh at whatever price it finds, not try to jump
    # straight from the old level to the new one in a single leap.
    bot, fake = make_bot(base_state(order_type="market", enabled=True))
    bot.fetch_current_price = lambda: _async_return(9.9)
    await bot.tick()
    check("level tracking is set after an active tick", bot._last_level is not None, bot._last_level)

    fake.state["enabled"] = False
    await bot.tick()
    check("disabling resets _last_level", bot._last_level is None, bot._last_level)


async def t_cold_start_arms_without_error_and_writes_state():
    bot, fake = make_bot(base_state(order_type="market"))
    bot.fetch_current_price = lambda: _async_return(10.1)
    await bot.tick()
    check("cold start logs zero trades", len(fake.trades) == 0, fake.trades)
    armed_state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    check("cold start writes live_price to the state row immediately",
          armed_state["live_price"] == 10.1, armed_state["live_price"])
    check("cold start writes live_level to the state row immediately",
          armed_state["live_level"] is not None, armed_state["live_level"])
    check("cold start computes and writes an initial order_size_lit",
          armed_state["order_size_lit"] is not None and armed_state["order_size_lit"] > 0,
          armed_state.get("order_size_lit"))

    # Next tick: a genuinely new price should be processed normally (no special backlog concept
    # anymore -- each tick only ever sees the single latest live price).
    bot.fetch_current_price = lambda: _async_return(10.0)
    await bot.tick()
    state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    check("the tick after cold start processes the new price",
          state["live_price"] == 10.0, state["live_price"])


async def t_fetch_current_price_returns_none_on_empty_trades():
    bot, fake = make_bot(base_state(order_type="market"))
    bot.fetch_current_price = lambda: _async_return(None)
    await bot.tick()  # must not raise
    check("no trades logged when the price feed returns nothing", len(fake.trades) == 0, fake.trades)


async def main():
    t_level_math_matches_validated_logic()
    t_levels_for_drawdown_matches_known_values()
    t_order_size_scales_with_capital()
    for t in (t_paired_cycle_buy_then_sell,
              t_initial_seed_is_proportional_to_levels_up,
              t_seeded_positions_carry_the_real_arm_price_as_cost,
              t_repeated_chop_profits_on_every_touch,
              t_sell_skipped_without_inventory_no_naked_short,
              t_buy_blocked_when_usdc_runs_out,
              t_compounding_recomputes_order_size_from_realized_profit,
              t_compounding_never_underperforms_flat_during_unrealized_drawdown,
              t_compounding_never_resizes_an_already_resting_position,
              t_sub_spacing_noise_never_trades,
              t_multi_level_move_fills_every_line_crossed,
              t_restart_resumes_from_persisted_level_not_a_fresh_rearm,
              t_spacing_change_triggers_rearm,
              t_disabling_resets_in_memory_tracking,
              t_cold_start_arms_without_error_and_writes_state,
              t_fetch_current_price_returns_none_on_empty_trades,
              t_tick_error_never_propagates):
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
