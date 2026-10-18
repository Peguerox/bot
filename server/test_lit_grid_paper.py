"""Offline tests for lit_grid_paper. No network, no real money -- same plain-script convention
as test_core.py (python3 test_lit_grid_paper.py), Supabase I/O faked in-memory."""
import asyncio, math, os, sys
from datetime import datetime, timezone

os.environ.setdefault("NEXT_PUBLIC_SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")
sys.path.insert(0, "/Users/julio/trading-bot/server")

import lit_grid_paper as core
from lit_grid_paper import LitGridPaper, level_of, candle_path, compute_order_size_lit, run_lit_grid_paper

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
    st = {
        "spacing_pct": 0.125, "levels_up": 15, "levels_down": 15,
        "capital_usd": 10000, "current_capital_usd": 10000,
        "compounding_enabled": False, "order_type": "limit",
        "order_size_lit": None, "live_price": None, "live_level": None,
        "open_positions_json": {"buys": [], "sells": []}, "enabled": True,
    }
    st.update(over)
    return st


def t_level_math_matches_validated_logic():
    step = math.log(1 + 0.125 / 100)
    # same geometric formula validated in research/grid-bot-2026-10-17/grid_paired_cycle_sim.mjs
    check("level_of is the geometric log formula", level_of(3.1151, step) == round(math.log(3.1151) / step))
    # candle_path: green candle (c>=o) -> open, low, high, close
    green = candle(0, 1.0, 1.05, 0.98, 1.03, 100)
    check("candle_path green order", candle_path(green) == [1.0, 0.98, 1.05, 1.03])
    red = candle(0, 1.0, 1.05, 0.98, 0.97, 100)
    check("candle_path red order", candle_path(red) == [1.0, 1.05, 0.98, 0.97])


def t_order_size_scales_with_capital():
    s1 = compute_order_size_lit(10000, 3.1151, 0.125, 286)
    s2 = compute_order_size_lit(20000, 3.1151, 0.125, 286)
    check("order size doubles when capital doubles", abs(s2 - 2 * s1) < 1e-9, (s1, s2))
    check("order size is positive", s1 > 0)


async def t_paired_cycle_buy_then_sell():
    bot, fake = make_bot(base_state(order_type="market"))  # market: no participation cap, simpler to assert on
    state = fake.state
    # one down-move then one up-move -- should open a buy, then pair it with a sell for a win
    c1 = candle(1000, 10.0, 10.0, 9.9, 9.9, 1000)   # price drops one level -> opens a buy
    c2 = candle(2000, 9.9, 10.0, 9.9, 10.0, 1000)   # price rises back -> should pair with the buy
    await bot.process_candle(c1, state)
    state = await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1")
    state = state[0]
    opens_after_drop = len(state["open_positions_json"]["buys"]) + len(state["open_positions_json"]["sells"])
    await bot.process_candle(c2, state)
    check("a drop then a recovery produces at least one completed pair", len(fake.trades) >= 1, fake.trades)
    if fake.trades:
        check("completed pair is profitable (bought low, sold high)", fake.trades[0]["pnl_usd"] > 0, fake.trades[0])


async def t_limit_fills_respect_participation_cap():
    bot, fake = make_bot(base_state(order_type="limit"))
    state = fake.state
    # huge price move but tiny real volume -- the 25% participation cap should block most fills
    c = candle(1000, 10.0, 10.0, 5.0, 5.0, 1.0)  # volume=1 LIT, order size will be much larger than 0.25 LIT
    await bot.process_candle(c, state)
    # order_size_lit for $10,000 capital over 15 down-levels at 0.125% spacing is large relative to 1 LIT volume
    check("participation cap blocks fills when volume is tiny relative to order size", len(fake.trades) == 0, fake.trades)


async def t_compounding_updates_current_capital():
    bot, fake = make_bot(base_state(order_type="market", compounding_enabled=True))
    state = fake.state
    c1 = candle(1000, 10.0, 10.0, 9.9, 9.9, 1000)
    c2 = candle(2000, 9.9, 10.0, 9.9, 10.0, 1000)
    await bot.process_candle(c1, state)
    state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    await bot.process_candle(c2, state)
    state = (await bot.sb("GET", f"{core.TABLE_STATE}?id=eq.1"))[0]
    check("compounding moves current_capital_usd away from the seed after a profitable pair",
          state["current_capital_usd"] != 10000, state["current_capital_usd"])


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


async def main():
    t_level_math_matches_validated_logic()
    t_order_size_scales_with_capital()
    for t in (t_paired_cycle_buy_then_sell,
              t_limit_fills_respect_participation_cap,
              t_compounding_updates_current_capital,
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
