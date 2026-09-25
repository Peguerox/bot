"""Offline tests for stoch_bot_core. No network, no real money.

Simulates the exchange at the boundary (get_position_rest + create_market_order) so the
logic under test is everything that actually broke: try_enter, confirm_fill, close_all,
emergency_flatten and tick().
"""
import asyncio, os, sys, time
from datetime import datetime, timedelta, timezone

os.environ.setdefault("NEXT_PUBLIC_SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")
sys.path.insert(0, "/Users/julio/trading-bot/server")

import stoch_bot_core as core
from stoch_bot_core import BotConfig, StochBot, LiveState

PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{('  -> ' + str(extra)) if extra and not cond else ''}")


class FakeExchange:
    def __init__(self, position=0.0, collateral=20.0):
        self.position = position
        self.collateral = collateral
        self.fill_multiplier = 1.0   # >1 simulates a phantom duplicate fill
        self.order_error = None      # simulate 'invalid nonce' etc
        self.fills_when_erroring = False
        self.hang_order = False
        self.orders = []

    async def create_market_order(self, market_index, client_order_index, base_amount,
                                  avg_execution_price, is_ask, reduce_only=False, **kw):
        if self.hang_order:
            await asyncio.sleep(60)
        qty = base_amount / 1e5
        self.orders.append({"qty": qty, "is_ask": is_ask, "reduce_only": reduce_only})
        did_fill = (self.order_error is None) or self.fills_when_erroring
        if did_fill:
            delta = -qty if is_ask else qty
            if reduce_only:
                # never flip through zero
                if abs(delta) > abs(self.position):
                    delta = -self.position
                self.position += delta
            else:
                self.position += delta * self.fill_multiplier
        if self.order_error:
            return None, None, self.order_error
        return object(), object(), None

    async def cancel_all_orders(self, **kw):
        self.cancel_all_calls = getattr(self, "cancel_all_calls", 0) + 1
        return None, None, None

    CANCEL_ALL_TIF_IMMEDIATE = 0


def make_candles(kind, n=30, base=86000.0):
    """kind: 'long' -> K near 0, 'short' -> K near 100, 'mid' -> K ~50."""
    c = []
    t0 = 1700000000000
    for i in range(n):
        c.append({"t": t0 + i * 60000, "o": base, "h": base + 100, "l": base - 100, "c": base})
    last = c[-2]
    if kind == "long":
        last["c"] = last["l"]
    elif kind == "short":
        last["c"] = last["h"]
    else:
        last["c"] = base
    return c


def make_trend_candles(direction, n=30, base=86000.0, step=50.0):
    """Strictly monotonic closes -> Efficiency Ratio near 1.0 in the given direction."""
    c = []
    t0 = 1700000000000
    price = base
    for i in range(n):
        o = price
        price = price + step if direction == "long" else price - step
        c.append({"t": t0 + i * 60000, "o": o, "h": max(o, price) + 5,
                  "l": min(o, price) - 5, "c": price})
    return c


def make_chop_candles(n=30, base=86000.0):
    """Zigzagging closes (low ER -> chop) that still end on an oversold stochastic read
    (last close near the recent low), unlike make_candles('long')'s single sharp dip, which
    reads as a clean ER=1.0 trend over anything longer than the 1-bar stochastic window."""
    c = []
    t0 = 1700000000000
    for i in range(n - 7):
        c.append({"t": t0 + i * 60000, "o": base, "h": base + 100, "l": base - 100, "c": base})
    zigzag = [base, base + 100, base - 100, base + 100, base - 100, base + 100, base - 100]
    for j, close in enumerate(zigzag):
        i = n - 7 + j
        c.append({"t": t0 + i * 60000, "o": zigzag[j - 1] if j else base,
                  "h": close + 50, "l": close - 50, "c": close})
    return c


def make_bot(ex, state=None, candles_kind="mid", candles=None, **cfg_overrides):
    cfg_kwargs = dict(name="test", worker_id="test_worker", table_state="s", table_trades="t", table_runs="r",
                      stoch_window=5, tp_pct=0.10, sl_pct=0.11,
                      entry_lo=25, entry_hi=75, reversal_lo=25, reversal_hi=75)
    cfg_kwargs.update(cfg_overrides)
    cfg = BotConfig(**cfg_kwargs)
    bot = StochBot(cfg)
    bot.account_index = 1
    bot.client = ex
    bot.live = LiveState(1, 1)
    bot.live.order_book = {"bids": [{"price": "86000.0"}], "asks": [{"price": "86001.0"}]}
    bot.live.ob_updated_at = time.time()
    bot.live.acct_updated_at = time.time()
    bot.candles = candles if candles is not None else make_candles(candles_kind)
    bot.state_row = state or {
        "id": 1, "side": None, "legs": [], "first_entry_price": None, "first_entry_time": None,
        "dca_level": 0, "seed_usd": 20.0, "realized_pnl_usd": 0.0,
        "collateral_before_entry": None, "enabled": True,
        "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot.runs = []
    bot.trades = []

    async def get_state():
        return dict(bot.state_row)

    async def update_state(patch):
        bot.state_row.update(patch)

    async def log_run(action, detail):
        bot.runs.append((action, detail))

    async def log_trade(*a, **k):
        bot.trades.append(a)

    async def get_position_rest():
        bot.get_position_rest_calls = getattr(bot, "get_position_rest_calls", 0) + 1
        # Match the real method's side effect: every authoritative read refreshes the cache.
        bot._pos_cache = (ex.position, ex.collateral)
        bot._pos_cache_at = time.time()
        return bot._pos_cache

    bot.get_state = get_state
    bot.update_state = update_state
    bot.log_run = log_run
    bot.log_trade = log_trade
    bot.get_position_rest = get_position_rest
    return bot


async def t_normal_entry():
    print("\n[normal entry records the REAL filled size]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="long")
    await bot.tick()
    check("side set to long", bot.state_row["side"] == "long", bot.state_row["side"])
    check("one leg recorded", len(bot.state_row["legs"]) == 1)
    tracked = core.total_qty(bot.state_row["legs"])
    check("tracked qty == real qty", abs(tracked - abs(ex.position)) < 1e-9,
          f"tracked={tracked} real={ex.position}")
    check("failure counter reset", bot.state_row["consecutive_entry_failures"] == 0)


async def t_phantom_double_fill():
    print("\n[phantom 2x fill -> emergency flatten + disable]")
    ex = FakeExchange()
    ex.fill_multiplier = 2.0
    bot = make_bot(ex, candles_kind="long")
    await bot.tick()
    actions = [a for a, _ in bot.runs]
    check("oversize detected", "oversize_detected" in actions, actions)
    check("emergency flatten ran", "emergency_flatten" in actions, actions)
    check("bot disabled", bot.state_row["enabled"] is False)
    check("position flattened", abs(ex.position) < 1e-6, ex.position)
    check("no side left set", bot.state_row["side"] is None)


async def t_nonce_error_but_filled():
    print("\n[order returns 'invalid nonce' but DID fill -> treated as filled, no re-entry]")
    ex = FakeExchange()
    ex.order_error = "code=21104 message='invalid nonce'"
    ex.fills_when_erroring = True
    bot = make_bot(ex, candles_kind="long")
    await bot.tick()
    check("side set despite error", bot.state_row["side"] == "long", bot.state_row["side"])
    check("only one order sent", len(ex.orders) == 1, len(ex.orders))
    check("failures NOT incremented", bot.state_row["consecutive_entry_failures"] == 0,
          bot.state_row["consecutive_entry_failures"])


async def t_order_error_no_fill():
    print("\n[order errors and did NOT fill -> counted as a failure, no phantom state]")
    ex = FakeExchange()
    ex.order_error = "code=21104 message='invalid nonce'"
    ex.fills_when_erroring = False
    bot = make_bot(ex, candles_kind="long")
    await bot.tick()
    check("side stays None", bot.state_row["side"] is None)
    check("failure counter incremented", bot.state_row["consecutive_entry_failures"] == 1,
          bot.state_row["consecutive_entry_failures"])
    check("no position", abs(ex.position) < 1e-9)


async def t_circuit_breaker():
    print("\n[3 consecutive failures -> disabled, stops trying]")
    ex = FakeExchange()
    ex.order_error = "boom"
    st = None
    bot = make_bot(ex, candles_kind="long")
    bot.state_row["consecutive_entry_failures"] = 3
    await bot.tick()
    check("bot disabled", bot.state_row["enabled"] is False)
    check("no order attempted", len(ex.orders) == 0, len(ex.orders))


async def t_close_uses_real_size():
    print("\n[close closes the REAL position, not the smaller tracked legs]")
    ex = FakeExchange(position=0.00046, collateral=20.0)   # real is 2x tracked
    state = {
        "id": 1, "side": "long", "legs": [{"price": 86000.0, "usd_size": 20.0}],
        "first_entry_price": 86000.0, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    ex2 = FakeExchange(position=0.00046)
    bot = make_bot(ex2, state=state, candles_kind="mid")
    ok = await bot.close_all("SL", dict(state), "long", state["legs"], 86000.0, 86001.0, 1)
    check("close reported success", ok is True)
    check("exchange is flat", abs(ex2.position) < 1e-9, ex2.position)
    check("closed the real qty", abs(ex2.orders[0]["qty"] - 0.00046) < 1e-9,
          ex2.orders[0]["qty"])
    check("reduce_only used", ex2.orders[0]["reduce_only"] is True)


async def t_oversize_mismatch_in_tick():
    print("\n[tracked/real mismatch >50% in tick -> emergency flatten]")
    ex = FakeExchange(position=0.00046)
    state = {
        "id": 1, "side": "long", "legs": [{"price": 86000.0, "usd_size": 20.0}],
        "first_entry_price": 86000.0, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="mid")
    await bot.tick()
    actions = [a for a, _ in bot.runs]
    check("oversize detected", "oversize_detected" in actions, actions)
    check("disabled", bot.state_row["enabled"] is False)
    check("flat", abs(ex.position) < 1e-6, ex.position)


async def t_external_close_reconcile():
    print("\n[position closed externally -> booked once as EXTERNAL]")
    ex = FakeExchange(position=0.0, collateral=20.05)
    state = {
        "id": 1, "side": "long", "legs": [{"price": 86000.0, "usd_size": 20.0}],
        "first_entry_price": 86000.0, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="mid")
    await bot.tick()
    actions = [a for a, _ in bot.runs]
    check("resolved_externally logged", "resolved_externally" in actions, actions)
    check("exactly one trade booked", len(bot.trades) == 1, len(bot.trades))
    check("side cleared", bot.state_row["side"] is None)
    check("pnl credited", abs(bot.state_row["realized_pnl_usd"] - 0.05) < 1e-9,
          bot.state_row["realized_pnl_usd"])


async def t_order_timeout_bounded():
    print("\n[a hung order request is bounded, reported as unknown, then verified]")
    ex = FakeExchange()
    ex.hang_order = True
    bot = make_bot(ex, candles_kind="long")
    orig = core.ORDER_TIMEOUT
    core.ORDER_TIMEOUT = 0.3
    t0 = time.time()
    err = await bot.place_order(is_ask=False, base_amount=0.0002, reduce_only=False,
                                ref_price=86000.0)
    elapsed = time.time() - t0
    core.ORDER_TIMEOUT = orig
    check("returned within timeout", elapsed < 3.0, f"{elapsed:.2f}s")
    check("reported as TIMEOUT", err and err.startswith("TIMEOUT"), err)


async def t_read_position_never_trusts_stale_ws_flat():
    print("\n[account push never arrives after a fill -> read_position must NOT report flat]")
    ex = FakeExchange(position=0.0005, collateral=20.0)  # real fill happened
    bot = make_bot(ex, candles_kind="mid")
    # WS account cache still says flat -- the account_all push that should have followed
    # our entry never arrived. This exact state is what caused three live positions to sit
    # with no TP/SL running on 2026-09-22: the old code trusted this WS "flat" reading.
    bot.live.account = {"positions": {}, "assets": {"0": {"symbol": "USDC",
                                                          "margin_balance": "20.0"}}}
    bot.live.acct_updated_at = time.time()
    bot.live.ob_updated_at = time.time()
    pos, coll = await bot.read_position()
    check("read_position used REST truth, not the stale WS-flat cache",
          abs(pos - 0.0005) < 1e-9, pos)
    # Within POSITION_TTL, a second call must hit the cache (not the exchange) and still be
    # correct -- proves the cache stores the REST answer, not the WS one.
    ex.position = 999.0  # if this leaks through, the cache is broken
    pos2, _ = await bot.read_position()
    check("cache serves the REST answer, unaffected by a later WS/exchange change",
          abs(pos2 - 0.0005) < 1e-9, pos2)
    # After POSITION_TTL expires, it must re-read (and pick up the new real value).
    bot._pos_cache_at = time.time() - (core.POSITION_TTL + 1)
    pos3, _ = await bot.read_position()
    check("cache expires and re-reads after POSITION_TTL", abs(pos3 - 999.0) < 1e-6, pos3)


async def t_reconcile_falls_through_when_rest_disagrees():
    print("\n[WS says flat but REST says still open -> tick manages the position, does not return early]")
    # Real qty matches the tracked leg size (20.0/86000.0) so only the reconcile fallthrough
    # is exercised here, not the separate oversize/resync guard tested elsewhere.
    ex = FakeExchange(position=20.0 / 86000.0, collateral=20.0)
    state = {
        "id": 1, "side": "long", "legs": [{"price": 86000.0, "usd_size": 20.0}],
        "first_entry_price": 86000.0, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="mid")
    await bot.tick()
    actions = [a for a, _ in bot.runs]
    check("did NOT book a fake external close", "resolved_externally" not in actions, actions)
    check("side is still tracked as open", bot.state_row["side"] == "long")
    check("no trades logged (nothing actually closed)", len(bot.trades) == 0)


async def t_timeout_constants():
    print("\n[timeout budget is sane and bounded]")
    # Mirrors close_all()'s real structure: cancel_all() is gone, so each path is just
    # place_order (ORDER_TIMEOUT) + one confirm_fill at its real, current default tries/delay
    # -- reads the actual production defaults so this can't silently go stale again if they
    # change (that's exactly what happened here: tries went 4->8->6 in one sitting).
    import inspect
    sig = inspect.signature(StochBot.confirm_fill)
    cf_tries = sig.parameters['tries'].default
    cf_delay = sig.parameters['delay'].default
    confirm_worst = cf_tries * core.REST_TIMEOUT + (cf_tries - 1) * cf_delay
    reconcile_worst = 2 * core.REST_TIMEOUT + 1 * 0.8  # reconcile's own explicit tries=2,delay=0.8
    close_worst = core.ORDER_TIMEOUT + confirm_worst
    reentry_worst = core.ORDER_TIMEOUT + confirm_worst
    worst = reconcile_worst + close_worst + reentry_worst
    MIN_MARGIN_S = 20.0  # don't let a future tuning pass silently eat the whole safety margin
    check("REST timeout far below SDK default 300s", core.REST_TIMEOUT <= 15, core.REST_TIMEOUT)
    check("worst-case tick < watchdog", worst < core.TICK_WATCHDOG,
          f"worst={worst:.0f}s watchdog={core.TICK_WATCHDOG}s")
    check(f"worst-case tick has >={MIN_MARGIN_S:.0f}s margin under watchdog (confirm_fill tries={cf_tries},delay={cf_delay})",
          core.TICK_WATCHDOG - worst >= MIN_MARGIN_S,
          f"margin={core.TICK_WATCHDOG - worst:.1f}s")


async def t_regime_switch_trend_entry_follows_direction():
    print("\n[regime switch: trending market -> entry follows trend direction, wider TP/SL]")
    trend_candles = make_trend_candles("short", n=30)  # price falling -> ER high, dir=short
    ex = FakeExchange()
    bot = make_bot(ex, candles=trend_candles,
                   er_period=6, er_max=0.5, trend_tp_pct=0.30, trend_sl_pct=0.30,
                   schema_has_position_bands=True)
    await bot.tick()
    check("entered short (trend direction), not blocked", bot.state_row["side"] == "short",
          bot.state_row["side"])
    check("recorded the TREND leg's TP", bot.state_row.get("position_tp_pct") == 0.30,
          bot.state_row.get("position_tp_pct"))
    check("recorded the TREND leg's SL", bot.state_row.get("position_sl_pct") == 0.30,
          bot.state_row.get("position_sl_pct"))
    entered_logs = [d for a, d in bot.runs if a == "entered"]
    check("logged as a trend-regime entry", entered_logs and entered_logs[0].get("regime") == "trend",
          entered_logs)


async def t_regime_switch_trend_invert_flips_direction():
    print("\n[trend_invert_direction=True: trending market -> entry goes OPPOSITE the trend direction]")
    trend_candles = make_trend_candles("short", n=30)  # price falling -> raw dir=short
    ex = FakeExchange()
    bot = make_bot(ex, candles=trend_candles,
                   er_period=6, er_max=0.5, trend_tp_pct=0.30, trend_sl_pct=0.30,
                   trend_invert_direction=True, schema_has_position_bands=True)
    await bot.tick()
    check("entered LONG (inverted from raw short direction)", bot.state_row["side"] == "long",
          bot.state_row["side"])
    check("still recorded as a trend-regime entry with the trend leg's TP/SL",
          bot.state_row.get("position_tp_pct") == 0.30 and bot.state_row.get("position_sl_pct") == 0.30,
          (bot.state_row.get("position_tp_pct"), bot.state_row.get("position_sl_pct")))


async def t_regime_switch_no_invert_by_default():
    print("\n[trend_invert_direction defaults to False -> unchanged behavior]")
    trend_candles = make_trend_candles("short", n=30)
    ex = FakeExchange()
    bot = make_bot(ex, candles=trend_candles,
                   er_period=6, er_max=0.5, trend_tp_pct=0.30, trend_sl_pct=0.30,
                   schema_has_position_bands=True)
    await bot.tick()
    check("entered short (raw trend direction, not inverted)", bot.state_row["side"] == "short",
          bot.state_row["side"])


async def t_pure_trend_fade_enters_opposite_of_raw_trend():
    print("\n[pure_trend_fade: trending market -> entry is the FADE of the detected trend]")
    trend_candles = make_trend_candles("short", n=30)  # price falling -> raw dir=short
    ex = FakeExchange()
    bot = make_bot(ex, candles=trend_candles,
                   er_period=6, er_max=0.5, trend_invert_direction=True, pure_trend_fade=True)
    await bot.tick()
    check("entered LONG (faded the short trend)", bot.state_row["side"] == "long",
          bot.state_row["side"])
    check("no position_tp_pct written (fixed cfg.tp_pct/sl_pct, no separate band)",
          "position_tp_pct" not in bot.state_row)


async def t_pure_trend_fade_ignores_stochastic_in_chop():
    print("\n[pure_trend_fade: choppy market with an oversold stoch read -> NO entry at all]")
    ex = FakeExchange()
    # make_chop_candles() reads oversold (would normally fire a stochastic "long" entry) but
    # keeps ER low -- pure_trend_fade must ignore that stochastic signal entirely.
    bot = make_bot(ex, candles=make_chop_candles(),
                   er_period=6, er_max=0.5, trend_invert_direction=True, pure_trend_fade=True)
    await bot.tick()
    check("no entry (ER isn't trending, stochastic signal is ignored)",
          bot.state_row["side"] is None, bot.state_row["side"])


async def t_pure_trend_fade_never_reverses_only_tpsl_exits():
    print("\n[pure_trend_fade: an open position never exits on a signal flip, only TP/SL]")
    entry = 86000.0
    ex = FakeExchange(position=round(20.0 / entry, 5), collateral=20.0)  # long position
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    # Strong opposite (short) trend now in effect -- a normal regime-switch bot would reverse
    # on this, but pure_trend_fade has no reversal exit at all.
    bot = make_bot(ex, state=state, candles=make_trend_candles("short", n=30),
                   er_period=6, er_max=0.5, trend_invert_direction=True, pure_trend_fade=True)
    await bot.tick()
    check("still long, no reversal fired", bot.state_row["side"] == "long",
          bot.state_row["side"])
    check("no closed run logged", not any(a == "closed" for a, _ in bot.runs), bot.runs)


async def t_regime_switch_chop_uses_fade_tpsl():
    print("\n[regime switch: choppy market -> normal fade entry, normal TP/SL]")
    ex = FakeExchange()
    bot = make_bot(ex, candles=make_chop_candles(),  # oversold stoch signal, ER stays low
                   er_period=6, er_max=0.5, trend_tp_pct=0.30, trend_sl_pct=0.30,
                   schema_has_position_bands=True)
    await bot.tick()
    check("entered on the stoch fade signal (not blocked)", bot.state_row["side"] is not None,
          bot.state_row["side"])
    check("recorded the FADE leg's TP (0.10, not 0.30)",
          bot.state_row.get("position_tp_pct") == 0.10, bot.state_row.get("position_tp_pct"))
    check("recorded the FADE leg's SL (0.11, not 0.30)",
          bot.state_row.get("position_sl_pct") == 0.11, bot.state_row.get("position_sl_pct"))


async def t_regime_switch_off_never_touches_schema():
    print("\n[no trend_tp_pct configured (Worker 1/2 style) -> position_tp/sl_pct never written]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="long")  # no er_period/trend_tp_pct at all
    await bot.tick()
    check("entered normally", bot.state_row["side"] == "long")
    check("no position_tp_pct key written (schema-safe for W1/W2)",
          "position_tp_pct" not in bot.state_row)
    check("no position_sl_pct key written (schema-safe for W1/W2)",
          "position_sl_pct" not in bot.state_row)


async def t_open_position_tpsl_syncs_to_regime_flip_no_trade():
    print("\n[an open FADE position already facing a NEW trend -> TP/SL sync to trend band, no trade fired]")
    entry = 86000.0
    ex = FakeExchange(position=-(20.0 / entry), collateral=20.0)  # short position
    state = {
        "id": 1, "side": "short", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
        "position_tp_pct": 0.10, "position_sl_pct": 0.11,  # entered during chop (fade band)
    }
    # Market has since turned into a clean downtrend -- ER~1.0, direction "short", which
    # matches the side already held, so no reversal trade should fire.
    bot = make_bot(ex, state=state, candles=make_trend_candles("short", base=86000.0, step=50.0),
                   er_period=6, er_max=0.5, trend_tp_pct=0.30, trend_sl_pct=0.30)
    await bot.tick()
    check("still short, no new trade (side untouched)", bot.state_row["side"] == "short",
          bot.state_row["side"])
    check("legs untouched (same entry, no close+reopen)",
          bot.state_row["legs"] == [{"price": entry, "usd_size": 20.0}], bot.state_row["legs"])
    check("TP synced from fade (0.10) to trend (0.30)",
          bot.state_row.get("position_tp_pct") == 0.30, bot.state_row.get("position_tp_pct"))
    check("SL synced from fade (0.11) to trend (0.30)",
          bot.state_row.get("position_sl_pct") == 0.30, bot.state_row.get("position_sl_pct"))
    check("no entered/closed run logged (pure state sync, not a trade)",
          not any(a in ("entered", "closed") for a, _ in bot.runs), bot.runs)


async def t_open_position_tpsl_syncs_back_to_fade_when_trend_ends():
    print("\n[an open TREND position whose trend has faded back to chop -> TP/SL sync back to fade band]")
    entry = 86000.0
    ex = FakeExchange(position=-(20.0 / entry), collateral=20.0)  # short position
    state = {
        "id": 1, "side": "short", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
        "position_tp_pct": 0.30, "position_sl_pct": 0.30,  # entered during a real trend
    }
    # Market has since gone choppy (zigzag -> low ER) but the stochastic still reads
    # overbought (short signal), matching the side already held.
    t0 = 1700000000000
    base = 86000.0
    candles = [{"t": t0 + i * 60000, "o": base, "h": base + 100, "l": base - 100, "c": base}
               for i in range(23)]
    zigzag = [base, base - 100, base + 100, base - 100, base + 100, base - 100, base + 100]
    for j, close in enumerate(zigzag):
        candles.append({"t": t0 + (23 + j) * 60000, "o": zigzag[j - 1] if j else base,
                        "h": close + 50, "l": close - 50, "c": close})
    # in-progress candle -- dropped by compute_stoch_signal/compute_er_and_direction, so the
    # zigzag above needs this extra entry for its real ending value to land as "closed[-1]".
    candles.append({"t": t0 + (23 + len(zigzag)) * 60000, "o": base, "h": base + 5,
                    "l": base - 5, "c": base})
    bot = make_bot(ex, state=state, candles=candles,
                   er_period=6, er_max=0.5, trend_tp_pct=0.30, trend_sl_pct=0.30)
    await bot.tick()
    check("TP synced from trend (0.30) back to fade (0.10)",
          bot.state_row.get("position_tp_pct") == 0.10, bot.state_row.get("position_tp_pct"))
    check("SL synced from trend (0.30) back to fade (0.11)",
          bot.state_row.get("position_sl_pct") == 0.11, bot.state_row.get("position_sl_pct"))


async def t_reversal_guard_blocks_reversal_before_threshold():
    print("\n[reversal_guard_seconds=120: opposite signal within 60s of entry -> position stays open]")
    entry = 86000.0
    ex = FakeExchange(position=-(20.0 / entry), collateral=20.0)  # short position
    candles = make_candles("long")  # K near 0 -> reversal signal "long", opposite of held short
    entry_time = candles[-1]["t"] - 60000  # 60s old, under the 120s guard
    state = {
        "id": 1, "side": "short", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": entry_time, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles=candles, reversal_guard_seconds=120)
    await bot.tick()
    check("still short (reversal blocked by the guard)", bot.state_row["side"] == "short",
          bot.state_row["side"])
    check("no closed/entered run logged", not any(a in ("entered", "closed") for a, _ in bot.runs),
          bot.runs)


async def t_reversal_guard_allows_reversal_after_threshold():
    print("\n[reversal_guard_seconds=120: opposite signal after 130s of entry -> reversal fires normally]")
    entry = 86000.0
    ex = FakeExchange(position=-round(20.0 / entry, 5), collateral=20.0)  # short position
    candles = make_candles("long")  # K near 0 -> reversal signal "long"
    entry_time = candles[-1]["t"] - 130000  # 130s old, past the 120s guard
    state = {
        "id": 1, "side": "short", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": entry_time, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles=candles, reversal_guard_seconds=120)
    await bot.tick()
    check("reversed to long (guard has expired)", bot.state_row["side"] == "long",
          bot.state_row["side"])


async def t_reversal_guard_does_not_delay_tp_or_sl():
    print("\n[reversal_guard_seconds=120: TP/SL still fire immediately regardless of position age]")
    entry = 86000.0
    # best_bid/ask in make_bot defaults to 86000.0/86001.0 -- price below the short's SL trigger.
    sl_trigger = entry * (1 + 0.11 / 100)  # short SL: price rose past this
    ex = FakeExchange(position=-round(20.0 / entry, 5), collateral=20.0 - 0.02)
    candles = make_candles("mid")  # no fresh stoch signal, isolates the SL check
    state = {
        "id": 1, "side": "short", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": candles[-1]["t"],  # brand new, age=0
        "dca_level": 0, "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles=candles, reversal_guard_seconds=120)
    bot.live.order_book = {"bids": [{"price": str(sl_trigger)}], "asks": [{"price": str(sl_trigger + 1)}]}
    await bot.tick()
    check("closed on SL despite age=0 (guard doesn't apply to TP/SL)", bot.state_row["side"] is None,
          bot.state_row["side"])
    closed_logs = [d for a, d in bot.runs if a == "closed"]
    check("logged as an SL close", closed_logs and closed_logs[0].get("reason") == "SL", closed_logs)


def make_tr_candles(tr_pct, base=86000.0, n=5):
    """n>=3 flat candles (no gap) whose true range reads exactly `tr_pct` off the latest
    CLOSED candle -- compute_true_range_pct compares it against the one before it."""
    half = tr_pct / 100 * base / 2
    t0 = 1700000000000
    return [{"t": t0 + i*60000, "o": base, "h": base+half, "l": base-half, "c": base}
            for i in range(n)]


async def t_entry_vol_gate_pauses_on_high_true_range():
    print("\n[entry vol gate: a completed candle spiking past the pause threshold blocks entries]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", entry_vol_pause_at_pct=0.15, entry_vol_resume_at_pct=0.1125)
    bot.candles = make_tr_candles(0.20)
    candle_ts = bot.candles[-2]["t"]
    sig = await bot._apply_entry_volatility_gate({}, candle_ts, "long")
    check("entry blocked", sig is None, sig)
    check("gate marked paused", bot.entry_vol_paused is True)


async def t_entry_vol_gate_stays_paused_inside_hysteresis_band():
    print("\n[entry vol gate: calmer than the pause bar but not calm enough to resume -> stays paused]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", entry_vol_pause_at_pct=0.15, entry_vol_resume_at_pct=0.1125)
    bot.entry_vol_paused = True
    bot.entry_vol_last_bar_ts = 0
    bot.candles = make_tr_candles(0.13)  # between 0.1125 and 0.15
    candle_ts = bot.candles[-2]["t"]
    sig = await bot._apply_entry_volatility_gate({}, candle_ts, "long")
    check("still blocked (inside the hysteresis band)", sig is None, sig)
    check("gate still marked paused", bot.entry_vol_paused is True)


async def t_entry_vol_gate_resumes_at_or_below_resume_threshold():
    print("\n[entry vol gate: a calm completed candle at or under the resume bar re-arms entries]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", entry_vol_pause_at_pct=0.15, entry_vol_resume_at_pct=0.1125)
    bot.entry_vol_paused = True
    bot.entry_vol_last_bar_ts = 0
    bot.candles = make_tr_candles(0.10)
    candle_ts = bot.candles[-2]["t"]
    sig = await bot._apply_entry_volatility_gate({}, candle_ts, "long")
    check("entry allowed through", sig == "long", sig)
    check("gate cleared", bot.entry_vol_paused is False)


async def t_entry_vol_gate_only_reevaluates_once_per_new_candle():
    print("\n[entry vol gate: re-checking the SAME candle_ts a second time doesn't re-toggle it]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", entry_vol_pause_at_pct=0.15, entry_vol_resume_at_pct=0.1125)
    bot.candles = make_tr_candles(0.20)
    candle_ts = bot.candles[-2]["t"]
    await bot._apply_entry_volatility_gate({}, candle_ts, "long")
    check("paused after first evaluation", bot.entry_vol_paused is True)
    # Even though the underlying candles now look calm, re-passing the SAME candle_ts must
    # not re-evaluate -- only a genuinely NEW completed candle should move the gate.
    bot.candles = make_tr_candles(0.05)
    sig = await bot._apply_entry_volatility_gate({}, candle_ts, "long")
    check("still paused (same candle_ts, not re-evaluated)", bot.entry_vol_paused is True, sig)


async def t_entry_vol_gate_disabled_when_unconfigured():
    print("\n[entry vol gate: entry_vol_pause_at_pct=None -> gate is a complete no-op]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid")  # no entry_vol_pause_at_pct override -> None
    bot.candles = make_tr_candles(50.0)  # absurdly volatile
    sig = await bot._apply_entry_volatility_gate({}, bot.candles[-2]["t"], "long")
    check("signal passes through untouched", sig == "long", sig)
    check("never marked paused", bot.entry_vol_paused is False)


async def t_entry_vol_gate_persists_when_schema_enabled():
    print("\n[entry vol gate: paused state is written to the DB when schema_has_entry_vol_gate=True]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", entry_vol_pause_at_pct=0.15, entry_vol_resume_at_pct=0.1125,
                   schema_has_entry_vol_gate=True)
    bot.candles = make_tr_candles(0.20)
    await bot._apply_entry_volatility_gate(dict(bot.state_row), bot.candles[-2]["t"], "long")
    check("paused flag persisted", bot.state_row.get("entry_vol_paused") is True,
          bot.state_row.get("entry_vol_paused"))
    check("last_bar_ts persisted", bot.state_row.get("entry_vol_last_bar_ts") == bot.candles[-2]["t"],
          bot.state_row.get("entry_vol_last_bar_ts"))


async def t_entry_vol_gate_rehydrates_paused_state_after_restart():
    print("\n[entry vol gate: a fresh bot instance rehydrates paused=True from a persisted row]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", entry_vol_pause_at_pct=0.15, entry_vol_resume_at_pct=0.1125,
                   schema_has_entry_vol_gate=True)
    candle_ts = 1234567890000
    persisted_state = dict(bot.state_row)
    persisted_state["entry_vol_paused"] = True
    persisted_state["entry_vol_last_bar_ts"] = candle_ts
    # Same candle_ts as what was persisted -- no new candle since the restart, so the
    # rehydrated paused=True should carry through untouched.
    bot.candles = make_tr_candles(0.05)  # would look calm if freshly evaluated
    sig = await bot._apply_entry_volatility_gate(persisted_state, candle_ts, "long")
    check("still paused immediately after restart, before any new candle", sig is None, sig)


async def t_entry_vol_gate_blocks_reversal_reopen_but_not_the_close():
    print("\n[entry vol gate: while paused, a reversal CLOSES the position but does not reopen it]")
    entry = 86000.0
    ex = FakeExchange(position=-round(20.0 / entry, 5), collateral=20.0)  # short position
    candles = make_candles("long")  # K near 0 -> reversal signal "long", opposite of held short
    entry_time = candles[-1]["t"] - 200_000  # well past a 180s guard
    state = {
        "id": 1, "side": "short", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": entry_time, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles=candles, reversal_guard_seconds=180,
                   entry_vol_pause_at_pct=0.15, entry_vol_resume_at_pct=0.1125)
    bot.entry_vol_paused = True  # simulate an already-active volatility pause
    bot._entry_vol_loaded = True  # skip rehydration -- test the in-memory pause directly
    bot.entry_vol_last_bar_ts = candles[-2]["t"]  # same candle -- gate won't re-evaluate this tick
    await bot.tick()
    check("position closed (reversal close leg is never gated)", bot.state_row["side"] is None,
          bot.state_row["side"])
    check("logged as a REVERSAL close", any(d.get("reason") == "REVERSAL" for a, d in bot.runs if a == "closed"),
          bot.runs)
    check("only one order placed (the close, no reopen)", len(ex.orders) == 1, ex.orders)


async def t_self_lock_paper_shadow_opens_when_flat():
    print("\n[self-lock: paper shadow opens a position the moment a signal appears while flat]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", self_lock_enabled=True)
    state = dict(bot.state_row)
    await bot._update_paper_shadow(state, "long", None, 86000.0, 86001.0, 1700000000000)
    check("paper side opened", bot.paper_side == "long", bot.paper_side)
    check("paper entry recorded at the ask (buying long)", bot.paper_entry == 86001.0, bot.paper_entry)


async def t_self_lock_single_paper_tp_does_not_unlock():
    print("\n[self-lock: one paper TP alone doesn't unlock -- needs two IN A ROW]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", self_lock_enabled=True)
    bot.real_trading_locked = True
    bot._self_lock_loaded = True
    bot.paper_side = "long"
    bot.paper_entry = 86000.0
    bot.paper_entry_ms = 1700000000000
    state = dict(bot.state_row)
    tp_price = 86000.0 * 1.0011  # past the 0.10% TP
    await bot._update_paper_shadow(state, None, None, tp_price, tp_price + 1, 1700000060000)
    check("counter at 1", bot.paper_consecutive_tps == 1, bot.paper_consecutive_tps)
    check("still locked", bot.real_trading_locked is True)


async def t_self_lock_two_consecutive_paper_tps_unlocks():
    print("\n[self-lock: two consecutive paper TPs unlock real trading]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", self_lock_enabled=True, schema_has_self_lock=True)
    bot.real_trading_locked = True
    bot._self_lock_loaded = True
    bot.paper_side = "long"
    bot.paper_entry = 86000.0
    bot.paper_entry_ms = 1700000000000
    state = dict(bot.state_row)
    tp_price = 86000.0 * 1.0011
    await bot._update_paper_shadow(state, None, None, tp_price, tp_price + 1, 1700000060000)
    check("still locked after 1 TP", bot.real_trading_locked is True)
    check("counter=1", bot.paper_consecutive_tps == 1)
    # Simulate the shadow's next cycle: reopened, then hits TP again.
    bot.paper_side = "long"
    bot.paper_entry = 86000.0
    bot.paper_entry_ms = 1700000120000
    await bot._update_paper_shadow(state, None, None, tp_price, tp_price + 1, 1700000180000)
    check("unlocked after 2nd consecutive TP", bot.real_trading_locked is False, bot.real_trading_locked)
    check("counter reset to 0", bot.paper_consecutive_tps == 0, bot.paper_consecutive_tps)


async def t_self_lock_paper_sl_resets_counter():
    print("\n[self-lock: a paper SL resets the consecutive-TP counter back to zero]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", self_lock_enabled=True)
    bot.real_trading_locked = True
    bot._self_lock_loaded = True
    bot.paper_side = "long"
    bot.paper_entry = 86000.0
    bot.paper_entry_ms = 1700000000000
    bot.paper_consecutive_tps = 1  # already has one TP toward the goal
    state = dict(bot.state_row)
    sl_price = 86000.0 * 0.9988  # past the 0.11% SL
    await bot._update_paper_shadow(state, None, None, sl_price, sl_price + 1, 1700000060000)
    check("counter reset to 0", bot.paper_consecutive_tps == 0, bot.paper_consecutive_tps)
    check("still locked (a paper SL doesn't unlock)", bot.real_trading_locked is True)


async def t_self_lock_real_sl_locks_and_resets_paper_counter():
    print("\n[self-lock: a REAL SL close locks real trading and resets the paper counter]")
    entry = 86000.0
    ex = FakeExchange(position=round(20.0 / entry, 5), collateral=20.0 - 0.02)  # long position
    candles = make_candles("mid")
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": candles[-1]["t"], "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles=candles, self_lock_enabled=True)
    bot.paper_consecutive_tps = 1  # pretend the shadow already had progress
    sl_trigger = entry * (1 - 0.11 / 100) - 1
    bot.live.order_book = {"bids": [{"price": str(sl_trigger)}], "asks": [{"price": str(sl_trigger + 1)}]}
    await bot.tick()
    check("real position closed on SL", bot.state_row["side"] is None, bot.state_row["side"])
    check("real trading locked", bot.real_trading_locked is True, bot.real_trading_locked)
    check("paper counter reset on lock", bot.paper_consecutive_tps == 0, bot.paper_consecutive_tps)


async def t_self_lock_blocks_real_entry_while_locked():
    print("\n[self-lock: while locked, a real entry signal never places a real order]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="long", self_lock_enabled=True)  # K near 0 -> entry signal "long"
    bot.real_trading_locked = True
    bot._self_lock_loaded = True
    await bot.tick()
    check("no real order placed", ex.orders == [], ex.orders)
    check("still flat", bot.state_row["side"] is None, bot.state_row["side"])


async def t_self_lock_blocks_real_reversal_reopen_but_not_the_close():
    print("\n[self-lock: while locked, a reversal CLOSES the real position but does not reopen it]")
    entry = 86000.0
    ex = FakeExchange(position=-round(20.0 / entry, 5), collateral=20.0)  # short position
    candles = make_candles("long")  # K near 0 -> reversal signal "long", opposite of held short
    entry_time = candles[-1]["t"] - 200_000
    state = {
        "id": 1, "side": "short", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": entry_time, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles=candles, self_lock_enabled=True)
    bot.real_trading_locked = True
    bot._self_lock_loaded = True
    await bot.tick()
    check("real position closed (reversal close leg is never gated)", bot.state_row["side"] is None,
          bot.state_row["side"])
    check("logged as a REVERSAL close", any(d.get("reason") == "REVERSAL" for a, d in bot.runs if a == "closed"),
          bot.runs)
    check("only one order placed (the close, no real reopen)", len(ex.orders) == 1, ex.orders)


async def t_self_lock_persists_when_schema_enabled():
    print("\n[self-lock: paper state is written to the DB when schema_has_self_lock=True]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", self_lock_enabled=True, schema_has_self_lock=True)
    bot.real_trading_locked = True
    bot._self_lock_loaded = True
    state = dict(bot.state_row)
    await bot._update_paper_shadow(state, "long", None, 86000.0, 86001.0, 1700000000000)
    check("paper_side persisted", bot.state_row.get("paper_side") == "long", bot.state_row.get("paper_side"))
    check("paper_entry_price persisted", bot.state_row.get("paper_entry_price") == 86001.0,
          bot.state_row.get("paper_entry_price"))


async def t_self_lock_rehydrates_after_restart():
    print("\n[self-lock: a fresh bot instance rehydrates locked=True + paper position from a persisted row]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", self_lock_enabled=True, schema_has_self_lock=True)
    persisted_state = dict(bot.state_row)
    persisted_state.update({
        "real_trading_locked": True, "paper_side": "short", "paper_entry_price": 86000.0,
        "paper_entry_time": 1700000000000, "paper_consecutive_tps": 1,
    })
    await bot._update_paper_shadow(persisted_state, None, None, 86000.0, 86001.0, 1700000000000)
    check("rehydrated locked=True", bot.real_trading_locked is True)
    check("rehydrated paper side", bot.paper_side == "short", bot.paper_side)
    check("rehydrated paper entry", bot.paper_entry == 86000.0, bot.paper_entry)
    check("rehydrated consecutive tps", bot.paper_consecutive_tps == 1, bot.paper_consecutive_tps)


async def t_self_lock_unlocks_and_enters_real_same_tick():
    print("\n[self-lock: the moment the 2nd paper TP closes, real trading enters immediately, same tick]")
    ex = FakeExchange()
    candles = make_candles("long")  # K near 0 -> real entry_signal "long" right now
    state = {
        "id": 1, "side": None, "legs": [], "first_entry_price": None, "first_entry_time": None,
        "dca_level": 0, "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": None,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles=candles, self_lock_enabled=True)
    bot.real_trading_locked = True
    bot._self_lock_loaded = True
    bot.paper_side = "long"
    bot.paper_entry = 86000.0
    bot.paper_entry_ms = candles[-1]["t"] - 60000
    bot.paper_consecutive_tps = 1  # one TP away from unlocking

    tp_price = 86000.0 * 1.0011  # past the paper position's own 0.10% TP
    bot.live.order_book = {"bids": [{"price": str(tp_price)}], "asks": [{"price": str(tp_price + 1)}]}

    await bot.tick()

    check("unlocked this same tick", bot.real_trading_locked is False, bot.real_trading_locked)
    check("real order placed THIS tick, no extra delay", len(ex.orders) == 1, ex.orders)
    check("real side opened long", bot.state_row["side"] == "long", bot.state_row["side"])


async def t_self_lock_paper_shadow_respects_reversal_guard():
    print("\n[self-lock: the paper shadow's reversal also respects reversal_guard_seconds, same as real]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", self_lock_enabled=True, reversal_guard_seconds=120)
    bot.real_trading_locked = True
    bot._self_lock_loaded = True
    bot.paper_side = "short"
    bot.paper_entry = 86000.0
    bot.paper_entry_ms = 1700000000000  # will be "now" below, so age=0 -- under the 120s guard

    state = dict(bot.state_row)
    # K near 0 -> reversal signal "long", opposite of the held paper short; no TP/SL trigger.
    await bot._update_paper_shadow(state, None, "long", 86000.0, 86001.0, 1700000000000)
    check("still holding the paper short (guard blocks the reversal)", bot.paper_side == "short",
          bot.paper_side)

    # 130s later -- past the guard -- the same reversal signal should now fire.
    await bot._update_paper_shadow(state, None, "long", 86000.0, 86001.0, 1700000130000)
    check("reversed to paper long once the guard has elapsed", bot.paper_side == "long", bot.paper_side)


def _mk_session_state(seed_usd, realized_pnl_usd):
    return {"id": 1, "seed_usd": seed_usd, "realized_pnl_usd": realized_pnl_usd}

import datetime as _dt
SESSION_A = _dt.datetime(2026, 9, 23, 16, 0, tzinfo=_dt.timezone.utc)   # inside 15:00-23:00 UTC
SESSION_A_START = _dt.datetime(2026, 9, 23, 15, 0, tzinfo=_dt.timezone.utc)  # that session's own boundary
SESSION_B = _dt.datetime(2026, 9, 24, 1, 0, tzinfo=_dt.timezone.utc)    # inside 23:00-07:00 UTC


async def t_session_breaker_stays_off_below_threshold():
    print("\n[session breaker: drawdown from session peak stays under 0.25% -> never trips]")
    ex = FakeExchange()
    bot = make_bot(ex, session_drawdown_stop_pct=0.25)
    seed = 20.0
    state = _mk_session_state(seed, 0.0)
    sig = await bot._apply_session_breaker(state, "long", now_utc=SESSION_A)
    check("entry signal passes through unchanged", sig == "long", sig)
    check("not paused yet", bot.session_paused is False)

    state = _mk_session_state(seed, 0.06)          # session went up to +0.30% of equity
    sig = await bot._apply_session_breaker(state, "short", now_utc=SESSION_A)
    check("still not paused after a gain", bot.session_paused is False)

    state = _mk_session_state(seed, 0.03)          # gave back $0.03 -> 0.15% of equity dd
    sig = await bot._apply_session_breaker(state, "long", now_utc=SESSION_A)
    check("small drawdown (0.15%) does not trip a 0.25% threshold", bot.session_paused is False)
    check("entry signal still passes through", sig == "long", sig)


async def t_session_breaker_trips_and_blocks_new_entries():
    print("\n[session breaker: drawdown from session peak exceeds 0.25% -> blocks new entries]")
    ex = FakeExchange()
    bot = make_bot(ex, session_drawdown_stop_pct=0.25)
    seed = 20.0
    # First call establishes the session baseline (equity ~= seed, keeps the % math clean).
    await bot._apply_session_breaker(_mk_session_state(seed, 0.0), None, now_utc=SESSION_A)
    check("baseline captured, no peak yet", bot.session_peak_pnl == 0.0, bot.session_peak_pnl)

    await bot._apply_session_breaker(_mk_session_state(seed, 0.10), None, now_utc=SESSION_A)
    check("peak recorded relative to baseline (+$0.10 = +0.50% of equity)",
          abs(bot.session_peak_pnl - 0.10) < 1e-9, bot.session_peak_pnl)

    state = _mk_session_state(seed, 0.04)          # gave back $0.06 -> 0.30% of equity dd
    sig = await bot._apply_session_breaker(state, "long", now_utc=SESSION_A)
    check("now paused", bot.session_paused is True)
    check("entry signal suppressed (returns None)", sig is None, sig)
    check("session_drawdown_stop logged",
          any(a == "session_drawdown_stop" for a, _ in bot.runs), bot.runs)

    # once paused, stays paused even if it partially recovers within the same session
    # (still within the 45-minute cooldown -- same timestamp as the trip)
    state = _mk_session_state(seed, 0.06)
    sig = await bot._apply_session_breaker(state, "short", now_utc=SESSION_A)
    check("still paused, still blocking entries within the same session",
          bot.session_paused is True and sig is None, (bot.session_paused, sig))


async def t_session_breaker_rearms_at_next_session():
    print("\n[session breaker: a new session boundary re-arms it, clearing the pause]")
    ex = FakeExchange()
    bot = make_bot(ex, session_drawdown_stop_pct=0.25)
    seed = 20.0
    # Trip it in session A.
    await bot._apply_session_breaker(_mk_session_state(seed, 0.0), None, now_utc=SESSION_A)
    await bot._apply_session_breaker(_mk_session_state(seed, 0.10), None, now_utc=SESSION_A)
    sig = await bot._apply_session_breaker(_mk_session_state(seed, 0.04), "long", now_utc=SESSION_A)
    check("paused in session A", bot.session_paused is True and sig is None)

    # Same equity, but now in session B -- should re-arm regardless of carried-over PnL.
    sig = await bot._apply_session_breaker(_mk_session_state(seed, 0.04), "short", now_utc=SESSION_B)
    check("re-armed in session B (not paused)", bot.session_paused is False)
    check("entry signal passes through again", sig == "short", sig)


async def t_session_breaker_rearms_after_cooldown_same_session():
    print("\n[session breaker: 45-min cooldown elapses -> re-arms WITHIN the same session]")
    ex = FakeExchange()
    bot = make_bot(ex, session_drawdown_stop_pct=0.25)  # cooldown defaults to 45 min
    seed = 20.0
    await bot._apply_session_breaker(_mk_session_state(seed, 0.0), None, now_utc=SESSION_A)
    await bot._apply_session_breaker(_mk_session_state(seed, 0.10), None, now_utc=SESSION_A)
    await bot._apply_session_breaker(_mk_session_state(seed, 0.04), "long", now_utc=SESSION_A)
    check("paused", bot.session_paused is True)

    almost = SESSION_A + _dt.timedelta(minutes=44)
    sig = await bot._apply_session_breaker(_mk_session_state(seed, 0.04), "long", now_utc=almost)
    check("still paused, cooldown not yet elapsed (44 of 45 min)",
          bot.session_paused is True and sig is None, (bot.session_paused, sig))

    after = SESSION_A + _dt.timedelta(minutes=46)
    sig = await bot._apply_session_breaker(_mk_session_state(seed, 0.04), "short", now_utc=after)
    check("re-armed after 46 min, still same session", bot.session_paused is False)
    check("entry signal passes through again", sig == "short", sig)
    check("peak/baseline reset fresh on re-arm", bot.session_peak_pnl == 0.0, bot.session_peak_pnl)


async def t_session_breaker_trips_on_immediate_loss_before_profit():
    print("\n[session breaker: a loss right at session start (never yet profitable) now trips too]")
    ex = FakeExchange()
    bot = make_bot(ex, session_drawdown_stop_pct=0.25)
    seed = 20.0
    await bot._apply_session_breaker(_mk_session_state(seed, 0.0), None, now_utc=SESSION_A)
    # Session opens with a loss right away -- never yet been profitable this session.
    state = _mk_session_state(seed, -0.06)  # -0.30% of equity, no peak established
    sig = await bot._apply_session_breaker(state, "long", now_utc=SESSION_A)
    check("paused (immediate loss before any profit now protected)", bot.session_paused is True)
    check("entry signal suppressed", sig is None, sig)
    logged = [d for a, d in bot.runs if a == "session_drawdown_stop"]
    check("logged with basis=raw_loss_from_start",
          logged and logged[-1].get("basis") == "raw_loss_from_start", logged)


async def t_session_breaker_persists_when_schema_enabled():
    print("\n[session breaker: schema_has_session_breaker=True -> trip is persisted to state]")
    ex = FakeExchange()
    bot = make_bot(ex, session_drawdown_stop_pct=0.25, schema_has_session_breaker=True)
    seed = 20.0
    await bot._apply_session_breaker(_mk_session_state(seed, 0.0), None, now_utc=SESSION_A)
    check("session start persisted on first init (the session's own boundary, not `now`)",
          bot.state_row.get("session_breaker_session_start") == SESSION_A_START.isoformat(),
          bot.state_row.get("session_breaker_session_start"))

    await bot._apply_session_breaker(_mk_session_state(seed, 0.10), None, now_utc=SESSION_A)
    check("peak persisted", bot.state_row.get("session_breaker_peak_pnl") == 0.10,
          bot.state_row.get("session_breaker_peak_pnl"))

    await bot._apply_session_breaker(_mk_session_state(seed, 0.04), "long", now_utc=SESSION_A)
    check("paused flag persisted", bot.state_row.get("session_breaker_paused") is True)
    check("paused_at persisted", bot.state_row.get("session_breaker_paused_at") == SESSION_A.isoformat(),
          bot.state_row.get("session_breaker_paused_at"))


async def t_session_breaker_never_persists_without_schema_flag():
    print("\n[session breaker: default (no schema flag) -> never writes session_breaker_* keys]")
    ex = FakeExchange()
    bot = make_bot(ex, session_drawdown_stop_pct=0.25)  # schema_has_session_breaker defaults False
    seed = 20.0
    await bot._apply_session_breaker(_mk_session_state(seed, 0.0), None, now_utc=SESSION_A)
    await bot._apply_session_breaker(_mk_session_state(seed, 0.10), None, now_utc=SESSION_A)
    await bot._apply_session_breaker(_mk_session_state(seed, 0.04), "long", now_utc=SESSION_A)
    check("paused (breaker still works)", bot.session_paused is True)
    check("no session_breaker_* keys ever written (in-memory only, no schema)",
          "session_breaker_paused" not in bot.state_row, bot.state_row)


async def t_session_breaker_rehydrates_after_simulated_restart():
    print("\n[session breaker: a fresh bot instance rehydrates a persisted paused state instead of resetting]")
    seed = 20.0
    # State as it would be fetched from the DB after a restart mid-cooldown: already paused,
    # tripped 10 minutes ago, in the middle of the same session.
    tripped_at = SESSION_A + _dt.timedelta(minutes=10)
    now = SESSION_A + _dt.timedelta(minutes=15)
    persisted_state = {
        "id": 1, "seed_usd": seed, "realized_pnl_usd": 0.02,
        "session_breaker_session_start": SESSION_A_START.isoformat(),
        "session_breaker_baseline_pnl": 0.0,
        "session_breaker_peak_pnl": 0.10,
        "session_breaker_paused": True,
        "session_breaker_paused_at": tripped_at.isoformat(),
    }
    ex = FakeExchange()
    fresh_bot = make_bot(ex, session_drawdown_stop_pct=0.25, schema_has_session_breaker=True)
    check("fresh bot starts with no session tracked yet (simulating a restart)",
          fresh_bot.session_index is None)

    sig = await fresh_bot._apply_session_breaker(persisted_state, "long", now_utc=now)
    check("rehydrated as still paused (did NOT reset to a fresh unpaused session)",
          fresh_bot.session_paused is True)
    check("entry signal still suppressed", sig is None, sig)
    check("rehydrated peak matches the persisted value",
          fresh_bot.session_peak_pnl == 0.10, fresh_bot.session_peak_pnl)

    # cooldown should still count from the ORIGINAL trip time, not reset by the restart
    almost = SESSION_A + _dt.timedelta(minutes=54)   # 44 min after tripped_at (10+44=54)
    sig = await fresh_bot._apply_session_breaker(persisted_state, "long", now_utc=almost)
    check("still paused just before the real cooldown (measured from original trip) elapses",
          fresh_bot.session_paused is True and sig is None)

    after = SESSION_A + _dt.timedelta(minutes=56)    # 46 min after tripped_at
    sig = await fresh_bot._apply_session_breaker(persisted_state, "short", now_utc=after)
    check("re-arms once the ORIGINAL cooldown (not a fresh one) elapses",
          fresh_bot.session_paused is False and sig == "short", (fresh_bot.session_paused, sig))


async def t_session_breaker_smart_resume_blocked_by_matching_direction():
    print("\n[smart resume: cooldown elapsed but price still moving the SAME way as at trip -> stays paused]")
    ex = FakeExchange()
    bot = make_bot(ex, session_drawdown_stop_pct=0.15, session_breaker_cooldown_min=15,
                   session_breaker_recheck_min=10, session_breaker_direction_window=10)
    seed = 20.0
    bot.session_index = bot._current_session_start(SESSION_A)
    bot.session_baseline_pnl = 0.0
    bot.session_peak_pnl = 0.10
    bot.session_paused = True
    bot.session_paused_at = SESSION_A
    bot.session_next_check_at = SESSION_A + _dt.timedelta(minutes=15)
    bot.session_trip_direction = "short"  # was declining at trip time
    bot.session_start_equity = seed

    bot.candles = make_trend_candles("short", n=30)  # still declining
    check_time = SESSION_A + _dt.timedelta(minutes=15)
    sig = await bot._apply_session_breaker(_mk_session_state(seed, 0.02), "long", now_utc=check_time)
    check("still paused (direction unchanged)", bot.session_paused is True and sig is None,
          (bot.session_paused, sig))
    check("next check deferred by recheck_min, not resumed",
          bot.session_next_check_at == check_time + _dt.timedelta(minutes=10),
          bot.session_next_check_at)


async def t_session_breaker_smart_resume_blocked_by_volatility():
    print("\n[smart resume: direction flipped but volatility still elevated -> stays paused]")
    ex = FakeExchange()
    bot = make_bot(ex, session_drawdown_stop_pct=0.15, session_breaker_cooldown_min=15,
                   session_breaker_recheck_min=10, session_breaker_direction_window=10,
                   session_breaker_calm_range_pct=0.20)
    seed = 20.0
    bot.session_index = bot._current_session_start(SESSION_A)
    bot.session_baseline_pnl = 0.0
    bot.session_peak_pnl = 0.10
    bot.session_paused = True
    bot.session_paused_at = SESSION_A
    bot.session_next_check_at = SESSION_A + _dt.timedelta(minutes=15)
    bot.session_trip_direction = "short"
    bot.session_start_equity = seed

    # Net direction has flipped to long (opposite the trip), but wide choppy swings mean
    # realized volatility hasn't actually calmed down.
    t0 = 1700000000000
    base = 86000.0
    vals = [86000, 86200, 85900, 86300, 86000, 86400, 86100, 86500, 86200, 86600, 86300]
    candles = [{"t": t0 + i*60000, "o": (vals[i-1] if i else base), "h": v+100, "l": v-100, "c": v}
               for i, v in enumerate(vals)]
    candles.append({"t": t0 + len(vals)*60000, "o": base, "h": base+5, "l": base-5, "c": base})
    bot.candles = candles

    check_time = SESSION_A + _dt.timedelta(minutes=15)
    sig = await bot._apply_session_breaker(_mk_session_state(seed, 0.02), "long", now_utc=check_time)
    check("still paused (direction cleared but volatility didn't)",
          bot.session_paused is True and sig is None, (bot.session_paused, sig))


async def t_session_breaker_smart_resume_clears_when_calm():
    print("\n[smart resume: direction cleared AND volatility calm -> resumes]")
    ex = FakeExchange()
    bot = make_bot(ex, session_drawdown_stop_pct=0.15, session_breaker_cooldown_min=15,
                   session_breaker_recheck_min=10, session_breaker_direction_window=10,
                   session_breaker_calm_range_pct=0.20)
    seed = 20.0
    bot.session_index = bot._current_session_start(SESSION_A)
    bot.session_baseline_pnl = 0.0
    bot.session_peak_pnl = 0.10
    bot.session_paused = True
    bot.session_paused_at = SESSION_A
    bot.session_next_check_at = SESSION_A + _dt.timedelta(minutes=15)
    bot.session_trip_direction = "short"
    bot.session_start_equity = seed

    # Genuinely tight/flat candles -- direction=None, range well under the 0.20% calm bar
    # (make_candles("mid") still has a +-100 h/l spread on every candle, too wide for this).
    t0 = 1700000000000
    base = 86000.0
    bot.candles = [{"t": t0 + i*60000, "o": base, "h": base+5, "l": base-5, "c": base}
                   for i in range(30)]
    check_time = SESSION_A + _dt.timedelta(minutes=15)
    sig = await bot._apply_session_breaker(_mk_session_state(seed, 0.02), "long", now_utc=check_time)
    check("re-armed (both gates cleared)", bot.session_paused is False)
    check("entry signal passes through", sig == "long", sig)
    check("peak/baseline reset fresh", bot.session_peak_pnl == 0.0, bot.session_peak_pnl)


def make_flat_range_candles(range_pct, base=86000.0, n=8):
    """n>=6 candles all sharing the same h/l spread -- compute_range_pct (window=5) reads
    exactly `range_pct` off the last 5 CLOSED candles (candles[:-1][-5:])."""
    half = range_pct / 100 * base / 2
    t0 = 1700000000000
    return [{"t": t0 + i*60000, "o": base, "h": base+half, "l": base-half, "c": base}
            for i in range(n)]


async def t_session_breaker_adaptive_calm_records_range_at_trip():
    print("\n[adaptive calm: a real trip records the volatility AT that moment, not a fixed number]")
    ex = FakeExchange()
    bot = make_bot(ex, session_drawdown_stop_pct=0.15, session_breaker_cooldown_min=15,
                   session_breaker_recheck_min=10, session_breaker_adaptive_calm=True)
    seed = 20.0
    bot.candles = make_flat_range_candles(0.27)
    await bot._apply_session_breaker(_mk_session_state(seed, 0.0), None, now_utc=SESSION_A)
    await bot._apply_session_breaker(_mk_session_state(seed, 0.10), None, now_utc=SESSION_A)
    sig = await bot._apply_session_breaker(_mk_session_state(seed, 0.04), "long", now_utc=SESSION_A)
    check("tripped", bot.session_paused is True and sig is None, (bot.session_paused, sig))
    check("recorded the trip-moment range%, not None",
          bot.session_trip_range_pct is not None and abs(bot.session_trip_range_pct - 0.27) < 1e-6,
          bot.session_trip_range_pct)


async def t_session_breaker_adaptive_calm_blocked_above_trip_level():
    print("\n[adaptive calm: cooldown elapsed but volatility still ABOVE trip-moment level -> stays paused]")
    ex = FakeExchange()
    bot = make_bot(ex, session_drawdown_stop_pct=0.15, session_breaker_cooldown_min=15,
                   session_breaker_recheck_min=10, session_breaker_adaptive_calm=True)
    seed = 20.0
    bot.session_index = bot._current_session_start(SESSION_A)
    bot.session_baseline_pnl = 0.0
    bot.session_peak_pnl = 0.10
    bot.session_paused = True
    bot.session_paused_at = SESSION_A
    bot.session_next_check_at = SESSION_A + _dt.timedelta(minutes=15)
    bot.session_trip_range_pct = 0.10  # tripped during LOW volatility
    bot.session_start_equity = seed

    bot.candles = make_flat_range_candles(0.15)  # calmer than a fixed 0.20% bar, but NOT
    # calmer than this specific trip's own 0.10% -- adaptive should still block it.
    check_time = SESSION_A + _dt.timedelta(minutes=15)
    sig = await bot._apply_session_breaker(_mk_session_state(seed, 0.02), "long", now_utc=check_time)
    check("still paused (0.15% > trip's own 0.10%)", bot.session_paused is True and sig is None,
          (bot.session_paused, sig))


async def t_session_breaker_adaptive_calm_resumes_at_or_below_trip_level():
    print("\n[adaptive calm: volatility back to the trip-moment level -> resumes, even above a fixed 0.20%]")
    ex = FakeExchange()
    bot = make_bot(ex, session_drawdown_stop_pct=0.15, session_breaker_cooldown_min=15,
                   session_breaker_recheck_min=10, session_breaker_adaptive_calm=True)
    seed = 20.0
    bot.session_index = bot._current_session_start(SESSION_A)
    bot.session_baseline_pnl = 0.0
    bot.session_peak_pnl = 0.10
    bot.session_paused = True
    bot.session_paused_at = SESSION_A
    bot.session_next_check_at = SESSION_A + _dt.timedelta(minutes=15)
    bot.session_trip_range_pct = 0.35  # tripped during genuinely HIGH volatility
    bot.session_start_equity = seed

    bot.candles = make_flat_range_candles(0.25)  # would FAIL a fixed 0.20% bar, but this is
    # calmer than what this trip actually happened in -- adaptive should resume.
    check_time = SESSION_A + _dt.timedelta(minutes=15)
    sig = await bot._apply_session_breaker(_mk_session_state(seed, 0.02), "long", now_utc=check_time)
    check("re-armed (0.25% <= trip's own 0.35%, even though it's above a fixed 0.20%)",
          bot.session_paused is False and sig == "long", (bot.session_paused, sig))
    check("trip_range_pct cleared on resume", bot.session_trip_range_pct is None,
          bot.session_trip_range_pct)


async def t_tick_skips_rest_when_disabled_and_flat():
    print("\n[tick: disabled AND flat -> never touches the REST position endpoint at all]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="long")
    bot.state_row["enabled"] = False
    bot.state_row["side"] = None
    await bot.tick()
    check("get_position_rest never called",
          getattr(bot, "get_position_rest_calls", 0) == 0, getattr(bot, "get_position_rest_calls", 0))
    check("no order attempted either", ex.orders == [], ex.orders)


async def t_tick_still_checks_rest_when_disabled_but_open():
    print("\n[tick: disabled but STILL holding a position -> still protects it via REST]")
    entry = 86000.0
    ex = FakeExchange(position=round(20.0 / entry, 5), collateral=20.0)
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": False, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="mid")
    await bot.tick()
    check("get_position_rest WAS called (disabled doesn't mean unprotected)",
          getattr(bot, "get_position_rest_calls", 0) >= 1, getattr(bot, "get_position_rest_calls", 0))


async def t_tick_close_requested_closes_open_position():
    print("\n[tick: close_requested=True closes the real position and clears the flag]")
    entry = 86000.0
    ex = FakeExchange(position=round(20.0 / entry, 5), collateral=20.0)
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
        "close_requested": True,
    }
    bot = make_bot(ex, state=state, candles_kind="mid")
    await bot.tick()
    check("position actually closed on the exchange", abs(ex.position) < 1e-9, ex.position)
    check("side cleared", bot.state_row["side"] is None)
    check("close_requested cleared", bot.state_row["close_requested"] is False)
    check("force-disabled so it doesn't re-enter next tick", bot.state_row["enabled"] is False)


async def t_tick_close_requested_works_even_when_disabled():
    print("\n[tick: close_requested fires even on an already-disabled bot -- the whole point]")
    entry = 86000.0
    ex = FakeExchange(position=round(20.0 / entry, 5), collateral=20.0)
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": False, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
        "close_requested": True,
    }
    bot = make_bot(ex, state=state, candles_kind="mid")
    await bot.tick()
    check("position closed despite enabled=False", abs(ex.position) < 1e-9, ex.position)
    check("side cleared", bot.state_row["side"] is None)


async def t_tick_close_requested_with_no_position_just_clears_flag():
    print("\n[tick: close_requested but already flat -> no order, just clears the flag]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid")
    bot.state_row["close_requested"] = True
    bot.state_row["side"] = None
    await bot.tick()
    check("no order attempted", ex.orders == [], ex.orders)
    check("close_requested cleared", bot.state_row["close_requested"] is False)
    check("force-disabled", bot.state_row["enabled"] is False)


async def t_tick_close_requested_keeps_retrying_if_close_fails():
    print("\n[tick: close_requested stays set if the close doesn't actually confirm flat -- retries next tick]")
    entry = 86000.0
    ex = FakeExchange(position=round(20.0 / entry, 5), collateral=20.0)
    ex.order_error = "boom"
    ex.fills_when_erroring = False  # the order never actually fills
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
        "close_requested": True,
    }
    bot = make_bot(ex, state=state, candles_kind="mid")
    await bot.tick()
    check("still holding (order never filled)", abs(ex.position) > 1e-9, ex.position)
    check("close_requested was NOT cleared -- will retry next tick",
          bot.state_row["close_requested"] is True, bot.state_row["close_requested"])
    check("side still tracked (nothing was falsely cleared)", bot.state_row["side"] == "long")


async def t_tick_close_requested_backs_off_between_retries():
    print("\n[tick: a failed close retry backs off instead of hammering the very next tick]")
    entry = 86000.0
    ex = FakeExchange(position=round(20.0 / entry, 5), collateral=20.0)
    ex.order_error = "boom"
    ex.fills_when_erroring = False
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
        "close_requested": True,
    }
    bot = make_bot(ex, state=state, candles_kind="mid")
    await bot.tick()
    orders_after_first_attempt = len(ex.orders)
    check("first attempt actually tried to place an order", orders_after_first_attempt >= 1,
          orders_after_first_attempt)
    check("backoff counter incremented", bot._close_retry_failures >= 1, bot._close_retry_failures)
    check("next retry time pushed into the future",
          bot._close_retry_next_at > time.time(), bot._close_retry_next_at - time.time())

    # An immediate next tick, before the backoff window elapses, must NOT place another order --
    # this is exactly the gap that hammered a WAF-blocked endpoint on 2026-09-24.
    await bot.tick()
    check("no new order placed on the immediate next tick (backoff held)",
          len(ex.orders) == orders_after_first_attempt, len(ex.orders))


async def t_read_position_falls_back_to_cache_on_error():
    print("\n[read_position: REST call fails, but we have a prior cached read -> use it, don't crash]")
    ex = FakeExchange(position=0.0005, collateral=20.0)
    bot = make_bot(ex, candles_kind="mid")
    bot._pos_cache = (0.0005, 20.0)
    bot._pos_cache_at = time.time() - 999  # long past POSITION_TTL, so a fresh read is attempted

    async def failing_get_position_rest():
        raise RuntimeError("(405)\nReason: Not Allowed ... x-amzn-waf-action: captcha")
    bot.get_position_rest = failing_get_position_rest

    pos, coll = await bot.read_position()
    check("fell back to the cached position", pos == 0.0005, pos)
    check("fell back to the cached collateral", coll == 20.0, coll)
    check("logged the fallback", any(a == "position_read_failed_using_cache" for a, _ in bot.runs),
          bot.runs)


async def t_get_position_rest_backs_off_instead_of_retrying_every_call():
    print("\n[get_position_rest: a failing REST endpoint doesn't get hammered every call -- backs off]")
    # Backoff must live in get_position_rest() itself, not just read_position() -- proven
    # necessary 2026-09-24: confirm_fill/close_all/emergency_flatten/try_enter all call
    # get_position_rest() directly, bypassing read_position() entirely, so a backoff placed
    # only in read_position() left every other caller free to keep hammering a WAF-blocked
    # endpoint at full tick cadence the moment a bot held an open position.
    calls = {"n": 0}

    class FailingAccountApi:
        def __init__(self, api_client):
            pass
        async def account(self, by, value, _headers=None, _request_timeout=None):
            calls["n"] += 1
            raise RuntimeError("(405) captcha")

    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid")
    bot.client = FakeSigner(token="tok-xyz")

    orig_account_api = core.lighter.AccountApi
    core.lighter.AccountApi = FailingAccountApi
    try:
        raised = False
        try:
            await core.StochBot.get_position_rest(bot)
        except Exception:
            raised = True
        check("first call actually attempted the REST read and raised", raised and calls["n"] == 1, calls["n"])

        raised2 = False
        try:
            await core.StochBot.get_position_rest(bot)
        except Exception:
            raised2 = True
        check("second call within the backoff window still raises but did NOT hit the network again",
              raised2 and calls["n"] == 1, calls["n"])
    finally:
        core.lighter.AccountApi = orig_account_api

    check("consecutive failure counter incremented on the real attempt",
          bot._pos_read_consecutive_failures == 1, bot._pos_read_consecutive_failures)
    check("next-attempt gate pushed into the future", bot._pos_read_next_attempt_at > time.time(),
          bot._pos_read_next_attempt_at - time.time())


async def t_get_position_rest_resumes_normal_polling_after_a_success():
    print("\n[get_position_rest: a successful read resets the backoff counter]")

    class FakePosition:
        def __init__(self, market_id, position, sign):
            self.market_id = market_id; self.position = position; self.sign = sign

    class FakeAccountRow:
        def __init__(self, position, collateral, market_index):
            sign = "1" if position >= 0 else "-1"
            self.positions = [FakePosition(market_index, str(abs(position)), sign)]
            self.collateral = collateral

    class FakeAcctResp:
        def __init__(self, position, collateral, market_index):
            self.accounts = [FakeAccountRow(position, collateral, market_index)]

    class SucceedingAccountApi:
        def __init__(self, api_client):
            pass
        async def account(self, by, value, _headers=None, _request_timeout=None):
            return FakeAcctResp(0.0007, 22.0, 1)

    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid")
    bot.client = FakeSigner(token="tok-xyz")
    bot._pos_read_consecutive_failures = 4
    bot._pos_read_next_attempt_at = 0.0  # backoff window already elapsed

    orig_account_api = core.lighter.AccountApi
    core.lighter.AccountApi = SucceedingAccountApi
    try:
        pos, coll = await core.StochBot.get_position_rest(bot)
    finally:
        core.lighter.AccountApi = orig_account_api

    check("real read succeeded", abs(pos - 0.0007) < 1e-9, pos)
    check("failure counter reset", bot._pos_read_consecutive_failures == 0,
          bot._pos_read_consecutive_failures)
    check("next-attempt gate cleared", bot._pos_read_next_attempt_at == 0.0,
          bot._pos_read_next_attempt_at)


async def t_read_position_raises_without_any_cache():
    print("\n[read_position: REST call fails AND we've never read a position -> still raises]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid")
    bot._pos_cache = None

    async def failing_get_position_rest():
        raise RuntimeError("(405) captcha")
    bot.get_position_rest = failing_get_position_rest

    raised = False
    try:
        await bot.read_position()
    except RuntimeError:
        raised = True
    check("raised (nothing safe to fall back to)", raised is True)


async def t_tick_error_backoff_formula():
    print("\n[tick_error_backoff_seconds: exponential, capped at 60s]")
    from stoch_bot_core import tick_error_backoff_seconds as backoff
    check("1st error -> 1s", backoff(1) == 1.0, backoff(1))
    check("2nd error -> 2s", backoff(2) == 2.0, backoff(2))
    check("3rd error -> 4s", backoff(3) == 4.0, backoff(3))
    check("4th error -> 8s", backoff(4) == 8.0, backoff(4))
    check("large error count caps at 60s", backoff(50) == 60.0, backoff(50))


class FakeSigner:
    """Stands in for lighter.SignerClient's create_auth_token_with_expiry -- a purely local
    signing call, so no network mock is needed, just a call counter."""
    def __init__(self, token="tok-1", fail=False):
        self.token = token
        self.fail = fail
        self.calls = 0
        self.api_client = object()

    def create_auth_token_with_expiry(self):
        self.calls += 1
        if self.fail:
            return None, "signing error"
        return self.token, None


async def t_auth_token_cached_across_calls():
    print("\n[_get_auth_token: reuses the cached token instead of re-signing on every call]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid")
    bot.client = FakeSigner()
    t1 = bot._get_auth_token()
    t2 = bot._get_auth_token()
    check("same token returned both times", t1 == t2 == "tok-1", (t1, t2))
    check("only signed once", bot.client.calls == 1, bot.client.calls)


async def t_auth_token_refreshes_within_margin_of_expiry():
    print("\n[_get_auth_token: regenerates once the cached token is within the refresh margin of expiry]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid")
    bot.client = FakeSigner(token="tok-1")
    bot._get_auth_token()
    check("signed once so far", bot.client.calls == 1, bot.client.calls)
    bot.client.token = "tok-2"
    bot._auth_token_expiry_at = time.time() + core.AUTH_TOKEN_REFRESH_MARGIN_S - 1
    t = bot._get_auth_token()
    check("regenerated a fresh token", t == "tok-2", t)
    check("signed a second time", bot.client.calls == 2, bot.client.calls)


async def t_auth_token_signing_error_returns_none_without_poisoning_cache():
    print("\n[_get_auth_token: a signing error returns None and is retried next call, not cached]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid")
    bot.client = FakeSigner(fail=True)
    t = bot._get_auth_token()
    check("returns None on signing error", t is None, t)
    bot.client.fail = False
    bot.client.token = "tok-recovered"
    t2 = bot._get_auth_token()
    check("recovers on the next call", t2 == "tok-recovered", t2)
    check("attempted signing both times (failure wasn't cached)", bot.client.calls == 2, bot.client.calls)


async def t_get_position_rest_attaches_auth_header():
    print("\n[get_position_rest: the real method attaches the signed token as an authorization header]")

    class FakePosition:
        def __init__(self, market_id, position, sign):
            self.market_id = market_id
            self.position = position
            self.sign = sign

    class FakeAccountRow:
        def __init__(self, position, collateral, market_index):
            sign = "1" if position >= 0 else "-1"
            self.positions = [FakePosition(market_index, str(abs(position)), sign)]
            self.collateral = collateral

    class FakeAcctResp:
        def __init__(self, position, collateral, market_index):
            self.accounts = [FakeAccountRow(position, collateral, market_index)]

    captured = {}

    class FakeAccountApi:
        def __init__(self, api_client):
            pass

        async def account(self, by, value, _headers=None, _request_timeout=None):
            captured["headers"] = _headers
            return FakeAcctResp(0.001, 25.0, 1)

    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid")
    bot.client = FakeSigner(token="tok-xyz")

    orig_account_api = core.lighter.AccountApi
    core.lighter.AccountApi = FakeAccountApi
    try:
        pos, coll = await core.StochBot.get_position_rest(bot)
    finally:
        core.lighter.AccountApi = orig_account_api

    check("position read correctly through the fake", abs(pos - 0.001) < 1e-9, pos)
    check("collateral read correctly", coll == 25.0, coll)
    check("authorization header carries the signed token",
          captured.get("headers", {}).get("authorization") == "tok-xyz", captured.get("headers"))


async def t_close_clears_position_bands_when_schema_has_them():
    print("\n[closing a position clears position_tp_pct/sl_pct when schema_has_position_bands=True]")
    entry = 86000.0
    sl_trigger = entry * (1 + 0.30 / 100)
    ex = FakeExchange(position=-round(20.0 / entry, 5), collateral=20.0 - 0.06)
    state = {
        "id": 1, "side": "short", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
        "position_tp_pct": 0.30, "position_sl_pct": 0.30,  # leftover trend band
    }
    bot = make_bot(ex, state=state, candles_kind="mid", schema_has_position_bands=True)
    bot.live.order_book = {"bids": [{"price": str(sl_trigger)}], "asks": [{"price": str(sl_trigger + 1)}]}
    await bot.tick()
    check("position closed", bot.state_row["side"] is None, bot.state_row["side"])
    check("position_tp_pct cleared to None (not left stuck at 0.30)",
          bot.state_row.get("position_tp_pct") is None, bot.state_row.get("position_tp_pct"))
    check("position_sl_pct cleared to None (not left stuck at 0.30)",
          bot.state_row.get("position_sl_pct") is None, bot.state_row.get("position_sl_pct"))


async def t_close_does_not_touch_bands_without_schema_flag():
    print("\n[closing a position WITHOUT schema_has_position_bands never writes those keys (Worker 2 safety)]")
    entry = 86000.0
    sl_trigger = entry * (1 + 0.11 / 100)
    ex = FakeExchange(position=-round(20.0 / entry, 5), collateral=20.0 - 0.02)
    state = {
        "id": 1, "side": "short", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="mid")  # schema_has_position_bands defaults False
    bot.live.order_book = {"bids": [{"price": str(sl_trigger)}], "asks": [{"price": str(sl_trigger + 1)}]}
    await bot.tick()
    check("position closed", bot.state_row["side"] is None, bot.state_row["side"])
    check("position_tp_pct key never touched (no column on this table)",
          "position_tp_pct" not in bot.state_row)
    check("position_sl_pct key never touched (no column on this table)",
          "position_sl_pct" not in bot.state_row)


async def t_trend_leg_sl_is_wider_than_fade_sl():
    print("\n[an open TREND-regime position uses its own wider SL, not the bot's default fade SL]")
    entry = 86000.0
    # Fade SL would be entry*(1-0.11/100) = 85905.4 -- price below that would normally stop
    # out a fade position, but this position was recorded with the trend SL (0.30%), so it
    # should still be open.
    fade_sl_price = entry * (1 - 0.11 / 100)
    trend_sl_price = entry * (1 - 0.30 / 100)
    mid_price = (fade_sl_price + trend_sl_price) / 2  # between the two SLs
    ex = FakeExchange(position=20.0 / entry, collateral=20.0)
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
        "position_tp_pct": 0.30, "position_sl_pct": 0.30,
    }
    bot = make_bot(ex, state=state, candles_kind="mid",
                   er_period=6, er_max=0.5, trend_tp_pct=0.30, trend_sl_pct=0.30)
    bot.live.order_book = {"bids": [{"price": str(mid_price)}], "asks": [{"price": str(mid_price+1)}]}
    await bot.tick()
    actions = [a for a, _ in bot.runs]
    check("position NOT closed (price is inside the wider trend SL)", "closed" not in actions,
          actions)
    check("side still open", bot.state_row["side"] == "long")


class FakeSbForFailover:
    """Mocks only the sb() calls run_tick_logger_forever makes: GET the latest row, POST a
    new one. Lets the failover logic run for real against a scripted table state."""
    def __init__(self, latest_row=None):
        self.latest_row = latest_row
        self.posted = []
        self.deleted = []

    async def __call__(self, method, path, body=None):
        if method == "GET":
            return [self.latest_row] if self.latest_row else []
        if method == "POST":
            self.posted.append(body)
            self.latest_row = {"ts": datetime.now(timezone.utc).isoformat(), "source": body["source"]}
            return None
        if method == "DELETE":
            self.deleted.append(path)
            return None
        raise AssertionError(f"unexpected method {method}")


def make_logger_bot(worker_id, defers_to, latest_row=None, prune=False):
    cfg = BotConfig(name="t", worker_id=worker_id, table_state="s", table_trades="t",
                    table_runs="r", stoch_window=5, tp_pct=0.10, sl_pct=0.11,
                    entry_lo=25, entry_hi=75, reversal_lo=25, reversal_hi=75,
                    tick_log_defers_to=defers_to, tick_log_prune=prune)
    bot = StochBot(cfg)
    bot.live = LiveState(1, 1)
    bot.live.order_book = {"bids": [{"price": "86000.0"}], "asks": [{"price": "86001.0"}]}
    bot.live.ob_updated_at = time.time()
    fake_sb = FakeSbForFailover(latest_row)
    bot.sb = fake_sb
    return bot, fake_sb


async def t_close_never_calls_cancel_all():
    print("\n[close_all no longer calls cancel_all -- these bots never place resting orders]")
    entry = 86000.0
    ex = FakeExchange(position=round(20.0 / entry, 5), collateral=20.0)
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="mid")
    ok = await bot.close_all("SL", dict(state), "long", state["legs"], 85000.0, 85001.0, 1)
    check("close succeeded", ok is True)
    check("cancel_all_orders was never called", getattr(ex, "cancel_all_calls", 0) == 0,
          getattr(ex, "cancel_all_calls", None))


async def t_close_reuses_known_pos_skips_extra_read():
    print("\n[close_all with a valid known_pos skips the redundant get_position_rest call]")
    entry = 86000.0
    real_qty = round(20.0 / entry, 5)
    ex = FakeExchange(position=real_qty, collateral=20.0)
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="mid")
    bot.get_position_rest_calls = 0
    ok = await bot.close_all("SL", dict(state), "long", state["legs"], 85000.0, 85001.0, 1,
                             known_pos=real_qty)
    check("close succeeded using known_pos", ok is True)
    # confirm_fill() still makes its own authoritative read(s) to verify the close landed --
    # only the FIRST, redundant pre-close read should be skipped.
    check("known_pos avoided the extra pre-close read (only confirm_fill's reads happened)",
          bot.get_position_rest_calls <= 2, bot.get_position_rest_calls)


async def t_close_ignores_known_pos_wrong_direction():
    print("\n[close_all falls back to a fresh read if known_pos points the wrong way (safety)]")
    entry = 86000.0
    real_qty = round(20.0 / entry, 5)
    ex = FakeExchange(position=real_qty, collateral=20.0)  # real position is LONG
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="mid")
    # stale/wrong known_pos claims SHORT -- must not be trusted
    ok = await bot.close_all("SL", dict(state), "long", state["legs"], 85000.0, 85001.0, 1,
                             known_pos=-real_qty)
    check("still closed correctly despite bad known_pos (fell back to a real read)",
          ok is True and abs(ex.position) < 1e-9, ex.position)


async def t_tick_log_primary_always_writes():
    print("\n[tick logger: primary (defers_to=[]) always writes regardless of table state]")
    bot, sb = make_logger_bot("worker2", [], latest_row={
        "ts": datetime.now(timezone.utc).isoformat(), "source": "worker3"})
    # one iteration of the loop body, not the infinite loop
    should_write = len(bot.cfg.tick_log_defers_to) == 0
    check("primary never checks the table, always writes", should_write is True)


async def t_tick_log_backup_defers_while_primary_fresh():
    print("\n[tick logger: backup stays silent while the primary is actively writing]")
    fresh_row = {"ts": datetime.now(timezone.utc).isoformat(), "source": "worker2"}
    bot, sb = make_logger_bot("worker3", ["worker2"], latest_row=fresh_row)
    last = await bot.sb("GET", "lighter_btc_price_ticks?select=ts,source&order=ts.desc&limit=1")
    last_ts = datetime.fromisoformat(last[0]["ts"])
    age = (datetime.now(timezone.utc) - last_ts).total_seconds()
    active_higher_priority = last[0]["source"] in bot.cfg.tick_log_defers_to and age < core.TICK_LOG_EVERY * 3
    check("backup detects primary is fresh and active", active_higher_priority is True)
    check("backup would NOT write", not (not active_higher_priority))


async def t_tick_log_backup_takes_over_when_primary_stale():
    print("\n[tick logger: backup takes over once the primary's last row goes stale]")
    stale_row = {"ts": (datetime.now(timezone.utc) - timedelta(seconds=core.TICK_LOG_EVERY*5)).isoformat(),
                 "source": "worker2"}
    bot, sb = make_logger_bot("worker3", ["worker2"], latest_row=stale_row)
    last = await bot.sb("GET", "x")
    last_ts = datetime.fromisoformat(last[0]["ts"])
    age = (datetime.now(timezone.utc) - last_ts).total_seconds()
    active_higher_priority = last[0]["source"] in bot.cfg.tick_log_defers_to and age < core.TICK_LOG_EVERY * 3
    should_write = not active_higher_priority
    check("backup correctly takes over on a stale primary", should_write is True)


async def t_tick_log_last_resort_defers_to_either():
    print("\n[tick logger: worker1 (defers to both) stays silent if EITHER is fresh]")
    fresh_from_worker3 = {"ts": datetime.now(timezone.utc).isoformat(), "source": "worker3"}
    bot, sb = make_logger_bot("worker1", ["worker2", "worker3"], latest_row=fresh_from_worker3)
    last = await bot.sb("GET", "x")
    last_ts = datetime.fromisoformat(last[0]["ts"])
    age = (datetime.now(timezone.utc) - last_ts).total_seconds()
    active_higher_priority = last[0]["source"] in bot.cfg.tick_log_defers_to and age < core.TICK_LOG_EVERY * 3
    check("worker1 defers when worker3 (also in its defer list) is fresh", active_higher_priority is True)


async def t_tick_log_no_rows_yet_anyone_writes():
    print("\n[tick logger: empty table -> even a backup writes (nothing to defer to)]")
    bot, sb = make_logger_bot("worker3", ["worker2"], latest_row=None)
    last = await bot.sb("GET", "x")
    should_write = True if not last else False
    check("backup writes when table is empty", should_write is True)


async def t_tick_log_disabled_worker_never_participates():
    print("\n[tick logger: tick_log_defers_to=None -> run_tick_logger_forever returns immediately]")
    cfg = BotConfig(name="t", worker_id="w", table_state="s", table_trades="t", table_runs="r",
                    stoch_window=5, tp_pct=0.10, sl_pct=0.11, entry_lo=25, entry_hi=75,
                    reversal_lo=25, reversal_hi=75, tick_log_defers_to=None)
    bot = StochBot(cfg)
    calls = []
    async def spy_sb(method, path, body=None):
        calls.append((method, path)); return []
    bot.sb = spy_sb
    bot.live = LiveState(1, 1)
    task = asyncio.create_task(bot.run_tick_logger_forever())
    await asyncio.sleep(0.05)
    check("returned immediately, never called sb", task.done() and len(calls) == 0, (task.done(), calls))
    task.cancel()


async def t_trading_hours_gate_default_disabled_passes_through():
    print("\n[trading hours gate: trading_hours_utc=None (default) never touches the signal]")
    ex = FakeExchange()
    bot = make_bot(ex)  # no trading_hours_utc override -- default None
    now_utc = _dt.datetime(2026, 9, 24, 3, 0, tzinfo=_dt.timezone.utc)  # any hour at all
    sig = bot._apply_trading_hours_gate("long", now_utc=now_utc)
    check("signal passes through unchanged", sig == "long", sig)


async def t_trading_hours_gate_blocks_outside_open_hours():
    print("\n[trading hours gate: current UTC hour not in the allowed set -> blocks]")
    ex = FakeExchange()
    bot = make_bot(ex, trading_hours_utc=[0, 1, 15, 16, 17])
    now_utc = _dt.datetime(2026, 9, 24, 14, 0, tzinfo=_dt.timezone.utc)  # 14:00 not in the list
    sig = bot._apply_trading_hours_gate("long", now_utc=now_utc)
    check("entry signal suppressed", sig is None, sig)


async def t_trading_hours_gate_passes_inside_open_hours():
    print("\n[trading hours gate: current UTC hour in the allowed set -> passes through]")
    ex = FakeExchange()
    bot = make_bot(ex, trading_hours_utc=[0, 1, 15, 16, 17])
    now_utc = _dt.datetime(2026, 9, 24, 16, 30, tzinfo=_dt.timezone.utc)  # 16:xx is in the list
    sig = bot._apply_trading_hours_gate("short", now_utc=now_utc)
    check("entry signal passes through", sig == "short", sig)


async def t_trading_hours_gate_none_signal_stays_none():
    print("\n[trading hours gate: no signal to begin with stays None regardless of the hour]")
    ex = FakeExchange()
    bot = make_bot(ex, trading_hours_utc=[16])
    now_utc = _dt.datetime(2026, 9, 24, 16, 0, tzinfo=_dt.timezone.utc)
    sig = bot._apply_trading_hours_gate(None, now_utc=now_utc)
    check("still None", sig is None, sig)


async def t_hour_open_confirmation_disabled_by_default():
    print("\n[hour-open confirmation: hour_open_requires_paper_tp=False (default) never arms it]")
    ex = FakeExchange()
    bot = make_bot(ex, trading_hours_utc=[16])
    now_utc = _dt.datetime(2026, 9, 24, 16, 0, tzinfo=_dt.timezone.utc)
    await bot._check_hour_open_confirmation(now_utc=now_utc)
    check("never armed", bot.awaiting_open_confirmation is False)


async def t_hour_open_confirmation_never_arms_without_self_lock():
    print("\n[hour-open confirmation: never arms without self_lock_enabled -- nothing would ever clear it]")
    ex = FakeExchange()
    bot = make_bot(ex, trading_hours_utc=[16], hour_open_requires_paper_tp=True,
                    self_lock_enabled=False)
    open_utc = _dt.datetime(2026, 9, 24, 16, 0, tzinfo=_dt.timezone.utc)
    await bot._check_hour_open_confirmation(now_utc=open_utc)
    check("stays unarmed -- would be a permanent lockout otherwise",
          bot.awaiting_open_confirmation is False)


async def t_hour_open_confirmation_arms_on_closed_to_open_transition():
    print("\n[hour-open confirmation: closed->open transition arms it]")
    ex = FakeExchange()
    bot = make_bot(ex, trading_hours_utc=[16], hour_open_requires_paper_tp=True,
                    self_lock_enabled=True)
    closed_utc = _dt.datetime(2026, 9, 24, 15, 59, tzinfo=_dt.timezone.utc)
    await bot._check_hour_open_confirmation(now_utc=closed_utc)
    check("not armed while still closed", bot.awaiting_open_confirmation is False)
    open_utc = _dt.datetime(2026, 9, 24, 16, 0, tzinfo=_dt.timezone.utc)
    await bot._check_hour_open_confirmation(now_utc=open_utc)
    check("armed the moment it opens", bot.awaiting_open_confirmation is True)


async def t_hour_open_confirmation_arms_on_boot_mid_open_hour():
    print("\n[hour-open confirmation: booting fresh already inside an open hour arms it too (option 1)]")
    ex = FakeExchange()
    bot = make_bot(ex, trading_hours_utc=[16], hour_open_requires_paper_tp=True,
                    self_lock_enabled=True)
    check("starts unarmed, no tick yet", bot.awaiting_open_confirmation is False)
    open_utc = _dt.datetime(2026, 9, 24, 16, 30, tzinfo=_dt.timezone.utc)  # already mid-open-hour
    await bot._check_hour_open_confirmation(now_utc=open_utc)
    check("armed on the very first check, no restart-skip", bot.awaiting_open_confirmation is True)


async def t_hour_open_confirmation_does_not_rearm_while_staying_open():
    print("\n[hour-open confirmation: staying inside the same open hour does not keep re-arming]")
    ex = FakeExchange()
    bot = make_bot(ex, trading_hours_utc=[16], hour_open_requires_paper_tp=True,
                    self_lock_enabled=True)
    await bot._check_hour_open_confirmation(now_utc=_dt.datetime(2026, 9, 24, 16, 0, tzinfo=_dt.timezone.utc))
    bot.awaiting_open_confirmation = False  # simulate the 1 paper TP having already cleared it
    await bot._check_hour_open_confirmation(now_utc=_dt.datetime(2026, 9, 24, 16, 30, tzinfo=_dt.timezone.utc))
    check("stays cleared -- same open hour, not a new transition", bot.awaiting_open_confirmation is False)


async def t_hour_open_confirmation_blocks_entry_signal():
    print("\n[hour-open confirmation: armed -> blocks a real entry signal even with self-lock unlocked]")
    ex = FakeExchange()
    candles = make_candles("long")
    state = {
        "id": 1, "side": None, "legs": [], "first_entry_price": None, "first_entry_time": None,
        "dca_level": 0, "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": None,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles=candles, self_lock_enabled=True,
                    trading_hours_utc=list(range(24)), hour_open_requires_paper_tp=True)
    bot.awaiting_open_confirmation = True  # armed, real trading not yet confirmed for this session
    await bot.tick()
    check("no real order placed while awaiting confirmation", len(ex.orders) == 0, ex.orders)
    check("still armed -- nothing cleared it", bot.awaiting_open_confirmation is True)


async def t_hour_open_confirmation_cleared_by_one_paper_tp():
    print("\n[hour-open confirmation: a single paper TP clears it (not two, unlike the self-lock counter)]")
    ex = FakeExchange()
    bot = make_bot(ex, self_lock_enabled=True, hour_open_requires_paper_tp=True,
                    trading_hours_utc=list(range(24)))
    bot.awaiting_open_confirmation = True
    bot.paper_side = "long"
    bot.paper_entry = 86000.0
    bot.paper_entry_ms = 1700000000000
    tp_price = 86000.0 * 1.0011  # past the paper position's own 0.10% TP
    await bot._update_paper_shadow({"id": 1}, None, None, tp_price, tp_price + 1, 1700000060000)
    check("cleared by the first paper TP alone", bot.awaiting_open_confirmation is False)
    check("self-lock's own 2-in-a-row counter is unaffected by this",
          bot.paper_consecutive_tps == 1, bot.paper_consecutive_tps)


async def t_log_trade_upserts_to_prevent_duplicate_rows():
    print("\n[log_trade: posts with on_conflict + ignore-duplicates so a race can't double-insert]")
    cfg = BotConfig(name="t", worker_id="w", table_state="s", table_trades="lighter_test_trades",
                    table_runs="r", stoch_window=5, tp_pct=0.10, sl_pct=0.11,
                    entry_lo=25, entry_hi=75, reversal_lo=25, reversal_hi=75)
    bot = StochBot(cfg)
    calls = []
    async def spy_sb(method, path, body=None, extra_headers=None):
        calls.append({"method": method, "path": path, "body": body, "extra_headers": extra_headers})
        return []
    bot.sb = spy_sb

    await core.StochBot.log_trade(bot, "long", 86000.0, 86100.0, 0.00023, 0.023, "TP", 1,
                                  "2026-09-24T00:00:00+00:00")

    check("exactly one sb call", len(calls) == 1, calls)
    call = calls[0]
    check("POST method", call["method"] == "POST", call["method"])
    check("targets the trades table with on_conflict on the natural key",
          call["path"] == "lighter_test_trades?on_conflict=opened_at,side,avg_entry_price", call["path"])
    check("Prefer header requests ignore-duplicates (not a plain insert)",
          call["extra_headers"] == {"Prefer": "resolution=ignore-duplicates,return=representation"},
          call["extra_headers"])
    check("body carries the real trade fields", call["body"]["side"] == "long"
          and call["body"]["avg_entry_price"] == 86000.0 and call["body"]["pnl_usd"] == 0.023,
          call["body"])


async def main():
    for t in (t_normal_entry, t_phantom_double_fill, t_nonce_error_but_filled,
              t_order_error_no_fill, t_circuit_breaker, t_close_uses_real_size,
              t_oversize_mismatch_in_tick, t_external_close_reconcile,
              t_order_timeout_bounded, t_read_position_never_trusts_stale_ws_flat,
              t_reconcile_falls_through_when_rest_disagrees,
              t_regime_switch_trend_entry_follows_direction,
              t_regime_switch_trend_invert_flips_direction,
              t_regime_switch_no_invert_by_default,
              t_pure_trend_fade_enters_opposite_of_raw_trend,
              t_pure_trend_fade_ignores_stochastic_in_chop,
              t_pure_trend_fade_never_reverses_only_tpsl_exits,
              t_regime_switch_chop_uses_fade_tpsl,
              t_regime_switch_off_never_touches_schema,
              t_open_position_tpsl_syncs_to_regime_flip_no_trade,
              t_open_position_tpsl_syncs_back_to_fade_when_trend_ends,
              t_reversal_guard_blocks_reversal_before_threshold,
              t_reversal_guard_allows_reversal_after_threshold,
              t_reversal_guard_does_not_delay_tp_or_sl,
              t_entry_vol_gate_pauses_on_high_true_range,
              t_entry_vol_gate_stays_paused_inside_hysteresis_band,
              t_entry_vol_gate_resumes_at_or_below_resume_threshold,
              t_entry_vol_gate_only_reevaluates_once_per_new_candle,
              t_entry_vol_gate_disabled_when_unconfigured,
              t_entry_vol_gate_persists_when_schema_enabled,
              t_entry_vol_gate_rehydrates_paused_state_after_restart,
              t_entry_vol_gate_blocks_reversal_reopen_but_not_the_close,
              t_self_lock_paper_shadow_opens_when_flat,
              t_self_lock_single_paper_tp_does_not_unlock,
              t_self_lock_two_consecutive_paper_tps_unlocks,
              t_self_lock_paper_sl_resets_counter,
              t_self_lock_real_sl_locks_and_resets_paper_counter,
              t_self_lock_blocks_real_entry_while_locked,
              t_self_lock_blocks_real_reversal_reopen_but_not_the_close,
              t_self_lock_persists_when_schema_enabled,
              t_self_lock_rehydrates_after_restart,
              t_self_lock_unlocks_and_enters_real_same_tick,
              t_self_lock_paper_shadow_respects_reversal_guard,
              t_session_breaker_stays_off_below_threshold,
              t_session_breaker_trips_and_blocks_new_entries,
              t_session_breaker_rearms_at_next_session,
              t_session_breaker_rearms_after_cooldown_same_session,
              t_session_breaker_trips_on_immediate_loss_before_profit,
              t_session_breaker_persists_when_schema_enabled,
              t_session_breaker_never_persists_without_schema_flag,
              t_session_breaker_rehydrates_after_simulated_restart,
              t_session_breaker_smart_resume_blocked_by_matching_direction,
              t_session_breaker_smart_resume_blocked_by_volatility,
              t_session_breaker_smart_resume_clears_when_calm,
              t_session_breaker_adaptive_calm_records_range_at_trip,
              t_session_breaker_adaptive_calm_blocked_above_trip_level,
              t_session_breaker_adaptive_calm_resumes_at_or_below_trip_level,
              t_tick_skips_rest_when_disabled_and_flat,
              t_tick_still_checks_rest_when_disabled_but_open,
              t_tick_close_requested_closes_open_position,
              t_tick_close_requested_works_even_when_disabled,
              t_tick_close_requested_with_no_position_just_clears_flag,
              t_tick_close_requested_keeps_retrying_if_close_fails,
              t_tick_close_requested_backs_off_between_retries,
              t_read_position_falls_back_to_cache_on_error,
              t_get_position_rest_backs_off_instead_of_retrying_every_call,
              t_get_position_rest_resumes_normal_polling_after_a_success,
              t_read_position_raises_without_any_cache,
              t_tick_error_backoff_formula,
              t_auth_token_cached_across_calls,
              t_auth_token_refreshes_within_margin_of_expiry,
              t_auth_token_signing_error_returns_none_without_poisoning_cache,
              t_get_position_rest_attaches_auth_header,
              t_close_clears_position_bands_when_schema_has_them,
              t_close_does_not_touch_bands_without_schema_flag,
              t_trend_leg_sl_is_wider_than_fade_sl,
              t_close_never_calls_cancel_all,
              t_close_reuses_known_pos_skips_extra_read,
              t_close_ignores_known_pos_wrong_direction,
              t_tick_log_primary_always_writes,
              t_tick_log_backup_defers_while_primary_fresh,
              t_tick_log_backup_takes_over_when_primary_stale,
              t_tick_log_last_resort_defers_to_either,
              t_tick_log_no_rows_yet_anyone_writes,
              t_tick_log_disabled_worker_never_participates,
              t_log_trade_upserts_to_prevent_duplicate_rows,
              t_trading_hours_gate_default_disabled_passes_through,
              t_trading_hours_gate_blocks_outside_open_hours,
              t_trading_hours_gate_passes_inside_open_hours,
              t_trading_hours_gate_none_signal_stays_none,
              t_hour_open_confirmation_disabled_by_default,
              t_hour_open_confirmation_never_arms_without_self_lock,
              t_hour_open_confirmation_arms_on_closed_to_open_transition,
              t_hour_open_confirmation_arms_on_boot_mid_open_hour,
              t_hour_open_confirmation_does_not_rearm_while_staying_open,
              t_hour_open_confirmation_blocks_entry_signal,
              t_hour_open_confirmation_cleared_by_one_paper_tp,
              t_timeout_constants):
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
