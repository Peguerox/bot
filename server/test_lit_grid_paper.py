"""Offline tests for lit_grid_paper. No network, no real money -- same plain-script convention
as test_core.py (python3 test_lit_grid_paper.py), Supabase I/O faked in-memory."""
import asyncio, math, os, sys
from datetime import datetime, timezone

os.environ.setdefault("NEXT_PUBLIC_SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")
sys.path.insert(0, "/Users/julio/trading-bot/server")

import lit_grid_paper as core
from lit_grid_paper import (
    LitGridPaper, level_of, candle_path, compute_order_size_lit, levels_for_drawdown, run_lit_grid_paper,
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
        self.raise_on_next_tick = False

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
    bot._last_candle_t = None
    bot._last_level = None
    fake = FakeDb(state)
    bot.sb = fake.sb
    return bot, fake


def candle(t, o, h, l, c, v):
    return {"t": t, "o": o, "h": h, "l": l, "c": c, "v": v}


def base_state(**over):
    # drawdown_pct chosen so levels_for_drawdown(spacing, drawdown_pct) == 15, matching the
    # order-size magnitudes every other test in this file was calibrated against before the
    # drawdown_pct/levels split -- see t_levels_for_drawdown_matches_known_values for the
    # function's own correctness check at realistic depths (e.g. 30% -> 286 levels).
    spacing_pct, drawdown_pct, capital_usd = 0.125, 1.858682, 10000
    # order_size_lit defaults to what arm_grid would have computed for this capital/spacing/
    # drawdown at p0=10.0 (the price every direct process_candle test in this file uses) --
    # process_candle now REUSES this stored value when compounding is off (fixed at arm time,
    # not recomputed every candle), so a test calling process_candle directly (skipping
    # arm_grid) needs a realistic starting value here, not None/0.
    default_order_size = compute_order_size_lit(capital_usd, 10.0, spacing_pct,
                                                  levels_for_drawdown(spacing_pct, drawdown_pct))
    st = {
        "spacing_pct": spacing_pct, "levels_up": 15, "levels_down": 15, "drawdown_pct": drawdown_pct,
        "capital_usd": capital_usd, "usdc_balance": capital_usd, "lit_balance": 0, "bot_profit_usd": 0,
        "compounding_enabled": False, "order_type": "limit",
        "order_size_lit": default_order_size, "live_price": None, "live_level": None,
        "open_positions_json": {"holdings": {}}, "enabled": True,
    }
    st.update(over)
    return st


def t_level_math_matches_validated_logic():
    step = math.log(1 + 0.125 / 100)
    # same geometric formula validated in research/grid-bot-2026-10-17/grid_paired_cycle_sim.mjs
    check("level_of is the geometric log floor (full-step boundary, not a round() midpoint)",
          level_of(3.1151, step) == math.floor(math.log(3.1151) / step))
    # candle_path: green candle (c>=o) -> open, low, high, close
    green = candle(0, 1.0, 1.05, 0.98, 1.03, 100)
    check("candle_path green order", candle_path(green) == [1.0, 0.98, 1.05, 1.03])
    red = candle(0, 1.0, 1.05, 0.98, 0.97, 100)
    check("candle_path red order", candle_path(red) == [1.0, 1.05, 0.98, 0.97])


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
    bot, fake = make_bot(base_state(order_type="market"))  # market: no participation cap, simpler to assert on
    state = fake.state
    start_usdc = state["usdc_balance"]
    # Down several levels, then UP PAST the original starting price -- not just back to it. A
    # pure retrace (down one level then back to exactly where it started) nets zero by design
    # after the 2026-10-18 phantom-profit fix (Opus audit): both directions now price a fill at
    # the SAME shared level boundary, so undoing the last step you just took is correctly a wash,
    # not free profit. Genuine profit only shows once price moves past where it already was.
    c1 = candle(1000, 10.0, 10.0, 9.9, 9.9, 1000)
    c2 = candle(2000, 9.9, 10.1, 9.9, 10.1, 1000)
    await bot.process_candle(c1, state)
    state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    check("a buy fill spends real USDC", state["usdc_balance"] < start_usdc, state["usdc_balance"])
    check("a buy fill credits real LIT", state["lit_balance"] > 0, state["lit_balance"])
    await bot.process_candle(c2, state)
    state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    check("a drop then a bigger recovery produces at least one completed pair", len(fake.trades) >= 1, fake.trades)
    check("no individual pair is ever negative (every pair is exactly one level, always a win or a wash)",
          all(t["pnl_usd"] >= -1e-9 for t in fake.trades), fake.trades)
    check("net profit across the whole round trip is positive", state["bot_profit_usd"] > 0, state["bot_profit_usd"])
    check("the matching sells return lit_balance back to zero", abs(state["lit_balance"]) < 1e-9, state["lit_balance"])
    check("usdc_balance ends above where it started (net profit, back in cash)",
          state["usdc_balance"] > start_usdc, (start_usdc, state["usdc_balance"]))


async def t_initial_seed_is_proportional_to_levels_up():
    # Confirmed directly against Bitsgap's own docs (2026-10-18): the up-front split is NOT a
    # blind 50/50 -- it's proportional to the configured window. 3 up / 15 down should buy much
    # less LIT than 15 up / 15 down, for the same capital.
    bot_narrow, fake_narrow = make_bot(base_state(order_type="market", levels_up=3, usdc_balance=10000, lit_balance=0))
    bot_wide, fake_wide = make_bot(base_state(order_type="market", levels_up=15, usdc_balance=10000, lit_balance=0))
    c = candle(1000, 10.0, 10.0, 10.0, 10.0, 1000)
    for bot, fake in ((bot_narrow, fake_narrow), (bot_wide, fake_wide)):
        bot.fetch_latest_candles = lambda count=5, c=c: _async_return([c])
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
    # re-arms a buy back at the original level. So pure back-and-forth chop between two
    # adjacent lines profits on EVERY touch, not just once, and not zero (an earlier attempt to
    # make a round trip net zero was wrong and was reverted).
    bot, fake = make_bot(base_state(order_type="market", usdc_balance=10000, lit_balance=0))
    step = math.log(1 + 0.125 / 100)
    p_hi = 10.0
    p_lo = p_hi * math.exp(-1 * step)  # exactly one level down
    t = 1000
    for _ in range(2):  # each iteration is one full down-then-up round trip between the two lines
        c = candle(t, p_hi, p_hi, p_lo, p_lo, 1000)
        await bot.process_candle(c, fake.state)
        t += 1000
        c = candle(t, p_lo, p_hi, p_lo, p_hi, 1000)
        await bot.process_candle(c, fake.state)
        t += 1000
    check("chopping between two adjacent lines twice produces two profitable trades, not zero or one",
          len(fake.trades) == 2, fake.trades)
    check("each chop trade profits (buy low, sell high, same two prices every time)",
          all(t["pnl_usd"] > 0 for t in fake.trades), fake.trades)


async def t_sell_skipped_without_inventory_no_naked_short():
    # Direct correction (2026-10-18, after a Bitsgap screenshot comparison): this is a Long spot
    # grid. A sell event with no LIT actually held must not execute at all -- no free virtual
    # shorts. lvl should still advance past it (there's genuinely no resting order there, unlike
    # running out of USDC which defers).
    bot, fake = make_bot(base_state(order_type="market", lit_balance=0))
    state = fake.state
    # price rises with nothing bought yet -- every "sell" event here should just be skipped
    c = candle(1000, 10.0, 10.1, 10.0, 10.1, 1000)
    await bot.process_candle(c, state)
    check("no trade is logged when there is no LIT to sell", len(fake.trades) == 0, fake.trades)
    state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    check("usdc_balance is untouched (no phantom proceeds)", state["usdc_balance"] == 10000, state["usdc_balance"])
    check("lit_balance stays at zero (no phantom short position)", state["lit_balance"] == 0, state["lit_balance"])


async def t_buy_blocked_when_usdc_runs_out():
    # The original bug this whole rework fixes: order size was recomputed from the FULL capital
    # every tick regardless of how much had already been spent, so the sim could spend far more
    # than the configured investment. Now every buy fill must be affordable from real usdc_balance.
    tiny_usdc = 50.0  # enough for roughly one fill at this price/order-size, not a big multi-level drop
    bot, fake = make_bot(base_state(order_type="market", usdc_balance=tiny_usdc))
    state = fake.state
    c = candle(1000, 10.0, 10.0, 9.0, 9.0, 1_000_000)  # a 10-level drop, big enough to exhaust $50 fast
    await bot.process_candle(c, state)
    state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    check("usdc_balance never goes negative", state["usdc_balance"] >= 0, state["usdc_balance"])
    check("the bot's level tracker stopped short of the full drop (deferred, not spent beyond capital)",
          bot._last_level > level_of(9.0, math.log(1 + 0.125 / 100)), bot._last_level)


async def t_limit_fills_respect_participation_cap():
    bot, fake = make_bot(base_state(order_type="limit"))
    state = fake.state
    # huge price move but tiny real volume -- the 25% participation cap should block most fills
    c = candle(1000, 10.0, 10.0, 5.0, 5.0, 1.0)  # volume=1 LIT, order size will be much larger than 0.25 LIT
    await bot.process_candle(c, state)
    # order_size_lit for $10,000 capital over 15 down-levels at 0.125% spacing is large relative to 1 LIT volume
    check("participation cap blocks fills when volume is tiny relative to order size", len(fake.trades) == 0, fake.trades)


async def t_compounding_recomputes_order_size_from_real_total_value():
    # Compounding now reads directly off real balances (usdc_balance + lit_balance*live_price)
    # instead of a separate abstract running total -- so order size should grow as the real
    # account value grows from realized profit, and stay flat (capital_usd) when compounding is off.
    bot_c, fake_c = make_bot(base_state(order_type="market", compounding_enabled=True))
    bot_f, fake_f = make_bot(base_state(order_type="market", compounding_enabled=False))
    c1 = candle(1000, 10.0, 10.0, 9.9, 9.9, 1000)
    c2 = candle(2000, 9.9, 10.0, 9.9, 10.0, 1000)
    for bot, fake in ((bot_c, fake_c), (bot_f, fake_f)):
        await bot.process_candle(c1, fake.state)
        state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
        await bot.process_candle(c2, state)

    order_size_compounding = fake_c.state["order_size_lit"]
    order_size_flat = fake_f.state["order_size_lit"]
    check("compounding grows order size after a profitable pair vs. the flat-capital baseline",
          order_size_compounding > order_size_flat, (order_size_compounding, order_size_flat))


async def t_compounding_never_resizes_an_already_resting_position():
    # Direct correction (2026-10-18): "the old orders that you already have created, they can't
    # compound... it's better to just compound with the new orders." An already-filled holding
    # must keep whatever qty it was bought with forever -- only a BRAND NEW fill, placed after
    # profit has grown the account, should ever use a bigger (compounded) size.
    bot, fake = make_bot(base_state(order_type="market", compounding_enabled=True))
    step = math.log(1 + 0.125 / 100)
    p0 = 10.0
    c1 = candle(1000, p0, p0, p0 * math.exp(-1 * step), p0 * math.exp(-1 * step), 1000)
    await bot.process_candle(c1, fake.state)
    s1 = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    first_qty = list(s1["open_positions_json"]["holdings"].values())[0]

    c2 = candle(2000, p0 * math.exp(-1 * step), p0, p0 * math.exp(-1 * step), p0, 1000)
    await bot.process_candle(c2, s1)  # sells the first holding for a small profit
    s2 = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    check("the sold holding is gone (not lingering to be resized later)",
          len(s2["open_positions_json"]["holdings"]) == 0, s2["open_positions_json"]["holdings"])

    c3 = candle(3000, p0, p0, p0 * math.exp(-1 * step), p0 * math.exp(-1 * step), 1000)
    await bot.process_candle(c3, s2)  # a brand new buy, placed after profit accrued
    s3 = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    second_qty = list(s3["open_positions_json"]["holdings"].values())[0]
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
    # Regression test for the real Opus-audit finding (2026-10-18): round() made the crossing
    # threshold a MIDPOINT half a spacing step away, while the fill price recorded a full step's
    # move -- so price noise far smaller than the configured spacing could flip the detected
    # level and book a "profitable" round trip that never happened. Reproduced: 10 candles
    # wobbling in a 0.025% range (a tenth of the 0.125% spacing) booked $1.38 of fake profit.
    # floor() fixes it: noise that never reaches a real grid line can't move the level at all.
    bot, fake = make_bot(base_state(order_type="market"))
    step = math.log(1 + 0.125 / 100)
    L = 1000
    mid_price = math.exp((L + 0.5) * step)  # the old round()-midpoint, well within one real level
    t = 1000
    for _ in range(10):
        hi = mid_price * 1.00001
        lo = mid_price * 0.99999
        c = candle(t, mid_price, hi, lo, mid_price, 1000)
        await bot.process_candle(c, fake.state)
        t += 1000
    check("sub-spacing noise around an old round()-midpoint never produces a single trade",
          len(fake.trades) == 0, fake.trades)
    state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    check("bot_profit_usd stays exactly zero (no phantom profit from pure noise)",
          state["bot_profit_usd"] == 0, state["bot_profit_usd"])


async def t_participation_cap_never_produces_a_nonadjacent_pair():
    # Regression test for the real 2026-10-18 incident: a pair whose entry/exit were 6 levels
    # apart (0.75%) and negative, when every completed pair in this design must be exactly one
    # adjacent level apart (and therefore always profitable). Root cause was letting `lvl` jump
    # to match the real close price even when the volume cap only allowed a few fills.
    bot, fake = make_bot(base_state(order_type="limit", spacing_pct=0.125))
    step = math.log(1 + 0.125 / 100)

    # Candle 1: big uncapped drop opens several buys (high volume -> cap is generous).
    p0 = 10.0
    low1 = p0 * math.exp(-5 * step)
    c1 = candle(1000, p0, p0, low1, low1, 1_000_000)
    await bot.process_candle(c1, fake.state)
    state_after_1 = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    level_after_1 = bot._last_level

    # Candle 2: price WANTS to rise back up 5 levels, but volume is tiny -- the participation
    # cap should allow at most ~1 fill (order size at $10,000/15-down-levels is large relative
    # to 1 LIT of real volume).
    high2 = p0 * math.exp(2 * step)
    c2 = candle(2000, low1, high2, low1, high2, 350.0)  # enough real volume for ~1 fill, not all 5
    await bot.process_candle(c2, state_after_1)

    check("lvl does not jump ahead of the fills the volume cap actually allowed",
          bot._last_level < level_after_1 + 5, (level_after_1, bot._last_level))
    check("the capped candle actually produced at least one real pair to check", len(fake.trades) >= 1, fake.trades)
    if fake.trades:
        for t in fake.trades:
            ratio = t["exit_price"] / t["entry_price"]
            levels_apart = abs(math.log(ratio) / step)
            check(f"trade id={len(fake.trades)} entry/exit are exactly one level apart",
                  abs(levels_apart - 1) < 0.01, levels_apart)
            check(f"trade id={len(fake.trades)} is profitable (adjacent-level pairs always are)",
                  t["pnl_usd"] > 0, t["pnl_usd"])


async def t_restart_resumes_from_persisted_level_not_a_fresh_rearm():
    # Regression test (Opus audit finding #4): a restart used to reset _last_level from scratch
    # while open_positions_json (the actual stack) survived in the DB -- reintroducing the
    # non-adjacent-pair bug through a different path than the one already fixed in-process.
    bot1, fake = make_bot(base_state(order_type="market"))
    c1 = candle(1000, 10.0, 10.0, 9.9, 9.9, 1000)
    bot1.fetch_latest_candles = lambda count=5: _async_return([c1])
    await bot1.tick()  # cold start: arms fresh (no persisted level yet), logs grid_armed
    state_after_arm = (await bot1.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    check("arming persists internal_last_level", state_after_arm["internal_last_level"] is not None,
          state_after_arm.get("internal_last_level"))
    runs_before = len(fake.runs)

    # Simulate a restart: a brand-new bot instance, same underlying DB state.
    bot2 = LitGridPaper.__new__(LitGridPaper)
    bot2._lock_id, bot2._lock_held, bot2._lock_checked_at, bot2._lock_blocked_logged = "t2", True, 0.0, False
    bot2._last_candle_t, bot2._last_level = None, None
    bot2.sb = fake.sb
    c2 = candle(2000, 9.9, 9.9, 9.8, 9.8, 1000)
    bot2.fetch_latest_candles = lambda count=5: _async_return([c1, c2])
    await bot2.tick()
    check("restart resumes the persisted level instead of re-arming from scratch",
          bot2._last_level == state_after_arm["internal_last_level"], bot2._last_level)
    check("restart does not log another grid_armed event", len(fake.runs) == runs_before, fake.runs)


async def t_spacing_change_triggers_rearm():
    # Regression test (Opus audit finding #5): changing spacing_pct mid-run used to reinterpret
    # the old level INDEX under the new spacing, discovering a huge fake multi-level jump in one
    # candle. Reproduced live: a 0.125% -> 0.25% change spent $7,538 at a wrong price in one tick.
    bot, fake = make_bot(base_state(order_type="market", spacing_pct=0.125))
    c1 = candle(1000, 10.0, 10.0, 9.9, 9.9, 1000)
    bot.fetch_latest_candles = lambda count=5: _async_return([c1])
    await bot.tick()
    runs_before = len(fake.runs)

    fake.state["spacing_pct"] = 0.25  # changed mid-run, same as the dashboard settings route allows
    c2 = candle(2000, 9.9, 9.9, 9.8, 9.8, 1000)
    bot.fetch_latest_candles = lambda count=5: _async_return([c1, c2])
    await bot.tick()
    check("a spacing change re-arms instead of walking the old level under the new spacing",
          any(r["action"] == "grid_rearmed_spacing_changed" for r in fake.runs[runs_before:]), fake.runs)
    check("no fills happen on the re-arming tick itself (it only resets the reference point)",
          len(fake.trades) == 0, fake.trades)


async def t_disabling_resets_in_memory_tracking():
    # Regression test (Opus audit finding #6): toggling off then back on used to replay the
    # whole OFF period as a backlog next tick, through a different path than the original
    # cold-start backlog bug.
    bot, fake = make_bot(base_state(order_type="market", enabled=True))
    c1 = candle(1000, 10.0, 10.0, 9.9, 9.9, 1000)
    bot.fetch_latest_candles = lambda count=5: _async_return([c1])
    await bot.tick()
    check("level tracking is set after an active tick", bot._last_level is not None, bot._last_level)

    fake.state["enabled"] = False
    await bot.tick()
    check("disabling resets _last_candle_t", bot._last_candle_t is None, bot._last_candle_t)
    check("disabling resets _last_level", bot._last_level is None, bot._last_level)


async def t_cold_start_does_not_replay_backlog():
    # Regression test for the real 2026-10-18 incident: Lighter's candles API does not honor
    # count_back (confirmed live: asked for 5, got 500, spanning ~8 hours back). The first tick
    # after enabling must not process that whole backlog as if it just happened.
    bot, fake = make_bot(base_state(order_type="market"))
    backlog = [
        candle(1000, 10.0, 10.0, 9.0, 9.0, 1000),   # big historical move -- would open several buys
        candle(2000, 9.0, 10.0, 9.0, 10.0, 1000),   # and this would close them for a big "instant" profit
        candle(3000, 10.0, 10.1, 10.0, 10.1, 1000),
    ]
    bot.fetch_latest_candles = lambda count=5: _async_return(backlog)
    await bot.tick()
    check("cold start logs zero trades even though the backlog has real moves", len(fake.trades) == 0, fake.trades)
    check("cold start bootstraps _last_candle_t to the latest candle, not the first",
          bot._last_candle_t == backlog[-1]["t"], bot._last_candle_t)

    # Regression: the panel kept showing stale live_price/live_level after enabling (found live
    # 2026-10-18, "turned it on and nothing happened") because cold start only logged to runs
    # and never wrote the armed grid to the state row.
    armed_state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    check("cold start writes live_price to the state row immediately",
          armed_state["live_price"] == backlog[-1]["c"], armed_state["live_price"])
    check("cold start writes live_level to the state row immediately",
          armed_state["live_level"] is not None, armed_state["live_level"])
    check("cold start computes and writes an initial order_size_lit",
          armed_state["order_size_lit"] is not None and armed_state["order_size_lit"] > 0,
          armed_state.get("order_size_lit"))

    # Next tick: only a genuinely new candle after the bootstrap point should be processed.
    new_candle = candle(4000, 10.1, 10.1, 10.0, 10.0, 1000)
    bot.fetch_latest_candles = lambda count=5: _async_return(backlog + [new_candle])
    await bot.tick()
    check("the tick after cold start only processes candles newer than the bootstrap point",
          bot._last_candle_t == new_candle["t"], bot._last_candle_t)


async def _async_return(value):
    return value


async def main():
    t_level_math_matches_validated_logic()
    t_levels_for_drawdown_matches_known_values()
    t_order_size_scales_with_capital()
    for t in (t_paired_cycle_buy_then_sell,
              t_initial_seed_is_proportional_to_levels_up,
              t_repeated_chop_profits_on_every_touch,
              t_sell_skipped_without_inventory_no_naked_short,
              t_buy_blocked_when_usdc_runs_out,
              t_limit_fills_respect_participation_cap,
              t_compounding_recomputes_order_size_from_real_total_value,
              t_compounding_never_resizes_an_already_resting_position,
              t_sub_spacing_noise_never_trades,
              t_restart_resumes_from_persisted_level_not_a_fresh_rearm,
              t_spacing_change_triggers_rearm,
              t_disabling_resets_in_memory_tracking,
              t_cold_start_does_not_replay_backlog,
              t_participation_cap_never_produces_a_nonadjacent_pair,
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
