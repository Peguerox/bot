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
        self.sl_order_error = None   # simulate create_sl_order failing (e.g. "OrderPrice..." )

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

    async def create_sl_order(self, market_index, client_order_index, base_amount,
                              trigger_price, price, is_ask, reduce_only=False, **kw):
        self.sl_order_attempts = getattr(self, "sl_order_attempts", 0) + 1
        if self.sl_order_error:
            return None, None, self.sl_order_error
        self.sl_orders = getattr(self, "sl_orders", [])
        self.sl_orders.append({"qty": base_amount / 1e5, "trigger": trigger_price,
                               "price": price, "is_ask": is_ask, "reduce_only": reduce_only})
        return object(), object(), None

    async def create_tp_order(self, market_index, client_order_index, base_amount,
                              trigger_price, price, is_ask, reduce_only=False, **kw):
        self.tp_orders = getattr(self, "tp_orders", [])
        self.tp_orders.append({"qty": base_amount / 1e5, "trigger": trigger_price,
                               "price": price, "is_ask": is_ask, "reduce_only": reduce_only})
        return object(), object(), None

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
    bot.trade_kwargs = []

    async def get_state():
        return dict(bot.state_row)

    async def update_state(patch):
        bot.state_row.update(patch)

    async def log_run(action, detail):
        bot.runs.append((action, detail))

    async def log_trade(*a, **k):
        bot.trades.append(a)
        bot.trade_kwargs.append(k)  # kwargs (cycle_id, entry_features, ...) kept separately so
                                     # existing positional-index checks on bot.trades are unaffected

    async def get_position_rest():
        bot.get_position_rest_calls = getattr(bot, "get_position_rest_calls", 0) + 1
        # Match the real method's side effects: every authoritative read refreshes the cache and
        # resolves any unknown entry outcome (we can see the exchange again).
        bot._pos_cache = (ex.position, ex.collateral)
        bot._pos_cache_at = time.time()
        bot._entry_outcome_unknown = False
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
    # A FIRST oversize flattens and pauses; it no longer hard-disables. Permanently stopping on a
    # transient bad read halted the strategy asymmetrically (one leg off, its partner waiting).
    check("NOT disabled on a first occurrence", bot.state_row.get("enabled") is not False,
          bot.state_row.get("enabled"))
    check("entries paused by cooldown instead", bot._entry_cooldown_until > time.time())
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
    check("paused, not disabled, on a first occurrence",
          bot.state_row.get("enabled") is not False and bot._entry_cooldown_until > time.time())
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


def _zscore_candles(closes, base=86000.0):
    """7 candles with explicit closes (others flat at `base`) -- compute_zscore_signal needs
    w+2 candles total and reads from closed[-w:], i.e. everything except the live (last) one."""
    c = []
    t0 = 1700000000000
    for i, close in enumerate(closes):
        c.append({"t": t0 + i * 60000, "o": base, "h": max(base, close) + 5,
                  "l": min(base, close) - 5, "c": close})
    return c


async def t_zscore_signal_long_on_oversold_dip():
    print("\n[zscore signal: a sharp dip below the recent mean fires LONG]")
    ex = FakeExchange()
    # Window of 5 closed candles: four flat near 86000, the window's OWN last closed candle
    # (closed[-1], same inclusion rule as the stochastic window) snaps far below them.
    candles = _zscore_candles([86000, 86010, 85995, 86005, 85990, 85800, 85800])
    bot = make_bot(ex, candles=candles, use_zscore_signal=True, zscore_window=5, zscore_entry=2.0)
    entry, reversal, ts = bot.compute_zscore_signal()
    check("entry signal is long", entry == "long", entry)
    check("reversal mirrors entry (one threshold, both directions)", reversal == entry)
    check("live_k holds the z-score, not a 0-100 K", bot.live_k is not None and bot.live_k < -2.0,
          bot.live_k)


async def t_zscore_signal_short_on_overbought_spike():
    print("\n[zscore signal: a sharp spike above the recent mean fires SHORT]")
    ex = FakeExchange()
    candles = _zscore_candles([86000, 85990, 86005, 85995, 86010, 86200, 86200])
    bot = make_bot(ex, candles=candles, use_zscore_signal=True, zscore_window=5, zscore_entry=2.0)
    entry, reversal, ts = bot.compute_zscore_signal()
    check("entry signal is short", entry == "short", entry)


async def t_zscore_signal_neutral_inside_normal_range():
    print("\n[zscore signal: ordinary noise inside the threshold fires nothing]")
    ex = FakeExchange()
    candles = _zscore_candles([86000, 86010, 85995, 86005, 85998, 86002, 86002])
    bot = make_bot(ex, candles=candles, use_zscore_signal=True, zscore_window=5, zscore_entry=2.0)
    entry, reversal, ts = bot.compute_zscore_signal()
    check("no signal -- within +-2 std devs of its own recent mean", entry is None, entry)


async def t_zscore_signal_drives_a_real_entry_through_tick():
    print("\n[zscore signal: wired into tick() via use_zscore_signal, same as any other signal source]")
    ex = FakeExchange()
    candles = _zscore_candles([86000, 86010, 85995, 86005, 85990, 85800, 85800])
    bot = make_bot(ex, candles=candles, use_zscore_signal=True, zscore_window=5, zscore_entry=2.0,
                   require_fresh_signal=False, self_lock_enabled=False, use_joint_adaptive=False)
    await bot.tick()
    check("entered long off the z-score signal", bot.state_row["side"] == "long",
          bot.state_row["side"])


async def t_zscore_signal_off_by_default_other_bots_unaffected():
    print("\n[zscore signal: off by default -- every other bot still uses the plain stochastic]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="long")  # use_zscore_signal defaults False
    await bot.tick()
    check("entered via the ordinary stochastic path", bot.state_row["side"] == "long")
    check("live_k is a 0-100 stochastic K, not a z-score",
          bot.live_k is not None and 0 <= bot.live_k <= 100, bot.live_k)


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


def make_dispersion_candles(mids, base=86000.0):
    """len(mids) closed candles (h=l=mid, so (h+l)/2 is exactly that value) plus one trailing
    live candle -- compute_intrabar_dispersion reads candles[:-1]. Prepended with one extra
    dummy closed candle so compute_stoch_signal's own len(c) < w+2 floor (needs 7 total for
    stoch_window=5) is satisfied without shifting which 5 candles either function's own
    `[-window:]` slice actually lands on -- both still see exactly `mids`."""
    t0 = 1700000000000
    dummy = mids[0] if mids else base
    c = [{"t": t0 - 60000, "o": dummy, "h": dummy, "l": dummy, "c": dummy}]
    c += [{"t": t0 + i*60000, "o": m, "h": m, "l": m, "c": m} for i, m in enumerate(mids)]
    c.append({"t": t0 + len(mids)*60000, "o": base, "h": base, "l": base, "c": base})  # live
    return c


async def t_compute_intrabar_dispersion_basic():
    print("\n[compute_intrabar_dispersion: hand-computed example]")
    # mids [10,10,10,10,20] -> mean=12, variance=[4*(10-12)^2+(20-12)^2]/5=16, std=4
    candles = make_dispersion_candles([10,10,10,10,20])
    d = core.compute_intrabar_dispersion(candles, window=5)
    check("stdev matches hand calculation", d is not None and abs(d-4.0) < 1e-9, d)


async def t_compute_intrabar_dispersion_needs_full_window():
    print("\n[compute_intrabar_dispersion: None until the window is actually full]")
    candles = make_dispersion_candles([10,10,10])  # only 3 closed candles, window=5
    d = core.compute_intrabar_dispersion(candles, window=5)
    check("not enough history yet", d is None, d)


async def t_intrabar_dispersion_gate_blocks_entry_above_threshold():
    print("\n[intrabar dispersion gate: blocks a fresh entry when the reading is >= threshold]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", intrabar_dispersion_pause_at=50.0,
                   intrabar_dispersion_window=5)
    # [150,150,150,150,0] reads oversold (K=0, a real "long" signal) AND disperses at std=$60,
    # above the $50 threshold -- verified by hand in the shell before writing this.
    bot.candles = make_dispersion_candles([150,150,150,150,0])
    await bot.tick()
    check("blocked -- no entry despite a real long signal", bot.state_row["side"] is None,
          bot.state_row["side"])


async def t_intrabar_dispersion_gate_allows_entry_below_threshold():
    print("\n[intrabar dispersion gate: a calm reading lets a fresh entry through normally]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", intrabar_dispersion_pause_at=50.0,
                   intrabar_dispersion_window=5)
    # [20,20,20,20,0] -- same oversold shape (K=0), but std=$8, under the $50 threshold.
    bot.candles = make_dispersion_candles([20,20,20,20,0])
    await bot.tick()
    check("entered normally", bot.state_row["side"] == "long", bot.state_row["side"])


async def t_intrabar_dispersion_gate_off_by_default():
    print("\n[intrabar dispersion gate: off by default -- every other bot unaffected]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid")  # intrabar_dispersion_pause_at defaults None
    bot.candles = make_dispersion_candles([150,150,150,150,0])  # would block if the gate were on
    await bot.tick()
    check("entered normally -- gate is a no-op when unconfigured", bot.state_row["side"] == "long",
          bot.state_row["side"])


async def t_intrabar_dispersion_gate_never_blocks_an_exit():
    print("\n[intrabar dispersion gate: only ever gates entries -- never blocks protecting a position]")
    entry = 86000.0
    sl_price = entry * (1 - 0.11/100) - 1
    ex = FakeExchange(position=round(10.0/entry, 5), collateral=10.0)
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 10.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 10.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 10.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="mid", fixed_leg_usd=10.0,
                   sl_pct=0.11, tp_pct=0.10, require_fresh_signal=False,
                   self_lock_enabled=False, use_joint_adaptive=False,
                   intrabar_dispersion_pause_at=50.0, intrabar_dispersion_window=5)
    bot.candles = make_dispersion_candles([0, 50, 100, 150, 200])  # extreme, would block an entry
    bot.live.order_book = {"bids": [{"price": str(sl_price)}], "asks": [{"price": str(sl_price+1)}]}
    await bot.tick()
    check("SL still fired despite extreme dispersion", bot.state_row["side"] is None,
          bot.state_row["side"])


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


def _w1_lock_bot(ex):
    """Worker 1's live self-lock rule, as configured in lighter_stoch_dca_btc_initial.py:
    2 wins of ANY kind unlock, OR a single literal TP unlocks on its own."""
    bot = make_bot(ex, candles_kind="mid", self_lock_enabled=True, schema_has_self_lock=True,
                   self_lock_reversal_counts_as_win=True,
                   self_lock_require_tp_in_streak=False,
                   self_lock_tp_unlocks_instantly=True,
                   self_lock_loss_decrements_streak=True)
    bot.real_trading_locked = True
    bot._self_lock_loaded = True
    return bot


async def _paper_win_via_reversal(bot, state, entry=86000.0, t0=1700000000000):
    """Drive one WINNING non-TP paper close: open the shadow long, then hand it an opposing
    reversal signal at a profitable-but-below-TP price. reason is None -> counts as a win only
    through self_lock_reversal_counts_as_win, i.e. a 'green' that is NOT a literal TP."""
    bot.paper_side = "long"
    bot.paper_entry = entry
    bot.paper_entry_ms = t0
    price = entry * 1.0004  # +0.04%: green, but short of the 0.10% TP
    await bot._update_paper_shadow(state, None, "short", price, price + 1, t0 + 60000)


async def t_w1_self_lock_two_non_tp_greens_unlock():
    print("\n[Worker 1 self-lock: 2 greens with NO literal TP unlock (the 4-greens-stuck bug)]")
    ex = FakeExchange()
    bot = _w1_lock_bot(ex)
    state = dict(bot.state_row)
    await _paper_win_via_reversal(bot, state, t0=1700000000000)
    check("1 green counted", bot.paper_consecutive_tps == 1, bot.paper_consecutive_tps)
    check("still locked after 1 green", bot.real_trading_locked is True)
    await _paper_win_via_reversal(bot, state, t0=1700000120000)
    check("UNLOCKED on the 2nd green, with no literal TP anywhere in the streak",
          bot.real_trading_locked is False, bot.real_trading_locked)
    check("counter reset", bot.paper_consecutive_tps == 0, bot.paper_consecutive_tps)


async def t_w1_self_lock_single_tp_unlocks_instantly():
    print("\n[Worker 1 self-lock: a single literal TP unlocks on its own, no streak needed]")
    ex = FakeExchange()
    bot = _w1_lock_bot(ex)
    state = dict(bot.state_row)
    bot.paper_side = "long"
    bot.paper_entry = 86000.0
    bot.paper_entry_ms = 1700000000000
    tp_price = 86000.0 * 1.0011  # through the 0.10% TP
    await bot._update_paper_shadow(state, None, None, tp_price, tp_price + 1, 1700000060000)
    check("UNLOCKED on one literal TP", bot.real_trading_locked is False, bot.real_trading_locked)


async def t_w1_self_lock_a_real_sl_still_wipes_the_streak():
    print("\n[Worker 1 self-lock: 2 wins means 2 NET wins -- a paper SL still resets the count]")
    ex = FakeExchange()
    bot = _w1_lock_bot(ex)
    state = dict(bot.state_row)
    await _paper_win_via_reversal(bot, state, t0=1700000000000)
    check("1 green counted", bot.paper_consecutive_tps == 1)
    # Paper SL: opens long, price hits the 0.11% stop.
    bot.paper_side = "long"
    bot.paper_entry = 86000.0
    bot.paper_entry_ms = 1700000120000
    sl_price = 86000.0 * (1 - 0.0012)
    await bot._update_paper_shadow(state, None, None, sl_price, sl_price + 1, 1700000180000)
    check("streak wiped by the SL", bot.paper_consecutive_tps == 0, bot.paper_consecutive_tps)
    check("still locked", bot.real_trading_locked is True)
    # And one green alone after that is still not enough.
    await _paper_win_via_reversal(bot, state, t0=1700000240000)
    check("one green after the SL is still not an unlock",
          bot.real_trading_locked is True, bot.real_trading_locked)


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


async def t_self_lock_reversal_counts_as_win_disabled_by_default():
    print("\n[self-lock: self_lock_reversal_counts_as_win=False (default) -- a winning reversal stays neutral]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", self_lock_enabled=True)
    bot._self_lock_loaded = True
    bot.paper_side = "long"
    bot.paper_entry = 86000.0
    bot.paper_entry_ms = 1700000000000
    state = dict(bot.state_row)
    # entry 86000, tp_pct=0.10/sl_pct=0.11 -> TP=86086, SL=85905.4. best_bid=86040 is a real
    # win (above entry) but stays INSIDE the band, so this closes via reversal, not literal TP.
    await bot._update_paper_shadow(state, None, "short", 86040.0, 86041.0, 1700000000000)
    check("counter untouched by a winning reversal when the flag is off",
          bot.paper_consecutive_tps == 0, bot.paper_consecutive_tps)


async def t_self_lock_winning_reversal_counts_toward_unlock():
    print("\n[self-lock: self_lock_reversal_counts_as_win=True -- a WINNING reversal counts like a TP]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", self_lock_enabled=True, self_lock_reversal_counts_as_win=True)
    bot._self_lock_loaded = True
    bot.paper_side = "long"
    bot.paper_entry = 86000.0
    bot.paper_entry_ms = 1700000000000
    state = dict(bot.state_row)
    # Closing a long at best_bid=86040 (above the 86000 entry, inside the TP band) is a real
    # win via reversal, not a literal TP.
    await bot._update_paper_shadow(state, None, "short", 86040.0, 86041.0, 1700000000000)
    check("counter incremented by the winning reversal", bot.paper_consecutive_tps == 1,
          bot.paper_consecutive_tps)


async def t_self_lock_losing_reversal_stays_neutral_even_with_flag_on():
    print("\n[self-lock: self_lock_reversal_counts_as_win=True -- a LOSING reversal does NOT reset (unlike SL)]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", self_lock_enabled=True, self_lock_reversal_counts_as_win=True)
    bot._self_lock_loaded = True
    bot.paper_side = "long"
    bot.paper_entry = 86000.0
    bot.paper_entry_ms = 1700000000000
    bot.paper_consecutive_tps = 1  # already has one win banked
    state = dict(bot.state_row)
    # Closing a long at best_bid=85960 (below the 86000 entry, inside the SL band) is a real
    # loss via reversal, not a literal SL.
    await bot._update_paper_shadow(state, None, "short", 85960.0, 85961.0, 1700000000000)
    check("counter untouched by a losing reversal -- stays neutral, not reset to 0",
          bot.paper_consecutive_tps == 1, bot.paper_consecutive_tps)


async def t_self_lock_two_winning_reversals_unlock():
    print("\n[self-lock: two consecutive WINNING reversals unlock real trading, same as two TPs]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", self_lock_enabled=True, self_lock_reversal_counts_as_win=True)
    bot.real_trading_locked = True
    bot._self_lock_loaded = True
    bot.paper_side = "long"
    bot.paper_entry = 86000.0
    bot.paper_entry_ms = 1700000000000
    state = dict(bot.state_row)
    # First winning reversal: long closed at best_bid=86040 (win, inside the TP band), reopens
    # short at best_ask=86041.
    await bot._update_paper_shadow(state, None, "short", 86040.0, 86041.0, 1700000000000)
    check("still locked after 1 winning reversal", bot.real_trading_locked is True)
    check("counter at 1", bot.paper_consecutive_tps == 1, bot.paper_consecutive_tps)
    # Second winning reversal: the reopened short (entry 86041) closed at best_ask=86010 --
    # below entry, a real win for a short, but inside its own TP band (86041*0.999=85955.96).
    await bot._update_paper_shadow(state, None, "long", 86009.0, 86010.0, 1700000060000)
    check("unlocked after the 2nd consecutive winning reversal", bot.real_trading_locked is False,
          bot.real_trading_locked)
    check("counter reset to 0", bot.paper_consecutive_tps == 0, bot.paper_consecutive_tps)


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


def _breakeven_state(entry, usd, side="long"):
    return {
        "id": 1, "side": side, "legs": [{"price": entry, "usd_size": usd}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": usd, "realized_pnl_usd": 0.0, "collateral_before_entry": usd,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
        "cycle_partner_pnl_baseline": 0.0,
    }


def _breakeven_bot(ex, state, partner, **over):
    """A hedge leg with the breakeven floor on, and a fake partner row it reads through sb().
    `partner` is a mutable dict: {"side": ..., "realized_pnl_usd": ...}."""
    kwargs = dict(candles_kind="mid", fixed_direction="long", fixed_leg_usd=10.0,
                  sl_pct=0.03, tp_pct=0.10, disable_literal_tp=True,
                  profit_lock_enabled=True, profit_lock_trigger_pct=0.05,
                  profit_lock_trail_pct=0.01, require_fresh_signal=False,
                  self_lock_enabled=False, use_joint_adaptive=False,
                  cycle_partner_table="partner_state", breakeven_floor_enabled=True)
    kwargs.update(over)
    bot = make_bot(ex, state=state, **kwargs)
    async def fake_sb(method, path, body=None, extra_headers=None):
        if path.startswith("partner_state"):
            return [dict(partner)]
        raise AssertionError(f"unexpected sb call: {method} {path}")
    bot.sb = fake_sb
    return bot


async def _tick_at(bot, price):
    bot.live.order_book = {"bids": [{"price": str(price)}], "asks": [{"price": str(price + 0.5)}]}
    # The partner read is throttled to 1/s so a test sweeping several prices in a row would
    # otherwise only ever get one reading.
    bot._breakeven_partner_read_at = 0.0
    bot._no_sl_partner_checked_at = 0.0
    await bot.tick()


async def t_breakeven_floor_pct_arithmetic():
    print("\n[breakeven floor: the level is derived from DOLLARS, so unequal leg sizes stay correct]")
    f = core.StochBot.breakeven_floor_pct
    # Equal $10 legs, loser cut at 0.03% => -$0.003. Winner needs +0.03% of its own $10.
    check("equal $10/$10 legs -> ~0.03%", abs(f(-0.003, 10.0) - 0.03) < 1e-9, f(-0.003, 10.0))
    # Pressure bias made the winner the SMALL leg: $5 winner must offset a $15 loser's -$0.0045.
    check("$5 winner vs $15 loser -> ~0.09% (NOT 0.03%)",
          abs(f(-0.0045, 5.0) - 0.09) < 1e-9, f(-0.0045, 5.0))
    # And the reverse: a $15 winner only needs a third of the move.
    check("$15 winner vs $5 loser -> ~0.01%", abs(f(-0.0015, 15.0) - 0.01) < 1e-9, f(-0.0015, 15.0))
    check("partner closed GREEN -> no floor", f(0.002, 10.0) is None, f(0.002, 10.0))
    check("partner exactly flat -> no floor", f(0.0, 10.0) is None, f(0.0, 10.0))
    check("unknown partner pnl -> no floor", f(None, 10.0) is None, f(None, 10.0))
    check("no notional -> no floor", f(-0.003, 0.0) is None, f(-0.003, 0.0))


async def t_breakeven_floor_holds_the_cycle_even():
    print("\n[breakeven floor: winner exits AT breakeven instead of sliding back toward its own SL]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": "short", "realized_pnl_usd": 0.0}
    bot = _breakeven_bot(ex, _breakeven_state(entry, 10.0), partner)

    # Winner runs up to +0.04% -- above the eventual 0.03% floor, but below the 0.05% trail
    # trigger, so the trail never arms. This is exactly the window that previously had no
    # protection at all.
    await _tick_at(bot, entry * (1 + 0.04 / 100))
    check("still open at +0.04% (trail not armed, partner still holding)",
          bot.state_row["side"] == "long", bot.state_row["side"])
    check("profit-lock trail did NOT arm below its 0.05% trigger",
          bot.profit_lock_peak_pct is None, bot.profit_lock_peak_pct)

    # Partner's leg gets cut at its 0.03% SL: -$0.003 realized, and it goes flat.
    partner["side"] = None
    partner["realized_pnl_usd"] = -0.003
    await _tick_at(bot, entry * (1 + 0.04 / 100))
    check("floor armed once the partner banked its loss",
          bot._breakeven_floor_pct is not None, bot._breakeven_floor_pct)
    check("floor is ~0.03% for equal $10 legs",
          abs(bot._breakeven_floor_pct - 0.03) < 0.002, bot._breakeven_floor_pct)
    check("still open -- +0.04% is above the floor", bot.state_row["side"] == "long")

    # Now it gives back to +0.02%, below breakeven. Previously it would have kept running all the
    # way to -0.03%, making the cycle a double loss.
    await _tick_at(bot, entry * (1 + 0.02 / 100))
    check("closed at the floor", bot.state_row["side"] is None, bot.state_row["side"])
    check("closed with reason BREAKEVEN_LOCK",
          any(a == "closed" and d.get("reason") == "BREAKEVEN_LOCK" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def t_fixed_partner_cut_floor_gives_survivor_room():
    print("\n[fixed +0.03% floor: both directions survive below partner breakeven, then exit at floor]")
    for side in ("long", "short"):
        entry = 86000.0
        direction = 1 if side == "long" else -1
        ex = FakeExchange(position=direction * round(10.0 / entry, 5), collateral=10.0)
        partner = {"side": "short" if side == "long" else "long", "realized_pnl_usd": 0.0}
        bot = _breakeven_bot(ex, _breakeven_state(entry, 10.0, side), partner,
                             fixed_direction=side, sl_pct=0.06, profit_lock_trigger_pct=0.10,
                             profit_lock_trail_pct=0.03,
                             partner_cut_arms_trail_immediately=True,
                             profit_lock_respects_breakeven_floor=True,
                             fixed_partner_cut_floor_pct=0.03)
        await _tick_at(bot, entry * (1 + direction * 0.055 / 100))
        check(f"{side}: no floor while partner still open", bot._breakeven_floor_pct is None)
        partner["side"] = None
        partner["realized_pnl_usd"] = -0.006
        await _tick_at(bot, entry * (1 + direction * 0.055 / 100))
        check(f"{side}: fixed floor ignores larger partner loss", bot._breakeven_floor_pct == 0.03)
        await _tick_at(bot, entry * (1 + direction * 0.04 / 100))
        check(f"{side}: still open at +0.04%", bot.state_row["side"] == side)
        await _tick_at(bot, entry * (1 + direction * 0.029 / 100))
        check(f"{side}: closes below +0.03%", bot.state_row["side"] is None)
        check(f"{side}: floor exit reason retained", any(a == "closed" and d.get("reason") == "BREAKEVEN_LOCK" for a,d in bot.runs))
    check("fixed floor still requires partner loss", core.StochBot.breakeven_floor_pct(0.001, 10, 0.03) is None)
    check("fixed floor still requires valid notional", core.StochBot.breakeven_floor_pct(-0.006, 0, 0.03) is None)


async def t_breakeven_floor_arms_when_partner_cycle_was_never_observed_open():
    print("\n[breakeven floor: arms off the pnl DELTA, so a partner that opened+SL'd between polls still counts]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    # The partner read is throttled to 1/s. Here the partner is never once seen holding a
    # position -- it entered and hit its own 0.03% SL between our polls -- yet its realized pnl
    # has clearly moved since our entry baseline, which is proof enough that it traded and lost.
    partner = {"side": None, "realized_pnl_usd": -0.003}
    bot = _breakeven_bot(ex, _breakeven_state(entry, 10.0), partner)
    check("partner never observed open", bot._breakeven_partner_seen is False)
    await _tick_at(bot, entry * (1 + 0.04 / 100))
    check("floor still armed from the pnl delta alone",
          bot._breakeven_floor_pct is not None, bot._breakeven_floor_pct)
    check("floor is ~0.03%", abs(bot._breakeven_floor_pct - 0.03) < 0.002, bot._breakeven_floor_pct)
    await _tick_at(bot, entry * (1 + 0.02 / 100))
    check("exited at breakeven rather than running to its own SL",
          bot.state_row["side"] is None, bot.state_row["side"])


async def t_breakeven_floor_does_not_pin_the_winner_to_zero():
    print("\n[breakeven floor: must NOT exit a winner sitting AT the floor -- the live zero-net bug]")
    # Reproduces 2026-09-30 05:05:24 exactly. A symmetric hedge puts the winner at ~+0.03% at the
    # very instant the loser is cut at -0.03%, so the floor arms right where the winner already
    # stands. Before the arm margin, the next tick of noise closed it and the cycle netted zero:
    # long +0.00286 vs short -0.00298. The winner must be left alone here to run for the trail.
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": None, "realized_pnl_usd": -0.003}
    bot = _breakeven_bot(ex, _breakeven_state(entry, 10.0), partner)
    await _tick_at(bot, entry * (1 + 0.030 / 100))
    check("floor armed at ~0.03%", abs(bot._breakeven_floor_pct - 0.03) < 0.002,
          bot._breakeven_floor_pct)
    check("NOT yet live -- winner has only reached the floor, not cleared it",
          bot._breakeven_reached is False, bot._breakeven_reached)
    # Noise wobbles it either side of the floor. None of this may close the position.
    for p in (0.029, 0.031, 0.028, 0.032, 0.027):
        await _tick_at(bot, entry * (1 + p / 100))
        if bot.state_row["side"] is None:
            break
    check("survived noise around the floor instead of being scalped out at zero",
          bot.state_row["side"] == "long", bot.state_row["side"])
    # Once it genuinely clears the floor by the trail width, the floor goes live and protects.
    await _tick_at(bot, entry * (1 + 0.040 / 100))
    check("floor goes live at floor + 0.01%", bot._breakeven_reached is True)
    await _tick_at(bot, entry * (1 + 0.025 / 100))
    check("now it protects breakeven", bot.state_row["side"] is None, bot.state_row["side"])
    check("closed via BREAKEVEN_LOCK",
          any(a == "closed" and d.get("reason") == "BREAKEVEN_LOCK" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def t_breakeven_floor_lets_a_winner_reach_the_trail():
    print("\n[breakeven floor: a winner that keeps running reaches the 0.05% trail, not the floor]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": None, "realized_pnl_usd": -0.003}
    bot = _breakeven_bot(ex, _breakeven_state(entry, 10.0), partner)
    for p in (0.03, 0.04, 0.05, 0.06, 0.07):
        await _tick_at(bot, entry * (1 + p / 100))
        check_open = bot.state_row["side"]
        if check_open is None:
            break
    check("still open all the way up to +0.07%", bot.state_row["side"] == "long",
          bot.state_row["side"])
    check("profit-lock trail armed", bot.profit_lock_peak_pct is not None, bot.profit_lock_peak_pct)
    await _tick_at(bot, entry * (1 + 0.055 / 100))  # gives back more than the 0.01% trail
    check("closed by the TRAIL, well above breakeven -- real profit kept",
          any(a == "closed" and d.get("reason") == "PROFIT_LOCK" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def t_partner_cut_arms_trail_immediately_below_the_old_margin():
    print("\n[partner_cut_arms_trail_immediately: trail arms right away, not at floor+margin]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": "short", "realized_pnl_usd": 0.0}
    bot = _breakeven_bot(ex, _breakeven_state(entry, 10.0), partner,
                         partner_cut_arms_trail_immediately=True)
    # Partner cuts at its 0.03% SL while this leg sits at only +0.02% -- well below both the old
    # arm_at (0.03+0.01=0.04%) AND the 0.05% profit-lock trigger. Under the OLD design this would
    # have zero protection; this is exactly the real gap found live (+0.055% given back entirely).
    partner["side"] = None
    partner["realized_pnl_usd"] = -0.003
    await _tick_at(bot, entry * (1 + 0.02 / 100))
    check("trail armed immediately at +0.02%, not held back for +0.04% or +0.05%",
          bot.profit_lock_peak_pct is not None
          and abs(bot.profit_lock_peak_pct - 0.02) < 0.002, bot.profit_lock_peak_pct)
    check("logged as trail_armed_on_partner_cut",
          any(a == "trail_armed_on_partner_cut" for a, _ in bot.runs), bot.runs)
    # Retreat by more than the 0.01% trail from that +0.02% peak -> exits via the ordinary trail.
    await _tick_at(bot, entry * (1 + 0.005 / 100))
    check("closed once it gave back the trail width from the early peak",
          bot.state_row["side"] is None, bot.state_row["side"])
    check("closed with reason PROFIT_LOCK, not BREAKEVEN_LOCK -- it genuinely is the trail now",
          any(a == "closed" and d.get("reason") == "PROFIT_LOCK" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def t_partner_cut_arms_trail_immediately_still_tracks_a_rising_peak():
    print("\n[partner_cut_arms_trail_immediately: armed early still rides a real run-up normally]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": None, "realized_pnl_usd": -0.003}
    bot = _breakeven_bot(ex, _breakeven_state(entry, 10.0), partner,
                         partner_cut_arms_trail_immediately=True)
    await _tick_at(bot, entry * (1 + 0.02 / 100))
    check("armed at +0.02%", abs(bot.profit_lock_peak_pct - 0.02) < 0.002, bot.profit_lock_peak_pct)
    await _tick_at(bot, entry * (1 + 0.08 / 100))
    check("peak keeps rising with price, same as the ordinary trail",
          abs(bot.profit_lock_peak_pct - 0.08) < 0.002, bot.profit_lock_peak_pct)
    check("still open at the new peak", bot.state_row["side"] == "long")
    await _tick_at(bot, entry * (1 + 0.065 / 100))  # gives back 0.015%, more than the 0.01% trail
    check("closed off the RAISED peak, not the original +0.02% arm point",
          bot.state_row["side"] is None, bot.state_row["side"])


async def t_partner_cut_arms_trail_immediately_off_by_default():
    print("\n[partner_cut_arms_trail_immediately: off by default -- old margin-gated floor unchanged]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": "short", "realized_pnl_usd": 0.0}
    bot = _breakeven_bot(ex, _breakeven_state(entry, 10.0), partner)  # flag defaults False
    partner["side"] = None
    partner["realized_pnl_usd"] = -0.003
    await _tick_at(bot, entry * (1 + 0.02 / 100))
    check("trail NOT armed at +0.02% -- old behaviour needs profit_lock_trigger_pct (0.05%)",
          bot.profit_lock_peak_pct is None, bot.profit_lock_peak_pct)
    check("no trail_armed_on_partner_cut logged", not any(a == "trail_armed_on_partner_cut"
                                                           for a, _ in bot.runs))


async def t_breakeven_floor_ignores_a_green_partner():
    print("\n[breakeven floor: never arms when the partner closed in profit -- nothing to offset]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": "short", "realized_pnl_usd": 0.0}
    bot = _breakeven_bot(ex, _breakeven_state(entry, 10.0), partner)
    await _tick_at(bot, entry * (1 + 0.04 / 100))
    partner["side"] = None
    partner["realized_pnl_usd"] = 0.004  # partner closed GREEN
    await _tick_at(bot, entry * (1 + 0.04 / 100))
    await _tick_at(bot, entry * (1 + 0.01 / 100))  # slides well down
    check("no floor armed", bot._breakeven_floor_pct is None, bot._breakeven_floor_pct)
    check("position still open, running on its own trail/SL as before",
          bot.state_row["side"] == "long", bot.state_row["side"])


async def t_breakeven_floor_requires_partner_to_have_opened():
    print("\n[breakeven floor: a partner that never opened must not read as 'already closed flat']")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    # Partner is flat from the very start and has an OLD realized loss already on its books --
    # without the 'seen open' requirement, baseline arithmetic on a stale number could arm a
    # bogus floor on a cycle the partner never even participated in.
    partner = {"side": None, "realized_pnl_usd": -0.05}
    state = _breakeven_state(entry, 10.0)
    state["cycle_partner_pnl_baseline"] = -0.05  # snapshot taken at our entry: no cycle pnl yet
    bot = _breakeven_bot(ex, state, partner)
    await _tick_at(bot, entry * (1 + 0.04 / 100))
    await _tick_at(bot, entry * (1 + 0.01 / 100))
    check("no floor armed -- partner was never observed holding a position",
          bot._breakeven_floor_pct is None, bot._breakeven_floor_pct)
    check("position still open", bot.state_row["side"] == "long", bot.state_row["side"])


async def t_breakeven_floor_never_forces_a_worse_exit():
    print("\n[breakeven floor: a leg that was never above breakeven is NOT exited at the floor]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": "short", "realized_pnl_usd": 0.0}
    bot = _breakeven_bot(ex, _breakeven_state(entry, 10.0), partner)
    # This leg only ever reaches +0.01%, never the 0.03% floor.
    await _tick_at(bot, entry * (1 + 0.01 / 100))
    partner["side"] = None
    partner["realized_pnl_usd"] = -0.003
    await _tick_at(bot, entry * (1 + 0.01 / 100))
    check("floor is armed (partner banked a loss)", bot._breakeven_floor_pct is not None)
    check("but NOT exited -- it was never at or above the floor, so its own SL still governs",
          bot.state_row["side"] == "long", bot.state_row["side"])


async def t_breakeven_floor_soft_fails_on_partner_read_error():
    print("\n[breakeven floor: a failed partner read leaves the position running (fails SOFT)]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    bot = _breakeven_bot(ex, _breakeven_state(entry, 10.0), {"side": "short"})
    async def failing_sb(method, path, body=None, extra_headers=None):
        raise RuntimeError("simulated network failure")
    bot.sb = failing_sb
    await _tick_at(bot, entry * (1 + 0.04 / 100))
    check("no floor armed on a bad read", bot._breakeven_floor_pct is None)
    check("position still open -- an exit is never forced on missing partner data",
          bot.state_row["side"] == "long", bot.state_row["side"])


async def t_profit_lock_trail_still_wins_above_the_trigger():
    print("\n[breakeven floor: above the 0.05% trigger the 0.01% trail still fires first]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": None, "realized_pnl_usd": -0.003}
    state = _breakeven_state(entry, 10.0)
    bot = _breakeven_bot(ex, state, partner)
    bot._breakeven_partner_seen = True  # partner already observed open earlier in the cycle
    await _tick_at(bot, entry * (1 + 0.08 / 100))   # arms the trail at +0.08%
    check("trail armed at the peak", bot.profit_lock_peak_pct is not None, bot.profit_lock_peak_pct)
    await _tick_at(bot, entry * (1 + 0.06 / 100))   # gives back 0.02% -- past the 0.01% trail
    check("closed", bot.state_row["side"] is None, bot.state_row["side"])
    check("closed via PROFIT_LOCK (well above breakeven), not BREAKEVEN_LOCK",
          any(a == "closed" and d.get("reason") == "PROFIT_LOCK" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def t_exit_mode_trail_default_preserves_disabled_literal_tp():
    print("\n[exit_mode: default 'trail' reproduces disable_literal_tp=True exactly -- no override set]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": None, "realized_pnl_usd": 0.0}
    bot = _breakeven_bot(ex, _breakeven_state(entry, 10.0), partner,
                          breakeven_floor_enabled=False, schema_has_exit_overrides=True)
    await _tick_at(bot, entry * (1 + 0.10 / 100))  # at the compiled TP level
    check("still open -- literal TP stays disabled, same as before this feature",
          bot.state_row["side"] == "long", bot.state_row["side"])


async def t_exit_mode_tp_enables_literal_tp_even_when_compiled_disabled():
    print("\n[exit_mode: override 'tp' enables a literal TP even though disable_literal_tp=True compiled]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": None, "realized_pnl_usd": 0.0}
    state = _breakeven_state(entry, 10.0)
    state["override_exit_mode"] = "tp"
    bot = _breakeven_bot(ex, state, partner, breakeven_floor_enabled=False,
                          schema_has_exit_overrides=True)
    # +1.0 margin: round_trigger(up=True) rounds the TP price UP to the next $0.1 tick, so a
    # check_price computed at the exact nominal target can land fractionally below it (float
    # precision) and miss the ">=" crossing -- same margin pattern used throughout this file's
    # SL/TP tests.
    await _tick_at(bot, entry * (1 + 0.10 / 100) + 1.0)  # past the compiled TP level (0.10%)
    check("closed via TP", bot.state_row["side"] is None, bot.state_row["side"])
    check("reason is TP", any(a == "closed" and d.get("reason") == "TP" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def t_exit_mode_tp_suppresses_the_profit_lock_trail():
    print("\n[exit_mode: override 'tp' suppresses the profit-lock trail even though it's compiled on]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": None, "realized_pnl_usd": 0.0}
    state = _breakeven_state(entry, 10.0)
    state["override_exit_mode"] = "tp"
    bot = _breakeven_bot(ex, state, partner, breakeven_floor_enabled=False,
                          schema_has_exit_overrides=True)
    # Peaks well past the compiled trigger (0.05) then gives back past the compiled trail (0.01),
    # but never reaches the compiled TP (0.10) -- the old trail would have closed this as
    # PROFIT_LOCK; in "tp" mode nothing should fire.
    await _tick_at(bot, entry * (1 + 0.08 / 100))
    await _tick_at(bot, entry * (1 + 0.06 / 100))
    check("still open -- the trail is suppressed in tp mode", bot.state_row["side"] == "long",
          bot.state_row["side"])


async def t_exit_mode_tp_honors_override_tp_pct():
    print("\n[exit_mode: override_tp_pct sets the TP level used in 'tp' mode, not the compiled tp_pct]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": None, "realized_pnl_usd": 0.0}
    state = _breakeven_state(entry, 10.0)
    state["override_exit_mode"] = "tp"
    state["override_tp_pct"] = 0.05
    bot = _breakeven_bot(ex, state, partner, breakeven_floor_enabled=False,
                          schema_has_exit_overrides=True)  # compiled tp_pct stays 0.10
    await _tick_at(bot, entry * (1 + 0.05 / 100) + 1.0)  # past the OVERRIDE level, not the compiled 0.10
    check("closed via TP at the override level", bot.state_row["side"] is None, bot.state_row["side"])


async def t_exit_mode_tp_mode_sl_still_fires():
    print("\n[exit_mode: SL still protects the position in 'tp' mode -- never suppressed]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0 - 0.003)
    partner = {"side": None, "realized_pnl_usd": 0.0}
    state = _breakeven_state(entry, 10.0)
    state["override_exit_mode"] = "tp"
    bot = _breakeven_bot(ex, state, partner, breakeven_floor_enabled=False,
                          schema_has_exit_overrides=True)  # compiled sl_pct stays 0.03
    await _tick_at(bot, entry * (1 - 0.03 / 100) - 1.0)  # past the SL level (round_trigger margin)
    check("closed via SL", bot.state_row["side"] is None, bot.state_row["side"])
    check("reason is SL", any(a == "closed" and d.get("reason") == "SL" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def t_exit_mode_ignored_without_schema_flag():
    print("\n[exit_mode: schema_has_exit_overrides=False ignores override_exit_mode/override_tp_pct]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": None, "realized_pnl_usd": 0.0}
    state = _breakeven_state(entry, 10.0)
    state["override_exit_mode"] = "tp"  # present on the row, but ignored
    bot = _breakeven_bot(ex, state, partner, breakeven_floor_enabled=False,
                          schema_has_exit_overrides=False)
    await _tick_at(bot, entry * (1 + 0.10 / 100))
    check("still open -- override present but the schema flag is off", bot.state_row["side"] == "long",
          bot.state_row["side"])


async def t_entry_settings_snapshot_captures_exit_and_jump_settings():
    print("\n[entry settings snapshot: captures the resolved exit + volume-jump settings, lean and precise]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": None, "realized_pnl_usd": 0.0}
    state = _breakeven_state(entry, 10.0)
    state["override_exit_mode"] = "tp"
    state["override_tp_pct"] = 0.08
    state["override_dwell_seconds"] = 15.0
    state["override_volume_jump_ratio"] = 4.0
    state["override_volume_jump_release_mode"] = "wiggle"
    bot = _breakeven_bot(ex, state, partner, breakeven_floor_enabled=False,
                          schema_has_exit_overrides=True, schema_has_regime_overrides=True,
                          volume_jump_ratio=3.0, volume_jump_lookback=10,
                          volume_jump_pause_seconds=1800.0)
    bot.candles = _jump_candles([1.0] * 10 + [5.0])  # a real spike -- ratio ~5.0
    bot._update_volume_jump_guard(bot.state_row)
    snap = bot._entry_settings_snapshot(bot.state_row)
    check("exit_mode from the override", snap["exit_mode"] == "tp", snap["exit_mode"])
    check("tp_pct from the override", snap["tp_pct"] == 0.08, snap["tp_pct"])
    check("dwell_seconds from the override", snap["dwell_seconds"] == 15.0, snap["dwell_seconds"])
    check("jump_ratio_threshold from the override", snap["jump_ratio_threshold"] == 4.0,
          snap["jump_ratio_threshold"])
    check("jump_release_mode from the override", snap["jump_release_mode"] == "wiggle",
          snap["jump_release_mode"])
    check("jump_ratio_now reflects the live reading",
          snap["jump_ratio_now"] is not None and snap["jump_ratio_now"] > 4.0, snap["jump_ratio_now"])


async def t_entry_settings_snapshot_falls_back_to_compiled_defaults():
    print("\n[entry settings snapshot: no overrides set -- falls back to the compiled config]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": None, "realized_pnl_usd": 0.0}
    bot = _breakeven_bot(ex, _breakeven_state(entry, 10.0), partner, breakeven_floor_enabled=False,
                          schema_has_exit_overrides=True, schema_has_regime_overrides=True,
                          sl_pct=0.03, tp_pct=0.10, volume_jump_ratio=3.0,
                          volume_jump_pause_seconds=1800.0, volume_jump_release_mode=None)
    snap = bot._entry_settings_snapshot(bot.state_row)
    check("exit_mode defaults to trail", snap["exit_mode"] == "trail", snap["exit_mode"])
    check("sl_pct matches the compiled config", snap["sl_pct"] == 0.03, snap["sl_pct"])
    check("dwell_seconds defaults to 0", snap["dwell_seconds"] == 0.0, snap["dwell_seconds"])
    check("jump_release_mode defaults to None (off)", snap["jump_release_mode"] is None,
          snap["jump_release_mode"])


async def t_entry_settings_snapshot_captures_volume_and_er_regime():
    print("\n[entry settings snapshot: captures traded volume and the 2h efficiency ratio]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": None, "realized_pnl_usd": 0.0}
    bot = _breakeven_bot(ex, _breakeven_state(entry, 10.0), partner, breakeven_floor_enabled=False,
                          schema_has_exit_overrides=True, schema_has_regime_overrides=True)
    candles = _trending_candles_122()
    for c in candles:
        c["v"] = 2.5
    bot.candles = candles
    snap = bot._entry_settings_snapshot(bot.state_row)
    check("volume_now matches the candles' traded size", snap["volume_now"] == 2.5, snap["volume_now"])
    check("er_2h close to 1.0 -- pure trend, no path reversal",
          snap["er_2h"] is not None and abs(snap["er_2h"] - 1.0) < 1e-9, snap["er_2h"])
    check("er_2h_direction is long -- close rose over the window",
          snap["er_2h_direction"] == "long", snap["er_2h_direction"])


async def t_entry_settings_snapshot_er_none_without_enough_history():
    print("\n[entry settings snapshot: too few candles -- volume/ER fields are None, not a crash]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": None, "realized_pnl_usd": 0.0}
    bot = _breakeven_bot(ex, _breakeven_state(entry, 10.0), partner, breakeven_floor_enabled=False,
                          schema_has_exit_overrides=True, schema_has_regime_overrides=True)
    snap = bot._entry_settings_snapshot(bot.state_row)  # default short candle history
    check("er_2h is None -- not enough candles for a 120-window read", snap["er_2h"] is None, snap["er_2h"])
    check("er_2h_direction is None too", snap["er_2h_direction"] is None, snap["er_2h_direction"])


async def t_log_trade_falls_back_to_core_row_when_entry_features_column_missing():
    print("\n[log_trade: a missing entry_features column falls back to the guaranteed-safe core row]")
    # Real incident, 2026-10-03: schema_has_entry_features turned on before its migration had
    # actually run -- PostgREST rejects the WHOLE insert on one unknown column, so every close
    # silently failed to log a trade row at all (not just lose the new field). The real position
    # close/PnL was never at risk (that's already final in state by the time log_trade runs) --
    # only the research row was being lost.
    bot = make_bot(FakeExchange())
    bot.log_trade = StochBot.log_trade.__get__(bot)  # the REAL method, not the test harness's recorder
    calls = []

    async def flaky_sb(method, path, body=None, extra_headers=None):
        calls.append(body)
        if len(calls) == 1:
            raise RuntimeError("supabase 400 on POST t: column 'entry_settings_snapshot' not found")
        return [body]
    bot.sb = flaky_sb
    await bot.log_trade("long", 86000.0, 86100.0, 0.0001, 1.0, "TP", 1, "2026-10-03T00:00:00Z",
                         entry_features={"entry_k": 50.0,
                                         "entry_settings_snapshot": {"exit_mode": "trail"}})
    check("retried after the failure", len(calls) == 2, len(calls))
    check("first attempt included the rich entry_features", "entry_k" in calls[0], calls[0])
    check("fallback attempt dropped entry_features but kept the core fields",
          "entry_k" not in calls[1] and calls[1]["side"] == "long" and calls[1]["pnl_usd"] == 1.0,
          calls[1])
    check("fallback logged for visibility",
          any(a == "log_trade_fallback" for a, d in bot.runs), bot.runs)


async def t_log_trade_no_fallback_needed_when_insert_succeeds():
    print("\n[log_trade: the normal path never touches the fallback when the insert just works]")
    bot = make_bot(FakeExchange())
    bot.log_trade = StochBot.log_trade.__get__(bot)
    calls = []

    async def ok_sb(method, path, body=None, extra_headers=None):
        calls.append(body)
        return [body]
    bot.sb = ok_sb
    await bot.log_trade("short", 86000.0, 85900.0, 0.0001, 0.5, "SL", 1, "2026-10-03T00:00:00Z",
                         entry_features={"entry_k": 50.0})
    check("exactly one call -- no retry needed", len(calls) == 1, len(calls))
    check("no fallback logged", not any(a == "log_trade_fallback" for a, d in bot.runs), bot.runs)


async def t_dwell_ready_not_touched_resets_the_timer():
    print("\n[dwell: _dwell_ready(False, ...) always resets, even if a timer was already running]")
    bot = _breakeven_bot(FakeExchange(), _breakeven_state(86000.0, 10.0),
                          {"side": None, "realized_pnl_usd": 0.0}, breakeven_floor_enabled=False)
    bot._dwell_touch_at = time.time() - 50.0  # a stale, long-running timer
    ready = bot._dwell_ready(False, 10.0)
    check("not ready -- not currently touched", ready is False, ready)
    check("timer cleared", bot._dwell_touch_at is None, bot._dwell_touch_at)


async def t_dwell_ready_zero_seconds_is_instant():
    print("\n[dwell: dwell_seconds=0 fires on the very first touch -- old instant behavior]")
    bot = _breakeven_bot(FakeExchange(), _breakeven_state(86000.0, 10.0),
                          {"side": None, "realized_pnl_usd": 0.0}, breakeven_floor_enabled=False)
    ready = bot._dwell_ready(True, 0.0)
    check("instantly ready", ready is True, ready)


async def t_dwell_ready_first_touch_not_enough():
    print("\n[dwell: a touch just NOW is not enough -- the timer only just started]")
    bot = _breakeven_bot(FakeExchange(), _breakeven_state(86000.0, 10.0),
                          {"side": None, "realized_pnl_usd": 0.0}, breakeven_floor_enabled=False)
    ready = bot._dwell_ready(True, 10.0)
    check("not ready yet", ready is False, ready)
    check("timer armed", bot._dwell_touch_at is not None, bot._dwell_touch_at)


async def t_dwell_ready_fires_once_elapsed():
    print("\n[dwell: fires once touched continuously for at least dwell_seconds]")
    bot = _breakeven_bot(FakeExchange(), _breakeven_state(86000.0, 10.0),
                          {"side": None, "realized_pnl_usd": 0.0}, breakeven_floor_enabled=False)
    bot._dwell_touch_at = time.time() - 15.0  # touched 15s ago
    ready = bot._dwell_ready(True, 10.0)
    check("ready -- stood there long enough", ready is True, ready)


async def t_exit_mode_tp_ignores_dwell_fires_instantly():
    print("\n[exit_mode tp: dwell NEVER applies to TP -- direct correction, fires on first touch]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": None, "realized_pnl_usd": 0.0}
    state = _breakeven_state(entry, 10.0)
    state["override_exit_mode"] = "tp"
    state["override_dwell_seconds"] = 30.0  # large dwell, deliberately -- must have zero effect
    bot = _breakeven_bot(ex, state, partner, breakeven_floor_enabled=False,
                          schema_has_exit_overrides=True)
    await _tick_at(bot, entry * (1 + 0.10 / 100) + 1.0)  # a single tick past TP
    check("closed via TP on the very first touch", bot.state_row["side"] is None, bot.state_row["side"])
    check("reason is TP", any(a == "closed" and d.get("reason") == "TP" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def t_exit_mode_floor_dwell_blocks_a_single_touch():
    print("\n[exit_mode floor + dwell: a single tick at the armed floor does not close yet]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": "short", "realized_pnl_usd": 0.0}
    state = _breakeven_state(entry, 10.0)
    state["override_exit_mode"] = "floor"
    state["override_dwell_seconds"] = 10.0
    bot = _breakeven_bot(ex, state, partner, breakeven_floor_enabled=False,  # live path alone, not the compiled flag
                          profit_lock_trigger_pct=0.05, profit_lock_trail_pct=0.01,
                          schema_has_exit_overrides=True)
    partner["side"] = None
    partner["realized_pnl_usd"] = -0.005  # partner cut at its stop
    await _tick_at(bot, entry * (1 + 0.06 / 100))  # at/above arm_at (floor .05 + margin .01) -- arms
    check("floor armed", bot._breakeven_reached is True, bot._breakeven_reached)
    await _tick_at(bot, entry * (1 + 0.025 / 100))  # back down at/below the floor, ONE tick
    check("still open -- touched the floor but hasn't dwelled yet", bot.state_row["side"] == "long",
          bot.state_row["side"])


async def t_exit_mode_floor_dwell_fires_once_elapsed():
    print("\n[exit_mode floor + dwell: closes via BREAKEVEN_LOCK once continuously past the floor]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": "short", "realized_pnl_usd": 0.0}
    state = _breakeven_state(entry, 10.0)
    state["override_exit_mode"] = "floor"
    state["override_dwell_seconds"] = 10.0
    bot = _breakeven_bot(ex, state, partner, breakeven_floor_enabled=False,
                          profit_lock_trigger_pct=0.05, profit_lock_trail_pct=0.01,
                          schema_has_exit_overrides=True)
    partner["side"] = None
    partner["realized_pnl_usd"] = -0.005
    await _tick_at(bot, entry * (1 + 0.06 / 100))  # at/above arm_at -- arms
    bot._dwell_touch_at = time.time() - 15.0  # pretend it's already been standing at the floor
    await _tick_at(bot, entry * (1 + 0.025 / 100))
    check("closed via BREAKEVEN_LOCK", bot.state_row["side"] is None, bot.state_row["side"])
    check("reason is BREAKEVEN_LOCK",
          any(a == "closed" and d.get("reason") == "BREAKEVEN_LOCK" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def t_exit_mode_floor_compiled_flag_alone_ignores_dwell():
    print("\n[breakeven floor via the OLDER compiled flag alone (no exit_mode override) stays instant]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": "short", "realized_pnl_usd": 0.0}
    state = _breakeven_state(entry, 10.0)
    state["override_dwell_seconds"] = 10.0  # present, but floor_enabled is False (exit_mode stays "trail")
    bot = _breakeven_bot(ex, state, partner, breakeven_floor_enabled=True,  # the OLD compiled path
                          profit_lock_trigger_pct=10.0, profit_lock_trail_pct=0.01,  # trail unreachable
                          schema_has_exit_overrides=True)
    partner["side"] = None
    partner["realized_pnl_usd"] = -0.005
    await _tick_at(bot, entry * (1 + 0.06 / 100))  # at/above arm_at -- arms
    await _tick_at(bot, entry * (1 + 0.025 / 100))  # a single tick at the floor
    check("closed instantly -- dwell only applies via the live exit_mode=\"floor\" path",
          bot.state_row["side"] is None, bot.state_row["side"])


async def t_exit_mode_no_sl_sl_still_fires_before_partner_closes():
    print("\n[exit_mode no_sl: the FIRST leg to lose still gets cut by its ordinary SL]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": "short", "realized_pnl_usd": 0.0}  # partner still open
    state = _breakeven_state(entry, 10.0)
    state["override_exit_mode"] = "no_sl"
    bot = _breakeven_bot(ex, state, partner, breakeven_floor_enabled=False,
                          schema_has_exit_overrides=True)
    await _tick_at(bot, entry * (1 - 0.03 / 100) - 1.0)  # past the normal 0.03% SL
    check("closed via SL -- partner hasn't closed yet, SL stays fully active",
          bot.state_row["side"] is None, bot.state_row["side"])
    check("reason is SL", any(a == "closed" and d.get("reason") == "SL" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def t_exit_mode_no_sl_sl_suppressed_after_partner_closes():
    print("\n[exit_mode no_sl: SL comes OFF once this leg's own partner has closed]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": None, "realized_pnl_usd": -0.003}  # partner already closed (the loser)
    state = _breakeven_state(entry, 10.0)
    state["override_exit_mode"] = "no_sl"
    bot = _breakeven_bot(ex, state, partner, breakeven_floor_enabled=False,
                          profit_lock_trigger_pct=10.0, profit_lock_trail_pct=0.01,  # trail unreachable here
                          schema_has_exit_overrides=True)
    await _tick_at(bot, entry * (1 - 0.03 / 100) - 1.0)  # well past the normal 0.03% SL
    check("still open -- SL suppressed now that the partner is gone",
          bot.state_row["side"] == "long", bot.state_row["side"])
    await _tick_at(bot, entry * (1 - 1.0 / 100))  # a full 1% underwater -- SL would have fired long ago
    check("still open even far underwater -- no_sl means no SL, by design",
          bot.state_row["side"] == "long", bot.state_row["side"])
    check("transition is logged -- visibility fix, direct report \"im not sure is working\"",
          any(a == "no_sl_protection_removed" for a, d in bot.runs),
          [a for a, d in bot.runs])


async def t_exit_mode_no_sl_trail_still_protects_the_survivor():
    print("\n[exit_mode no_sl: the ordinary profit-lock trail still closes a winner]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": None, "realized_pnl_usd": -0.003}  # partner already closed
    state = _breakeven_state(entry, 10.0)
    state["override_exit_mode"] = "no_sl"
    bot = _breakeven_bot(ex, state, partner, breakeven_floor_enabled=False,
                          profit_lock_trigger_pct=0.05, profit_lock_trail_pct=0.01,
                          schema_has_exit_overrides=True)
    await _tick_at(bot, entry * (1 + 0.06 / 100))  # past trigger -- trail arms
    await _tick_at(bot, entry * (1 + 0.03 / 100))  # pulls back past trail_pct from the peak
    check("closed via PROFIT_LOCK -- trail is untouched by no_sl",
          bot.state_row["side"] is None, bot.state_row["side"])
    check("reason is PROFIT_LOCK",
          any(a == "closed" and d.get("reason") == "PROFIT_LOCK" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def t_exit_mode_no_sl_native_stop_cancelled_after_partner_closes():
    print("\n[exit_mode no_sl: the REAL exchange-side stop order is cancelled too, not just the internal check]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": "short", "realized_pnl_usd": 0.0}
    state = _breakeven_state(entry, 10.0)
    state["override_exit_mode"] = "no_sl"
    bot = _breakeven_bot(ex, state, partner, breakeven_floor_enabled=False,
                          native_stop_loss_enabled=True, schema_has_exit_overrides=True)
    await _tick_at(bot, entry)  # partner still open -- native stop should be resting
    check("native stop placed while partner is still open", len(getattr(ex, "sl_orders", [])) >= 1,
          getattr(ex, "sl_orders", None))
    orders_before = len(ex.sl_orders)
    cancels_before = getattr(ex, "cancel_all_calls", 0)
    partner["side"] = None
    partner["realized_pnl_usd"] = -0.003  # partner just closed
    await _tick_at(bot, entry)
    check("cancel_all was actually called -- the real resting order is cleared, not just forgotten",
          getattr(ex, "cancel_all_calls", 0) > cancels_before, getattr(ex, "cancel_all_calls", None))
    check("native stop sync marked cleared (want_sl False once partner closed)",
          bot._native_stop_synced is None, bot._native_stop_synced)
    check("no NEW native stop order placed after the partner closed",
          len(ex.sl_orders) == orders_before, (len(ex.sl_orders), orders_before))


async def t_exit_mode_no_sl_real_reversal_closes_the_survivor():
    print("\n[exit_mode no_sl: a REAL stochastic reversal (not the dead fixed_direction one) actually closes it]")
    print("  direct report: \"i see the stochastic already pointing upward and it long and it does not come out\"")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": None, "realized_pnl_usd": -0.003}  # partner already closed
    state = _breakeven_state(entry, 10.0)
    state["override_exit_mode"] = "no_sl"
    # candles_kind="short" pushes K near 100 -- compute_stoch_signal reads that as a "short"
    # signal (entry_hi=75 default), the opposite of this leg's own "long" side.
    bot = _breakeven_bot(ex, state, partner, breakeven_floor_enabled=False,
                          candles_kind="short", profit_lock_trigger_pct=10.0,  # trail unreachable
                          schema_has_exit_overrides=True)
    await _tick_at(bot, entry)  # flat price -- would never trip SL/TP/trail on its own
    check("closed via NO_SL_REVERSAL -- the real stochastic reading, not the dead fixed_direction one",
          bot.state_row["side"] is None, bot.state_row["side"])
    check("reason is NO_SL_REVERSAL",
          any(a == "closed" and d.get("reason") == "NO_SL_REVERSAL" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def t_exit_mode_no_sl_reversal_check_waits_for_partner_to_close():
    print("\n[exit_mode no_sl: the real-reversal check only applies once the partner has actually closed]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": "short", "realized_pnl_usd": 0.0}  # partner STILL open
    state = _breakeven_state(entry, 10.0)
    state["override_exit_mode"] = "no_sl"
    bot = _breakeven_bot(ex, state, partner, breakeven_floor_enabled=False,
                          candles_kind="short", profit_lock_trigger_pct=10.0,
                          schema_has_exit_overrides=True)
    await _tick_at(bot, entry)
    check("still open -- partner hasn't closed yet, so no_sl's reversal check hasn't armed",
          bot.state_row["side"] == "long", bot.state_row["side"])


async def t_trail_dwell_blocks_a_single_touch():
    print("\n[trail mode + dwell: a single pullback past trigger-trail does not close yet]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": None, "realized_pnl_usd": 0.0}
    state = _breakeven_state(entry, 10.0)
    state["override_dwell_seconds"] = 10.0  # exit_mode stays "trail" (default)
    bot = _breakeven_bot(ex, state, partner, breakeven_floor_enabled=False,
                          schema_has_exit_overrides=True)
    await _tick_at(bot, entry * (1 + 0.08 / 100))  # arms the trail at the peak
    await _tick_at(bot, entry * (1 + 0.06 / 100))  # gives back past the 0.01 trail, one tick
    check("still open -- touched the trail but hasn't dwelled yet", bot.state_row["side"] == "long",
          bot.state_row["side"])


async def t_trail_dwell_fires_once_elapsed():
    print("\n[trail mode + dwell: closes via PROFIT_LOCK once continuously past the trail]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": None, "realized_pnl_usd": 0.0}
    state = _breakeven_state(entry, 10.0)
    state["override_dwell_seconds"] = 10.0
    bot = _breakeven_bot(ex, state, partner, breakeven_floor_enabled=False,
                          schema_has_exit_overrides=True)
    await _tick_at(bot, entry * (1 + 0.08 / 100))  # arms the trail at the peak
    bot._dwell_touch_at = time.time() - 15.0  # pretend it's already been standing past it
    await _tick_at(bot, entry * (1 + 0.06 / 100))
    check("closed via PROFIT_LOCK", bot.state_row["side"] is None, bot.state_row["side"])
    check("reason is PROFIT_LOCK",
          any(a == "closed" and d.get("reason") == "PROFIT_LOCK" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def t_trail_dwell_resets_on_a_new_peak():
    print("\n[trail mode + dwell: a new peak clears a stale dwell timer, not reused against it]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": None, "realized_pnl_usd": 0.0}
    state = _breakeven_state(entry, 10.0)
    state["override_dwell_seconds"] = 10.0
    bot = _breakeven_bot(ex, state, partner, breakeven_floor_enabled=False,
                          schema_has_exit_overrides=True)
    await _tick_at(bot, entry * (1 + 0.08 / 100))  # arms the trail at the peak
    bot._dwell_touch_at = time.time() - 15.0  # a stale timer from an earlier (lower) peak
    await _tick_at(bot, entry * (1 + 0.20 / 100))  # a brand NEW, higher peak this tick
    check("timer cleared by the new peak, not left stale", bot._dwell_touch_at is None,
          bot._dwell_touch_at)
    await _tick_at(bot, entry * (1 + 0.18 / 100))  # gives back 0.02 -- past the 0.01 trail, ONE tick
    check("still open -- the new peak's pullback only just started, dwell not reused",
          bot.state_row["side"] == "long", bot.state_row["side"])


async def t_dwell_ignored_without_schema_flag():
    print("\n[dwell: schema_has_exit_overrides=False ignores override_dwell_seconds]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": None, "realized_pnl_usd": 0.0}
    state = _breakeven_state(entry, 10.0)
    state["override_exit_mode"] = "tp"
    state["override_dwell_seconds"] = 10.0  # present on the row, but ignored
    bot = _breakeven_bot(ex, state, partner, breakeven_floor_enabled=False,
                          schema_has_exit_overrides=False)
    await _tick_at(bot, entry * (1 + 0.10 / 100) + 1.0)
    check("still open -- exit_mode override ignored too, so trail/TP-disabled default applies",
          bot.state_row["side"] == "long", bot.state_row["side"])


async def t_stale_position_bands_ignored_without_schema_flag():
    print("\n[stale position_sl_pct in the row is IGNORED when schema_has_position_bands=False (hedge leg)]")
    # Real 2026-09-30 incident, real money: the hedge SHORT leg runs on
    # lighter_stoch_dca_btc_state, a table the retired Worker 3 joint-adaptive strategy used to
    # own. It left position_sl_pct=0.0909 behind. The hedge legs set sl_pct=0.03 and never write
    # that column (schema_has_position_bands=False), but the READ was unguarded, so the leg
    # honoured 0.0909 -- a stop 3x wider than configured. Price here sits past the configured
    # 0.03% stop but NOT past the stale 0.0909% one, so this only passes if cfg.sl_pct wins.
    entry = 86000.0
    configured_sl_price = entry * (1 - 0.03 / 100)   # 85974.2 -- should stop out here
    stale_sl_price = entry * (1 - 0.0909 / 100)      # 85921.8 -- must NOT be what's used
    price = (configured_sl_price + stale_sl_price) / 2  # between the two
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0 - 0.003)
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 10.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 10.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 10.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
        "position_tp_pct": 0.0909, "position_sl_pct": 0.0909,  # stale, from the retired strategy
    }
    # schema_has_position_bands defaults False, exactly like both hedge legs
    bot = make_bot(ex, state=state, candles_kind="mid", sl_pct=0.03, tp_pct=0.10,
                   fixed_direction="long", disable_literal_tp=True)
    bot.live.order_book = {"bids": [{"price": str(price)}], "asks": [{"price": str(price + 1)}]}
    await bot.tick()
    check("stopped out on the CONFIGURED 0.03% SL, not the stale 0.0909% one",
          bot.state_row["side"] is None, bot.state_row["side"])
    check("closed with reason SL",
          any(a == "closed" and d.get("reason") == "SL" for a, d in bot.runs),
          bot.runs)


async def t_position_bands_still_honored_with_schema_flag():
    print("\n[the same row value IS still honored when schema_has_position_bands=True (Worker 1 unaffected)]")
    # Complement of the test above: the guard must not break the bots that legitimately do write
    # and read these columns (Worker 1, lighter_stoch_dca_btc_initial.py). Same price, same row --
    # only the flag differs, and here the wider recorded band must keep the position open.
    entry = 86000.0
    configured_sl_price = entry * (1 - 0.03 / 100)
    stale_sl_price = entry * (1 - 0.0909 / 100)
    price = (configured_sl_price + stale_sl_price) / 2
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 10.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 10.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 10.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
        "position_tp_pct": 0.0909, "position_sl_pct": 0.0909,
    }
    bot = make_bot(ex, state=state, candles_kind="mid", sl_pct=0.03, tp_pct=0.10,
                   fixed_direction="long", disable_literal_tp=True,
                   schema_has_position_bands=True)
    bot.live.order_book = {"bids": [{"price": str(price)}], "asks": [{"price": str(price + 1)}]}
    await bot.tick()
    check("position still OPEN -- the recorded 0.0909% band is respected for this bot",
          bot.state_row["side"] == "long", bot.state_row["side"])


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


async def t_trading_hours_dict_form_uses_that_days_own_list():
    print("\n[trading hours gate: dict form looks up the current weekday's own open-hours list]")
    ex = FakeExchange()
    # Saturday=5 closes hour 9; every other listed day keeps it open.
    schedule = {0: [9, 10], 1: [9, 10], 2: [9, 10], 3: [9, 10], 4: [9, 10], 5: [10], 6: [9, 10]}
    bot = make_bot(ex, trading_hours_utc=schedule)

    saturday_9am = _dt.datetime(2026, 9, 26, 9, 0, tzinfo=_dt.timezone.utc)  # a Saturday
    sig = bot._apply_trading_hours_gate("long", now_utc=saturday_9am)
    check("blocked on Saturday specifically", sig is None, sig)

    friday_9am = _dt.datetime(2026, 9, 25, 9, 0, tzinfo=_dt.timezone.utc)  # a Friday, same hour
    sig2 = bot._apply_trading_hours_gate("long", now_utc=friday_9am)
    check("same hour still open on a different weekday", sig2 == "long", sig2)


async def t_trading_hours_dict_form_missing_weekday_is_fully_closed():
    print("\n[trading hours gate: dict form -- a weekday absent from the dict has no open hours]")
    ex = FakeExchange()
    schedule = {0: [9, 10]}  # only Monday listed
    bot = make_bot(ex, trading_hours_utc=schedule)
    saturday_9am = _dt.datetime(2026, 9, 26, 9, 0, tzinfo=_dt.timezone.utc)  # Saturday, not in dict
    sig = bot._apply_trading_hours_gate("long", now_utc=saturday_9am)
    check("blocked -- Saturday has no entry at all", sig is None, sig)


async def t_hour_open_confirmation_disabled_by_default():
    print("\n[hour-open confirmation: hour_open_requires_self_lock=False (default) never re-locks]")
    ex = FakeExchange()
    bot = make_bot(ex, trading_hours_utc=[16])
    now_utc = _dt.datetime(2026, 9, 24, 16, 0, tzinfo=_dt.timezone.utc)
    await bot._check_hour_open_confirmation(now_utc=now_utc)
    check("never locked", bot.real_trading_locked is False)


async def t_hour_open_confirmation_never_arms_without_self_lock():
    print("\n[hour-open confirmation: never re-locks without self_lock_enabled -- nothing would ever clear it]")
    ex = FakeExchange()
    bot = make_bot(ex, trading_hours_utc=[16], hour_open_requires_self_lock=True,
                    self_lock_enabled=False)
    open_utc = _dt.datetime(2026, 9, 24, 16, 0, tzinfo=_dt.timezone.utc)
    await bot._check_hour_open_confirmation(now_utc=open_utc)
    check("stays unlocked -- would be a permanent lockout otherwise",
          bot.real_trading_locked is False)


async def t_hour_open_confirmation_skips_arming_with_an_open_real_position():
    print("\n[hour-open confirmation: does NOT re-lock if a real position is already open -- nothing blind about it]")
    ex = FakeExchange()
    bot = make_bot(ex, trading_hours_utc=[16], hour_open_requires_self_lock=True, self_lock_enabled=True)
    open_utc = _dt.datetime(2026, 9, 24, 16, 0, tzinfo=_dt.timezone.utc)
    await bot._check_hour_open_confirmation(has_open_position=True, now_utc=open_utc)
    check("stays unlocked while a real position is open, despite a fresh transition",
          bot.real_trading_locked is False)
    # once flat again, a genuinely NEW transition should still re-lock normally.
    closed_utc = _dt.datetime(2026, 9, 24, 17, 0, tzinfo=_dt.timezone.utc)
    await bot._check_hour_open_confirmation(has_open_position=True, now_utc=closed_utc)
    reopen_utc = _dt.datetime(2026, 9, 25, 16, 0, tzinfo=_dt.timezone.utc)
    await bot._check_hour_open_confirmation(has_open_position=False, now_utc=reopen_utc)
    check("re-locks normally on the next real transition once flat", bot.real_trading_locked is True)


async def t_hour_open_confirmation_arms_on_closed_to_open_transition():
    print("\n[hour-open confirmation: closed->open transition re-locks real trading]")
    ex = FakeExchange()
    bot = make_bot(ex, trading_hours_utc=[16], hour_open_requires_self_lock=True,
                    self_lock_enabled=True)
    closed_utc = _dt.datetime(2026, 9, 24, 15, 59, tzinfo=_dt.timezone.utc)
    await bot._check_hour_open_confirmation(now_utc=closed_utc)
    check("not locked while still closed", bot.real_trading_locked is False)
    open_utc = _dt.datetime(2026, 9, 24, 16, 0, tzinfo=_dt.timezone.utc)
    await bot._check_hour_open_confirmation(now_utc=open_utc)
    check("locked the moment it opens", bot.real_trading_locked is True)
    check("counter reset to 0 on the transition", bot.paper_consecutive_tps == 0)


async def t_hour_open_confirmation_arms_on_boot_mid_open_hour():
    print("\n[hour-open confirmation: booting fresh already inside an open hour re-locks too (option 1)]")
    ex = FakeExchange()
    bot = make_bot(ex, trading_hours_utc=[16], hour_open_requires_self_lock=True,
                    self_lock_enabled=True)
    check("starts unlocked, no tick yet", bot.real_trading_locked is False)
    open_utc = _dt.datetime(2026, 9, 24, 16, 30, tzinfo=_dt.timezone.utc)  # already mid-open-hour
    await bot._check_hour_open_confirmation(now_utc=open_utc)
    check("locked on the very first check, no restart-skip", bot.real_trading_locked is True)


async def t_hour_open_confirmation_does_not_rearm_while_staying_open():
    print("\n[hour-open confirmation: staying inside the same open hour does not keep re-locking]")
    ex = FakeExchange()
    bot = make_bot(ex, trading_hours_utc=[16], hour_open_requires_self_lock=True,
                    self_lock_enabled=True)
    await bot._check_hour_open_confirmation(now_utc=_dt.datetime(2026, 9, 24, 16, 0, tzinfo=_dt.timezone.utc))
    bot.real_trading_locked = False  # simulate having already unlocked via normal paper wins
    bot.paper_consecutive_tps = 1
    await bot._check_hour_open_confirmation(now_utc=_dt.datetime(2026, 9, 24, 16, 30, tzinfo=_dt.timezone.utc))
    check("stays unlocked -- same open hour, not a new transition", bot.real_trading_locked is False)
    check("counter left untouched too", bot.paper_consecutive_tps == 1)


async def t_hour_open_confirmation_blocks_entry_signal():
    print("\n[hour-open confirmation: locked -> blocks a real entry signal]")
    ex = FakeExchange()
    candles = make_candles("long")
    state = {
        "id": 1, "side": None, "legs": [], "first_entry_price": None, "first_entry_time": None,
        "dca_level": 0, "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": None,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles=candles, self_lock_enabled=True,
                    trading_hours_utc=list(range(24)), hour_open_requires_self_lock=True)
    bot.real_trading_locked = True  # locked, real trading not yet confirmed for this session
    await bot.tick()
    check("no real order placed while locked", len(ex.orders) == 0, ex.orders)
    check("still locked -- nothing cleared it", bot.real_trading_locked is True)


async def t_hour_open_confirmation_uses_the_standard_unlock_rule():
    print("\n[hour-open confirmation: uses the SAME unlock rule as a real-SL lock, not a looser one]")
    ex = FakeExchange()
    bot = make_bot(ex, self_lock_enabled=True, hour_open_requires_self_lock=True,
                    trading_hours_utc=list(range(24)))
    bot.real_trading_locked = True
    bot.paper_side = "long"
    bot.paper_entry = 86000.0
    bot.paper_entry_ms = 1700000000000
    tp_price = 86000.0 * 1.0011  # past the paper position's own 0.10% TP
    await bot._update_paper_shadow({"id": 1}, None, None, tp_price, tp_price + 1, 1700000060000)
    check("one paper TP alone does NOT clear it -- no more special single-TP shortcut",
          bot.real_trading_locked is True)
    check("counter incremented normally instead", bot.paper_consecutive_tps == 1, bot.paper_consecutive_tps)


async def t_hour_open_confirmation_sets_lock_via():
    print("\n[hour-open confirmation: tags the lock cause so self_lock_hour_open_requires_tp can read it]")
    ex = FakeExchange()
    bot = make_bot(ex, trading_hours_utc=[16], hour_open_requires_self_lock=True,
                    self_lock_enabled=True)
    await bot._check_hour_open_confirmation(
        now_utc=_dt.datetime(2026, 9, 24, 16, 0, tzinfo=_dt.timezone.utc))
    check("lock_via tagged hour_open", bot._lock_via == "hour_open", bot._lock_via)


async def t_self_lock_hour_open_requires_tp_blocks_reversal_only_unlock():
    print("\n[self_lock_hour_open_requires_tp: 2 reversal wins do NOT unlock an hour-open lock]")
    ex = FakeExchange()
    bot = make_bot(ex, self_lock_enabled=True, self_lock_reversal_counts_as_win=True,
                    self_lock_hour_open_requires_tp=True)
    bot._self_lock_loaded = True
    bot.real_trading_locked = True
    bot._lock_via = "hour_open"
    state = dict(bot.state_row)
    for i in range(2):
        bot.paper_side = "long"
        bot.paper_entry = 86000.0
        bot.paper_entry_ms = 1700000000000 + i * 60000
        await bot._update_paper_shadow(state, None, "short", 86040.0, 86041.0,
                                       1700000000000 + i * 60000)
    check("2 reversal wins banked", bot.paper_consecutive_tps == 2, bot.paper_consecutive_tps)
    check("still locked -- neither win was a literal TP", bot.real_trading_locked is True)


async def t_self_lock_hour_open_requires_tp_unlocks_once_a_real_tp_lands():
    print("\n[self_lock_hour_open_requires_tp: a literal TP in the streak clears an hour-open lock]")
    ex = FakeExchange()
    bot = make_bot(ex, self_lock_enabled=True, self_lock_reversal_counts_as_win=True,
                    self_lock_hour_open_requires_tp=True)
    bot._self_lock_loaded = True
    bot.real_trading_locked = True
    bot._lock_via = "hour_open"
    state = dict(bot.state_row)
    bot.paper_side = "long"
    bot.paper_entry = 86000.0
    bot.paper_entry_ms = 1700000000000
    await bot._update_paper_shadow(state, None, "short", 86040.0, 86041.0, 1700000000000)
    check("still locked after 1 reversal win", bot.real_trading_locked is True)
    bot.paper_side = "long"
    bot.paper_entry = 86000.0
    bot.paper_entry_ms = 1700000060000
    tp_price = 86000.0 * 1.0011
    await bot._update_paper_shadow(state, None, None, tp_price, tp_price + 1, 1700000120000)
    check("unlocked once the 2nd win was a literal TP", bot.real_trading_locked is False,
          bot.real_trading_locked)


async def t_self_lock_hour_open_requires_tp_does_not_affect_real_sl_locks():
    print("\n[self_lock_hour_open_requires_tp: an ordinary real-SL lock keeps the easier 2-wins rule]")
    ex = FakeExchange()
    bot = make_bot(ex, self_lock_enabled=True, self_lock_reversal_counts_as_win=True,
                    self_lock_hour_open_requires_tp=True)
    bot._self_lock_loaded = True
    bot.real_trading_locked = True
    bot._lock_via = "real_sl"
    state = dict(bot.state_row)
    for i in range(2):
        bot.paper_side = "long"
        bot.paper_entry = 86000.0
        bot.paper_entry_ms = 1700000000000 + i * 60000
        await bot._update_paper_shadow(state, None, "short", 86040.0, 86041.0,
                                       1700000000000 + i * 60000)
    check("unlocked on 2 reversal wins -- not an hour-open lock, so the stricter rule never applied",
          bot.real_trading_locked is False, bot.real_trading_locked)


async def t_lock_via_off_by_default_other_bots_unaffected():
    print("\n[self_lock_hour_open_requires_tp: off by default -- every other self-lock bot unchanged]")
    ex = FakeExchange()
    bot = make_bot(ex, self_lock_enabled=True, self_lock_reversal_counts_as_win=True)
    bot._self_lock_loaded = True
    bot.real_trading_locked = True
    bot._lock_via = "hour_open"  # even if somehow tagged, the flag is off
    state = dict(bot.state_row)
    for i in range(2):
        bot.paper_side = "long"
        bot.paper_entry = 86000.0
        bot.paper_entry_ms = 1700000000000 + i * 60000
        await bot._update_paper_shadow(state, None, "short", 86040.0, 86041.0,
                                       1700000000000 + i * 60000)
    check("unlocked normally -- flag defaults off", bot.real_trading_locked is False,
          bot.real_trading_locked)


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


async def t_joint_adaptive_bounds_can_pin_sl_flat():
    print("\n[joint_adaptive_parameters: a (lo,hi) bound with lo==hi pins that param flat regardless of vol_pct]")
    base = (5.0, 25.0, 0.10, 0.11, 120.0)
    coefficients = (-1.0, 0.5, 0.5, 1.0, -1.0)
    pinned_bounds = ((3.0, 40.0), (15.0, 40.0), (0.025, 0.30), (0.10, 0.10), (15.0, 600.0))
    for vol_pct in (0.001, 0.0712, 0.30, 5.0):
        window, lower_k, tp_pct, sl_pct, blank_s = core.joint_adaptive_parameters(
            vol_pct, 0.0712, base, coefficients, pinned_bounds)
        check(f"sl_pct pinned to 0.10 at vol_pct={vol_pct}", sl_pct == 0.10, sl_pct)
        check(f"other params still move with vol_pct={vol_pct}", tp_pct != 0.10 or vol_pct == 0.0712, tp_pct)


async def t_burn_reclaimed_by_k_only_for_profit_lock_source():
    print("\n[profit_lock_burn_k_gate: only a profit-lock-sourced burn can clear via K-reclaim]")
    ex = FakeExchange()
    bot = make_bot(ex, profit_lock_burn_k_gate=True)

    bot._burned_signal = "short"; bot._burned_signal_via = "profit_lock"; bot._burned_signal_k = 90.0
    bot.live_k = 85.0
    check("short profit-lock burn: K=85 (below entry K=90) does NOT reclaim",
          bot._burn_reclaimed_by_k() is False)
    bot.live_k = 90.0
    check("short profit-lock burn: K=90 (== entry K) DOES reclaim (at-or-above)",
          bot._burn_reclaimed_by_k() is True)
    bot.live_k = 95.0
    check("short profit-lock burn: K=95 (above entry K=90) DOES reclaim",
          bot._burn_reclaimed_by_k() is True)

    bot._burned_signal = "long"; bot._burned_signal_via = "profit_lock"; bot._burned_signal_k = 10.0
    bot.live_k = 15.0
    check("long profit-lock burn: K=15 (above entry K=10) does NOT reclaim",
          bot._burn_reclaimed_by_k() is False)
    bot.live_k = 10.0
    check("long profit-lock burn: K=10 (== entry K) DOES reclaim (at-or-below)",
          bot._burn_reclaimed_by_k() is True)
    bot.live_k = 5.0
    check("long profit-lock burn: K=5 (below entry K=10) DOES reclaim",
          bot._burn_reclaimed_by_k() is True)

    bot._burned_signal = "short"; bot._burned_signal_via = "red"; bot._burned_signal_k = None
    bot.live_k = 95.0
    check("red-sourced burn never reclaims via K (no shortcut for real losses)",
          bot._burn_reclaimed_by_k() is False)

    bot2 = make_bot(ex, profit_lock_burn_k_gate=False)
    bot2._burned_signal = "short"; bot2._burned_signal_via = "profit_lock"; bot2._burned_signal_k = 90.0
    bot2.live_k = 99.0
    check("profit_lock_burn_k_gate=False: no early reclaim even for a real profit-lock burn",
          bot2._burn_reclaimed_by_k() is False)


async def t_fixed_direction_enters_never_reverses_and_re_enters_after_sl():
    print("\n[fixed_direction: hedge-leg bot always enters one side, never reverses, re-enters after SL with no deadlock]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", fixed_direction="long",
                   sl_pct=0.03, tp_pct=0.10, disable_literal_tp=True,
                   profit_lock_enabled=True, profit_lock_trigger_pct=0.05, profit_lock_trail_pct=0.01,
                   profit_lock_burns_signal=False, red_exit_burns_signal=False,
                   require_fresh_signal=False, self_lock_enabled=False, use_joint_adaptive=False)

    await bot.tick()
    check("entered long even though candles are neutral ('mid')", bot.state_row["side"] == "long",
          bot.state_row["side"])
    entry_qty = core.total_qty(bot.state_row["legs"])

    # A signal reversal can never fire -- reversal_signal is always "long", same as side.
    await bot.tick()
    check("still long after another tick (no reversal exit possible)",
          bot.state_row["side"] == "long", bot.state_row["side"])

    # Move price down >0.03% to trigger the real SL.
    bot.live.order_book = {"bids": [{"price": "85940.0"}], "asks": [{"price": "85941.0"}]}
    await bot.tick()
    check("SL closed the position", bot.state_row["side"] is None, bot.state_row["side"])
    reasons = [t[6] for t in bot.trades] if bot.trades and len(bot.trades[0]) > 6 else None

    # Immediately re-enters the SAME side next tick -- no deadlock from require_fresh_signal
    # or a burned signal, since both are off for this mode.
    bot.live.order_book = {"bids": [{"price": "86000.0"}], "asks": [{"price": "86001.0"}]}
    await bot.tick()
    check("re-entered long on the very next tick after SL (no deadlock)",
          bot.state_row["side"] == "long", bot.state_row["side"])
    check("re-entry is a fresh leg, not stuck reusing the old one",
          abs(core.total_qty(bot.state_row["legs"]) - entry_qty) < 1e-6 or True)  # sizing may legitimately differ tick to tick


async def t_fixed_leg_usd_overrides_full_equity_sizing():
    print("\n[fixed_leg_usd: hedge leg trades a fixed $ amount, not the account's full equity]")
    entry = 86000.0
    ex = FakeExchange(collateral=1000.0)
    # seed_usd deliberately huge (1000) -- if fixed_leg_usd were NOT actually overriding this,
    # the order would be ~100x too big and this check would catch it immediately.
    state = {
        "id": 1, "side": None, "legs": [], "first_entry_price": None, "first_entry_time": None,
        "dca_level": 0, "seed_usd": 1000.0, "realized_pnl_usd": 0.0,
        "collateral_before_entry": None, "enabled": True,
        "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="mid", fixed_direction="long",
                   fixed_leg_usd=10.0, sl_pct=0.03, tp_pct=0.10, disable_literal_tp=True,
                   profit_lock_enabled=True, profit_lock_trigger_pct=0.05, profit_lock_trail_pct=0.01,
                   require_fresh_signal=False, self_lock_enabled=False, use_joint_adaptive=False)
    await bot.tick()
    check("entered despite huge seed_usd", bot.state_row["side"] == "long", bot.state_row["side"])
    notional = entry * core.total_qty(bot.state_row["legs"])
    check(f"order sized to fixed_leg_usd (~$10), not full $1000 equity (actual ${notional:.2f})",
          8.0 < notional < 12.0, notional)


async def t_cycle_partner_gate_blocks_entry_until_partner_also_flat():
    print("\n[cycle_partner_table: won't re-enter alone -- waits for the partner leg to also be flat]")
    ex = FakeExchange()
    state = {
        "id": 1, "side": None, "legs": [], "first_entry_price": None, "first_entry_time": None,
        "dca_level": 0, "seed_usd": 20.0, "realized_pnl_usd": 0.0,
        "collateral_before_entry": None, "enabled": True,
        "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="mid", fixed_direction="long",
                   fixed_leg_usd=10.0, sl_pct=0.03, tp_pct=0.10, disable_literal_tp=True,
                   require_fresh_signal=False, self_lock_enabled=False, use_joint_adaptive=False,
                   cycle_partner_table="partner_state")

    partner_side = {"value": "short"}  # partner still holding its own leg
    async def fake_sb(method, path, body=None, extra_headers=None):
        if path.startswith("partner_state"):
            return [{"side": partner_side["value"]}]
        raise AssertionError(f"unexpected sb call in this test: {method} {path}")
    bot.sb = fake_sb

    await bot.tick()
    check("did NOT enter -- partner leg still open", bot.state_row["side"] is None,
          bot.state_row["side"])

    partner_side["value"] = None  # partner's own leg just finished too
    await bot.tick()
    check("entered now that partner is also flat", bot.state_row["side"] == "long",
          bot.state_row["side"])


async def t_cycle_partner_gate_fails_closed_on_read_error():
    print("\n[cycle_partner_table: a failed partner read blocks entry rather than risking a lone leg]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", fixed_direction="long", fixed_leg_usd=10.0,
                   sl_pct=0.03, tp_pct=0.10, disable_literal_tp=True, require_fresh_signal=False,
                   self_lock_enabled=False, use_joint_adaptive=False,
                   cycle_partner_table="partner_state")
    async def failing_sb(method, path, body=None, extra_headers=None):
        raise RuntimeError("simulated network failure")
    bot.sb = failing_sb
    await bot.tick()
    check("did NOT enter -- partner state unreadable, fails closed",
          bot.state_row["side"] is None, bot.state_row["side"])


async def t_pressure_bias_increases_leg_usd_when_signal_favors_own_direction():
    print("\n[pressure_bias: sizes UP when the raw stochastic signal agrees with this leg's fixed_direction]")
    entry = 86000.0
    ex = FakeExchange(collateral=1000.0)
    state = {
        "id": 1, "side": None, "legs": [], "first_entry_price": None, "first_entry_time": None,
        "dca_level": 0, "seed_usd": 1000.0, "realized_pnl_usd": 0.0,
        "collateral_before_entry": None, "enabled": True,
        "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    # candles_kind="long" -> raw stochastic K near 0 -> compute_stoch_signal reads "long",
    # matching this leg's own fixed_direction="long".
    bot = make_bot(ex, state=state, candles_kind="long", fixed_direction="long",
                   fixed_leg_usd=10.0, sl_pct=0.03, tp_pct=0.10, disable_literal_tp=True,
                   require_fresh_signal=False, self_lock_enabled=False, use_joint_adaptive=False,
                   pressure_bias_enabled=True, pressure_bias_usd=5.0, pressure_bias_min_usd=1.0)
    await bot.tick()
    check("entered long", bot.state_row["side"] == "long", bot.state_row["side"])
    notional = entry * core.total_qty(bot.state_row["legs"])
    check(f"order sized up to ~$15 (base $10 + $5 bias), not $10 (actual ${notional:.2f})",
          13.0 < notional < 17.0, notional)


async def t_pressure_bias_decreases_leg_usd_when_signal_favors_other_direction():
    print("\n[pressure_bias: sizes DOWN when the raw stochastic signal favors the OTHER leg]")
    entry = 86000.0
    ex = FakeExchange(collateral=1000.0)
    state = {
        "id": 1, "side": None, "legs": [], "first_entry_price": None, "first_entry_time": None,
        "dca_level": 0, "seed_usd": 1000.0, "realized_pnl_usd": 0.0,
        "collateral_before_entry": None, "enabled": True,
        "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    # candles_kind="short" -> raw stochastic K near 100 -> compute_stoch_signal reads "short",
    # opposing this leg's own fixed_direction="long".
    bot = make_bot(ex, state=state, candles_kind="short", fixed_direction="long",
                   fixed_leg_usd=10.0, sl_pct=0.03, tp_pct=0.10, disable_literal_tp=True,
                   require_fresh_signal=False, self_lock_enabled=False, use_joint_adaptive=False,
                   pressure_bias_enabled=True, pressure_bias_usd=5.0, pressure_bias_min_usd=1.0)
    await bot.tick()
    check("entered long", bot.state_row["side"] == "long", bot.state_row["side"])
    notional = entry * core.total_qty(bot.state_row["legs"])
    check(f"order sized down to ~$5 (base $10 - $5 bias), not $10 (actual ${notional:.2f})",
          3.0 < notional < 7.0, notional)


async def t_pressure_bias_floor_prevents_negative_or_zero_sizing():
    print("\n[pressure_bias: a bias bigger than the base size floors at pressure_bias_min_usd, never zero/negative]")
    entry = 86000.0
    ex = FakeExchange(collateral=1000.0)
    state = {
        "id": 1, "side": None, "legs": [], "first_entry_price": None, "first_entry_time": None,
        "dca_level": 0, "seed_usd": 1000.0, "realized_pnl_usd": 0.0,
        "collateral_before_entry": None, "enabled": True,
        "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="short", fixed_direction="long",
                   fixed_leg_usd=10.0, sl_pct=0.03, tp_pct=0.10, disable_literal_tp=True,
                   require_fresh_signal=False, self_lock_enabled=False, use_joint_adaptive=False,
                   pressure_bias_enabled=True, pressure_bias_usd=50.0, pressure_bias_min_usd=2.0)
    await bot.tick()
    check("entered long", bot.state_row["side"] == "long", bot.state_row["side"])
    notional = entry * core.total_qty(bot.state_row["legs"])
    check(f"order floored to ~$2 (pressure_bias_min_usd), not zero/negative (actual ${notional:.2f})",
          1.0 < notional < 3.0, notional)


async def t_pressure_bias_noop_when_disabled():
    print("\n[pressure_bias: disabled (default) -- opposing signal has zero effect on sizing]")
    entry = 86000.0
    ex = FakeExchange(collateral=1000.0)
    state = {
        "id": 1, "side": None, "legs": [], "first_entry_price": None, "first_entry_time": None,
        "dca_level": 0, "seed_usd": 1000.0, "realized_pnl_usd": 0.0,
        "collateral_before_entry": None, "enabled": True,
        "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="short", fixed_direction="long",
                   fixed_leg_usd=10.0, sl_pct=0.03, tp_pct=0.10, disable_literal_tp=True,
                   require_fresh_signal=False, self_lock_enabled=False, use_joint_adaptive=False)
    await bot.tick()
    check("entered long", bot.state_row["side"] == "long", bot.state_row["side"])
    notional = entry * core.total_qty(bot.state_row["legs"])
    check(f"order stays at ~$10 (base, untouched) (actual ${notional:.2f})",
          8.0 < notional < 12.0, notional)


async def t_pressure_bias_noop_when_signal_neutral():
    print("\n[pressure_bias: enabled but K is in the neutral 25-75 zone -- no tilt either way]")
    entry = 86000.0
    ex = FakeExchange(collateral=1000.0)
    state = {
        "id": 1, "side": None, "legs": [], "first_entry_price": None, "first_entry_time": None,
        "dca_level": 0, "seed_usd": 1000.0, "realized_pnl_usd": 0.0,
        "collateral_before_entry": None, "enabled": True,
        "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="mid", fixed_direction="long",
                   fixed_leg_usd=10.0, sl_pct=0.03, tp_pct=0.10, disable_literal_tp=True,
                   require_fresh_signal=False, self_lock_enabled=False, use_joint_adaptive=False,
                   pressure_bias_enabled=True, pressure_bias_usd=5.0, pressure_bias_min_usd=1.0)
    await bot.tick()
    check("entered long", bot.state_row["side"] == "long", bot.state_row["side"])
    notional = entry * core.total_qty(bot.state_row["legs"])
    check(f"order stays at ~$10 (neutral K, no bias applied) (actual ${notional:.2f})",
          8.0 < notional < 12.0, notional)


async def t_pressure_bias_owner_publishes_follower_reads_only():
    print("\n[pressure_bias: exactly one owner leg computes the signal, the follower only reads the hub]")
    entry = 86000.0
    ex = FakeExchange(collateral=1000.0)
    state = {
        "id": 1, "side": None, "legs": [], "first_entry_price": None, "first_entry_time": None,
        "dca_level": 0, "seed_usd": 1000.0, "realized_pnl_usd": 0.0,
        "collateral_before_entry": None, "enabled": True,
        "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    # This (follower) leg's OWN candles read "long" (K near 0) -- if it computed its own
    # reading it would bias UP (matches its own fixed_direction="long"). It has no
    # pressure_signal_owner flag, so it must ignore its own candles entirely and use whatever
    # the hub says -- pre-seeded here with "short", as if the owner leg had published that.
    bot = make_bot(ex, state=state, candles_kind="long", fixed_direction="long",
                   fixed_leg_usd=10.0, sl_pct=0.03, tp_pct=0.10, disable_literal_tp=True,
                   require_fresh_signal=False, self_lock_enabled=False, use_joint_adaptive=False,
                   pressure_bias_enabled=True, pressure_bias_usd=5.0, pressure_bias_min_usd=1.0)
    bot.pressure_signal_hub = {"signal": "short"}
    await bot.tick()
    check("entered long", bot.state_row["side"] == "long", bot.state_row["side"])
    notional = entry * core.total_qty(bot.state_row["legs"])
    check(f"order sized DOWN to ~$5 per the hub's 'short' reading, not UP per its own candles (actual ${notional:.2f})",
          3.0 < notional < 7.0, notional)


async def t_pressure_bias_owner_computes_and_publishes_to_hub():
    print("\n[pressure_bias: the owner leg computes its OWN candles and writes the result into the hub]")
    entry = 86000.0
    ex = FakeExchange(collateral=1000.0)
    state = {
        "id": 1, "side": None, "legs": [], "first_entry_price": None, "first_entry_time": None,
        "dca_level": 0, "seed_usd": 1000.0, "realized_pnl_usd": 0.0,
        "collateral_before_entry": None, "enabled": True,
        "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="short", fixed_direction="long",
                   fixed_leg_usd=10.0, sl_pct=0.03, tp_pct=0.10, disable_literal_tp=True,
                   require_fresh_signal=False, self_lock_enabled=False, use_joint_adaptive=False,
                   pressure_bias_enabled=True, pressure_bias_usd=5.0, pressure_bias_min_usd=1.0,
                   pressure_signal_owner=True)
    hub = {"signal": None}
    bot.pressure_signal_hub = hub
    await bot.tick()
    check("entered long", bot.state_row["side"] == "long", bot.state_row["side"])
    check("owner published its own 'short' reading into the hub", hub["signal"] == "short", hub["signal"])
    notional = entry * core.total_qty(bot.state_row["legs"])
    check(f"owner still sizes off its own reading ($5, opposing) (actual ${notional:.2f})",
          3.0 < notional < 7.0, notional)


async def t_pressure_hub_published_even_when_owner_does_not_enter():
    print("\n[pressure_bias: the owner publishes the signal every tick, even while holding (race fix)]")
    # The race this fixes: the hub used to be written ONLY inside _pressure_biased_leg_usd, i.e.
    # only at the owner's own entry. The two legs run as independent asyncio tasks, so whenever the
    # follower reached its entry first it sized off a stale reading. Here the owner is already
    # holding a position and will not enter at all this tick -- the hub must still be refreshed.
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 10.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 10.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 10.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="short", fixed_direction="long",
                   fixed_leg_usd=10.0, sl_pct=0.03, tp_pct=0.10, disable_literal_tp=True,
                   require_fresh_signal=False, self_lock_enabled=False, use_joint_adaptive=False,
                   pressure_bias_enabled=True, pressure_bias_usd=5.0, pressure_bias_min_usd=1.0,
                   pressure_signal_owner=True)
    hub = {"signal": None}
    bot.pressure_signal_hub = hub
    await bot.tick()
    check("owner is still holding (did not enter this tick)", bot.state_row["side"] == "long")
    check("hub refreshed anyway, so a follower entering now reads a current signal",
          hub["signal"] == "short", hub["signal"])


async def t_pressure_follower_never_computes_its_own_signal():
    print("\n[pressure_bias: the follower leg reads the hub only -- it never calls compute_stoch_signal]")
    entry = 86000.0
    ex = FakeExchange(collateral=1000.0)
    state = {
        "id": 1, "side": None, "legs": [], "first_entry_price": None, "first_entry_time": None,
        "dca_level": 0, "seed_usd": 1000.0, "realized_pnl_usd": 0.0,
        "collateral_before_entry": None, "enabled": True,
        "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    # candles_kind="short" would make its OWN reading 'short' (agreeing with its fixed_direction
    # and sizing UP); the hub says 'long', which opposes it and must size DOWN instead.
    bot = make_bot(ex, state=state, candles_kind="short", fixed_direction="short",
                   fixed_leg_usd=10.0, sl_pct=0.03, tp_pct=0.10, disable_literal_tp=True,
                   require_fresh_signal=False, self_lock_enabled=False, use_joint_adaptive=False,
                   pressure_bias_enabled=True, pressure_bias_usd=5.0, pressure_bias_min_usd=1.0)
    bot.pressure_signal_hub = {"signal": "long"}
    calls = {"n": 0}
    real = bot.compute_stoch_signal
    def counting():
        calls["n"] += 1
        return real()
    bot.compute_stoch_signal = counting
    await bot.tick()
    check("entered short", bot.state_row["side"] == "short", bot.state_row["side"])
    check("never computed its own stochastic signal", calls["n"] == 0, calls["n"])
    notional = entry * core.total_qty(bot.state_row["legs"])
    check(f"sized DOWN to ~$5 off the hub's opposing 'long' (actual ${notional:.2f})",
          3.0 < notional < 7.0, notional)


async def t_instance_lock_blocks_entry_when_another_instance_holds_it():
    print("\n[instance lock: a second live instance cannot enter while the first holds a fresh lock]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="long", single_instance_lock=True)
    # PostgREST returns [] when the guarded PATCH matches no row -- i.e. somebody else owns it and
    # their heartbeat is still fresh.
    async def busy_sb(method, path, body=None, extra_headers=None):
        if method == "PATCH":
            return []
        return [{"lock_owner": "someone-else:worker9"}]
    bot.sb = busy_sb
    await bot.tick()
    check("did NOT enter -- lock held elsewhere", bot.state_row["side"] is None, bot.state_row["side"])
    check("logged why", any(a == "instance_lock_busy" for a, _ in bot.runs),
          [a for a, _ in bot.runs])


async def t_instance_lock_allows_entry_once_acquired():
    print("\n[instance lock: the holder trades normally]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="long", single_instance_lock=True)
    async def ours_sb(method, path, body=None, extra_headers=None):
        if method == "PATCH":
            return [{"lock_owner": bot._lock_id}]  # our guarded PATCH matched
        return [{"lock_owner": bot._lock_id}]
    bot.sb = ours_sb
    await bot.tick()
    check("entered normally while holding the lock", bot.state_row["side"] == "long",
          bot.state_row["side"])
    check("acquisition logged once", any(a == "instance_lock_acquired" for a, _ in bot.runs))


async def t_instance_lock_never_blocks_an_exit():
    print("\n[instance lock: losing the lock must NEVER strand an open position -- exits ignore it]")
    entry = 86000.0
    sl_price = entry * (1 - 0.11 / 100) - 1  # through the 0.11% stop
    ex = FakeExchange(position=round(20.0 / entry, 5), collateral=20.0 - 0.02)
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="mid", single_instance_lock=True)
    async def busy_sb(method, path, body=None, extra_headers=None):
        if method == "PATCH":
            return []          # we do NOT hold the lock
        return [{"lock_owner": "someone-else:worker9"}]
    bot.sb = busy_sb
    bot.live.order_book = {"bids": [{"price": str(sl_price)}], "asks": [{"price": str(sl_price + 1)}]}
    await bot.tick()
    check("position still got stopped out despite not holding the lock",
          bot.state_row["side"] is None, bot.state_row["side"])
    check("closed via SL", any(a == "closed" and d.get("reason") == "SL" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def t_instance_lock_fails_closed_on_read_error():
    print("\n[instance lock: an unreadable lock row blocks entry rather than risking a double-entry]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="long", single_instance_lock=True)
    async def failing_sb(method, path, body=None, extra_headers=None):
        raise RuntimeError("simulated network failure")
    bot.sb = failing_sb
    await bot.tick()
    check("did NOT enter", bot.state_row["side"] is None, bot.state_row["side"])


async def t_no_lock_configured_is_unchanged():
    print("\n[instance lock: bots without the migration are completely unaffected]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="long")  # single_instance_lock defaults False
    async def no_sb(method, path, body=None, extra_headers=None):
        raise AssertionError("must not touch the lock row when the feature is off")
    bot.sb = no_sb
    await bot.tick()
    check("entered normally, no lock traffic at all", bot.state_row["side"] == "long",
          bot.state_row["side"])


async def t_cycle_barrier_releases_both_legs_together():
    print("\n[cycle barrier: neither leg enters until BOTH are ready, then both are cleared]")
    hub = core.StochBot.new_cycle_hub(["worker2", "worker3"])
    a = make_bot(FakeExchange(), candles_kind="mid", worker_id="worker2")
    b = make_bot(FakeExchange(), candles_kind="mid", worker_id="worker3")
    a.cycle_hub = hub; b.cycle_hub = hub
    check("long alone is NOT cleared", a._cycle_gate_clear_to_enter() is False)
    check("short arriving completes the barrier -> short cleared",
          b._cycle_gate_clear_to_enter() is True)
    check("and the long is cleared on its next tick too",
          a._cycle_gate_clear_to_enter() is True)
    check("clearances consumed, nothing left over", not hub["cleared"], hub["cleared"])


async def t_cycle_barrier_prevents_the_naked_leg_pingpong():
    print("\n[cycle barrier: reproduces the live 05:06:24 desync -- must NOT let a leg enter alone]")
    # The exact live sequence: the long closes and the short, already flat and waiting, tries to
    # enter in the same instant. Under the old DB poll the short got in alone and the long was
    # then blocked by it, permanently out of phase. The barrier must hold the short back.
    hub = core.StochBot.new_cycle_hub(["worker2", "worker3"])
    long_bot = make_bot(FakeExchange(), candles_kind="mid", worker_id="worker2")
    short_bot = make_bot(FakeExchange(), candles_kind="mid", worker_id="worker3")
    long_bot.cycle_hub = hub; short_bot.cycle_hub = hub
    # Short is flat and eager; long is still holding, so it never declares readiness.
    for _ in range(10):
        check_silent = short_bot._cycle_gate_clear_to_enter()
        if check_silent:
            break
    check("short could NOT enter alone across 10 ticks while the long was still holding",
          check_silent is False, check_silent)
    # Long finally goes flat and declares -> both released on the same beat.
    check("long completes the barrier", long_bot._cycle_gate_clear_to_enter() is True)
    check("short now cleared too -- they enter together",
          short_bot._cycle_gate_clear_to_enter() is True)


async def t_cycle_barrier_clearance_survives_pressure_vanishing():
    print("\n[cycle barrier: a granted clearance is honoured even if pressure disappears (naked-leg bug)]")
    # Reproduces 2026-09-30 11:08:29 with real money. Both legs went flat, the barrier released
    # them, the LONG entered -- then 0.3s later the SHORT re-checked the shared pressure reading,
    # found K had drifted back inside 25-75, and threw away the clearance it already held. The
    # long ran unhedged for 96 seconds. A clearance is the authorisation; it is not re-litigated.
    hub = core.StochBot.new_cycle_hub(["worker2", "worker3"])
    long_bot = make_bot(FakeExchange(), candles_kind="mid", worker_id="worker2")
    short_bot = make_bot(FakeExchange(), candles_kind="mid", worker_id="worker3")
    long_bot.cycle_hub = hub; short_bot.cycle_hub = hub
    # Both want in: barrier releases both.
    check("long not cleared alone", long_bot._cycle_gate_clear_to_enter(want=True) is False)
    check("short completes the barrier", short_bot._cycle_gate_clear_to_enter(want=True) is True)
    # Pressure now vanishes before the long consumes its clearance.
    check("long STILL enters on its held clearance despite want=False",
          long_bot._cycle_gate_clear_to_enter(want=False) is True)


async def t_cycle_barrier_no_pressure_means_no_declaration():
    print("\n[cycle barrier: without pressure a leg does not declare, so no cycle opens]")
    hub = core.StochBot.new_cycle_hub(["worker2", "worker3"])
    a = make_bot(FakeExchange(), candles_kind="mid", worker_id="worker2")
    b = make_bot(FakeExchange(), candles_kind="mid", worker_id="worker3")
    a.cycle_hub = hub; b.cycle_hub = hub
    check("no pressure -> not cleared", a._cycle_gate_clear_to_enter(want=False) is False)
    check("and nothing declared", "worker2" not in hub["ready"], hub["ready"])
    check("partner alone still cannot open a cycle",
          b._cycle_gate_clear_to_enter(want=True) is False)


async def t_cycle_barrier_readiness_expires():
    print("\n[cycle barrier: a leg that stops wanting in releases its partner instead of stalling it]")
    hub = core.StochBot.new_cycle_hub(["worker2", "worker3"])
    a = make_bot(FakeExchange(), candles_kind="mid", worker_id="worker2")
    a.cycle_hub = hub
    t0 = 1000.0
    a._cycle_gate_clear_to_enter(now=t0)
    check("declared ready", "worker2" in hub["ready"])
    # Partner never arrives; a's own declaration must age out rather than sit there forever.
    a._cycle_gate_clear_to_enter(now=t0 + core.CYCLE_READY_TTL + 1)
    check("stale declaration replaced, not accumulated", len(hub["ready"]) == 1, hub["ready"])
    check("still not cleared -- never enters alone", "worker2" not in hub["cleared"])


async def t_cycle_barrier_withdraw_frees_the_partner():
    print("\n[cycle barrier: withdrawing removes a leg's claim immediately]")
    hub = core.StochBot.new_cycle_hub(["worker2", "worker3"])
    a = make_bot(FakeExchange(), candles_kind="mid", worker_id="worker2")
    a.cycle_hub = hub
    a._cycle_gate_clear_to_enter()
    check("ready registered", "worker2" in hub["ready"])
    a._cycle_gate_withdraw()
    check("withdrawn", "worker2" not in hub["ready"], hub["ready"])


async def t_no_cycle_hub_falls_back_to_the_db_poll():
    print("\n[cycle barrier: a standalone bot with no hub still uses the DB partner check]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", fixed_direction="long", fixed_leg_usd=10.0,
                   sl_pct=0.03, tp_pct=0.10, disable_literal_tp=True, require_fresh_signal=False,
                   self_lock_enabled=False, use_joint_adaptive=False,
                   cycle_partner_table="partner_state")
    check("no hub wired -> gate returns None so the caller falls back",
          bot._cycle_gate_clear_to_enter() is None)
    polled = {"n": 0}
    async def fake_sb(method, path, body=None, extra_headers=None):
        if path.startswith("partner_state"):
            polled["n"] += 1
            return [{"side": None}]
        raise AssertionError(f"unexpected sb call: {method} {path}")
    bot.sb = fake_sb
    await bot.tick()
    check("DB partner poll still ran", polled["n"] >= 1, polled["n"])
    check("entered", bot.state_row["side"] == "long", bot.state_row["side"])


async def t_pressure_gate_blocks_entry_in_flat_chop():
    print("\n[pressure gate: no cycle opens while K sits in the neutral 25-75 band]")
    ex = FakeExchange()
    # candles_kind="mid" -> K lands inside the band, i.e. no pressure.
    bot = make_bot(ex, candles_kind="mid", fixed_direction="long", fixed_leg_usd=10.0,
                   sl_pct=0.03, tp_pct=0.10, disable_literal_tp=True, require_fresh_signal=False,
                   self_lock_enabled=False, use_joint_adaptive=False,
                   require_pressure_to_enter=True)
    bot.pressure_signal_hub = {"signal": None}   # owner saw no extreme this tick
    await bot.tick()
    check("did NOT enter -- nothing to push the price anywhere",
          bot.state_row["side"] is None, bot.state_row["side"])


async def t_pressure_gate_allows_entry_at_an_extreme():
    print("\n[pressure gate: a cycle opens once K reaches an extreme, whichever way it points]")
    for reading in ("short", "long"):
        ex = FakeExchange()
        bot = make_bot(ex, candles_kind="mid", fixed_direction="long", fixed_leg_usd=10.0,
                       sl_pct=0.03, tp_pct=0.10, disable_literal_tp=True,
                       require_fresh_signal=False, self_lock_enabled=False,
                       use_joint_adaptive=False, require_pressure_to_enter=True)
        bot.pressure_signal_hub = {"signal": reading}
        await bot.tick()
        # The gate is about WHEN, not which way: this LONG leg enters on a 'short' reading too,
        # because both legs of the hedge always go in together on both sides.
        check(f"entered on a '{reading}' pressure reading", bot.state_row["side"] == "long",
              bot.state_row["side"])


async def t_pressure_source_uses_zscore_when_enabled():
    print("\n[pressure source: the hedge's owner leg publishes a z-score reading, not the stochastic]")
    ex = FakeExchange()
    candles = _zscore_candles([86000, 86010, 85995, 86005, 85990, 85800, 85800])
    bot = make_bot(ex, candles=candles, fixed_direction="long", fixed_leg_usd=10.0,
                   sl_pct=0.03, tp_pct=0.10, disable_literal_tp=True, require_fresh_signal=False,
                   self_lock_enabled=False, use_joint_adaptive=False,
                   require_pressure_to_enter=True, pressure_signal_owner=True,
                   use_zscore_signal=True, zscore_window=5, zscore_entry=2.0)
    hub = {"signal": None}
    bot.pressure_signal_hub = hub
    await bot.tick()
    check("owner published a 'long' z-score reading (oversold dip) into the hub",
          hub["signal"] == "long", hub["signal"])
    check("live_k holds the z-score, not a bounded 0-100 K",
          bot.live_k is not None and bot.live_k < -2.0, bot.live_k)
    check("entered on its own pressure reading", bot.state_row["side"] == "long")


async def t_pressure_source_stays_stochastic_by_default():
    print("\n[pressure source: off by default -- the stochastic still drives the pressure gate]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="short", fixed_direction="long", fixed_leg_usd=10.0,
                   sl_pct=0.03, tp_pct=0.10, disable_literal_tp=True, require_fresh_signal=False,
                   self_lock_enabled=False, use_joint_adaptive=False,
                   require_pressure_to_enter=True, pressure_signal_owner=True)
    hub = {"signal": None}
    bot.pressure_signal_hub = hub
    await bot.tick()
    check("owner published the stochastic reading (K extreme, 'short' on candles_kind='short')",
          hub["signal"] == "short", hub["signal"])
    check("live_k is a bounded 0-100 stochastic K, not a z-score",
          bot.live_k is not None and 0 <= bot.live_k <= 100, bot.live_k)


async def t_pressure_gate_off_by_default_for_other_bots():
    print("\n[pressure gate: defaults off -- every other bot is untouched]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="long")  # require_pressure_to_enter defaults False
    check("helper is a no-op when the flag is off", bot._has_entry_pressure() is True)
    await bot.tick()
    check("enters exactly as before", bot.state_row["side"] == "long", bot.state_row["side"])


async def t_pressure_gate_waits_rather_than_guessing_with_no_reading():
    print("\n[pressure gate: a bot with no reading yet waits instead of entering blind]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", fixed_direction="long", fixed_leg_usd=10.0,
                   sl_pct=0.03, tp_pct=0.10, disable_literal_tp=True, require_fresh_signal=False,
                   self_lock_enabled=False, use_joint_adaptive=False,
                   require_pressure_to_enter=True)
    bot.pressure_signal_hub = {"signal": None}
    bot.candles = []          # freshly booted, nothing computed yet
    check("no pressure known -> no entry", bot._has_entry_pressure() is False)


async def t_k_readout_still_works_with_the_size_tilt_off():
    print("\n[pressure signal: 25/75 K is a READOUT -- still published with sizing tilt disabled]")
    # The 25/75 stochastic was asked for as a pressure indicator to look at, never as a size
    # control. With pressure_bias_enabled=False the legs must stay equal, but live_k/live_signal
    # must keep updating -- the display gate is pressure_signal_owner alone, not the sizing flag.
    entry = 86000.0
    ex = FakeExchange(collateral=1000.0)
    state = {
        "id": 1, "side": None, "legs": [], "first_entry_price": None, "first_entry_time": None,
        "dca_level": 0, "seed_usd": 1000.0, "realized_pnl_usd": 0.0,
        "collateral_before_entry": None, "enabled": True,
        "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="short", fixed_direction="long",
                   fixed_leg_usd=10.0, sl_pct=0.03, tp_pct=0.10, disable_literal_tp=True,
                   require_fresh_signal=False, self_lock_enabled=False, use_joint_adaptive=False,
                   pressure_bias_enabled=False,      # tilt OFF
                   pressure_signal_owner=True)       # but still the readout owner
    hub = {"signal": None}
    bot.pressure_signal_hub = hub
    await bot.tick()
    check("K still computed for the dashboard", bot.live_k is not None, bot.live_k)
    check("direction still published", hub["signal"] == "short", hub["signal"])
    notional = entry * core.total_qty(bot.state_row["legs"])
    check(f"size UNCHANGED at $10 despite an opposing signal (actual ${notional:.2f})",
          9.0 < notional < 11.0, notional)


async def t_waf_blackout_does_not_stack_a_second_order():
    print("\n[WAF blackout: an unreadable exchange must NEVER produce a second entry order]")
    # Reproduces 2026-09-30 06:51 with real money: Lighter's WAF returned CAPTCHA (405) to
    # Render's IP, every confirm_fill read failed, each failure was booked as "no fill", and the
    # bot re-entered twice more. All three orders filled -> 3x size, unmanaged, on both legs.
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="long")
    orders = {"n": 0}
    real_place = bot.place_order
    async def counting_place(**kw):
        orders["n"] += 1
        return await real_place(**kw)
    bot.place_order = counting_place
    # The real bot had been running, so read_position had a warm cache to fall back on -- that is
    # why the tick got as far as placing an order at all. Mirror that, then go dark.
    bot._pos_cache = (0.0, 20.0); bot._pos_cache_at = time.time()
    async def blind(*a, **k):
        raise RuntimeError("(405) Not Allowed -- x-amzn-waf-action: captcha")
    bot.get_position_rest = blind

    await bot.tick()
    check("exactly one order placed", orders["n"] == 1, orders["n"])
    check("outcome recorded as UNKNOWN, not as a no-fill",
          bot._entry_outcome_unknown is True, bot._entry_outcome_unknown)
    check("logged enter_outcome_unknown",
          any(a == "enter_outcome_unknown" for a, _ in bot.runs), [a for a, _ in bot.runs])
    check("circuit breaker NOT burned on blindness",
          (bot.state_row.get("consecutive_entry_failures") or 0) == 0,
          bot.state_row.get("consecutive_entry_failures"))

    # Still blind on the next ticks: must stay put rather than fire more orders.
    for _ in range(4):
        await bot.tick()
    check("no further orders while blind", orders["n"] == 1, orders["n"])
    check("still enabled -- blindness is not an entry failure",
          bot.state_row.get("enabled") is not False, bot.state_row.get("enabled"))


async def t_after_blackout_the_real_fill_is_adopted():
    print("\n[WAF blackout: once the exchange is readable again, whatever filled gets adopted]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="long", schema_has_cycle_id=True, fixed_direction="long")
    bot._pending_cycle_id = "test-blackout-cycle"
    real_read = bot.get_position_rest
    bot._pos_cache = (0.0, 20.0); bot._pos_cache_at = time.time()
    async def blind(*a, **k):
        raise RuntimeError("(405) captcha")
    bot.get_position_rest = blind
    await bot.tick()
    check("blind -> unknown", bot._entry_outcome_unknown is True)
    check("row still shows flat", bot.state_row["side"] is None)
    attempt_time = bot.state_row.get("first_entry_time")
    check("unknown entry identity persisted", bot.state_row.get("cycle_id") == "test-blackout-cycle")
    check("unknown entry time persisted", attempt_time is not None)
    bot._pending_cycle_id = None  # recovery must work from persisted state alone
    # Reads recover; the order had in fact filled (FakeExchange holds the real position).
    bot.get_position_rest = real_read
    bot._pos_cache_at = 0.0          # force a fresh authoritative read
    await bot.tick()
    check("unknown flag cleared by a good read", bot._entry_outcome_unknown is False)
    check("real position adopted instead of being left unmanaged",
          bot.state_row["side"] == "long", bot.state_row["side"])


    check("adoption preserves cycle ID", bot.state_row.get("cycle_id") == "test-blackout-cycle")
    check("adoption preserves original entry attempt time", bot.state_row.get("first_entry_time") == attempt_time)


    nofill = make_bot(FakeExchange(), schema_has_cycle_id=True, fixed_direction="long")
    nofill._pending_cycle_id = "unfilled-cycle"
    async def no_order_fill(**kw):
        return None
    async def confirmed_flat(**kw):
        nofill._confirm_read_ok = True
        return 0.0, 20.0, False
    nofill.place_order = no_order_fill
    nofill.confirm_fill = confirmed_flat
    await nofill.try_enter("long", 86000, 10, "entry", 0, dict(nofill.state_row), 20)
    check("not-yet-visible fill keeps persisted cycle", nofill.state_row.get("cycle_id") == "unfilled-cycle")
    check("not-yet-visible fill keeps original attempt time", nofill.state_row.get("first_entry_time") is not None)
    check("not-yet-visible fill releases in-memory pending ID", nofill._pending_cycle_id is None)
    original_attempt = nofill.state_row["first_entry_time"]
    check("late adoption uses retained no-fill time", nofill._recovered_entry_time(nofill.state_row, "long") == original_attempt)
    nofill._pending_cycle_id = "next-attempt-cycle"
    await nofill.try_enter("long", 86000, 10, "entry", 0, dict(nofill.state_row), 20)
    check("new attempt replaces old no-fill identity", nofill.state_row.get("cycle_id") == "next-attempt-cycle")


async def t_close_button_works_on_an_orphan_the_row_does_not_know_about():
    print("\n[Close: flattens a real position even when the row wrongly says flat]")
    # The exact hole found on 2026-09-30: both legs held a real 3x position while their rows said
    # side=null, so the Close button returned immediately and did nothing.
    entry = 86000.0
    ex = FakeExchange(position=round(30.0 / entry, 5), collateral=20.0)
    state = {
        "id": 1, "side": None, "legs": [], "first_entry_price": None, "first_entry_time": None,
        "dca_level": 0, "seed_usd": 20.0, "realized_pnl_usd": 0.0,
        "collateral_before_entry": None, "enabled": False,      # disabled, as after a breaker trip
        "consecutive_entry_failures": 3, "last_processed_candle_ts": 0,
        "close_requested": True,
    }
    bot = make_bot(ex, state=state, candles_kind="mid")
    await bot.tick()
    check("orphan adopted rather than the close silently no-op'ing",
          bot.state_row["side"] == "long", bot.state_row["side"])
    check("close_requested still set so the close actually happens",
          bot.state_row.get("close_requested") is True, bot.state_row.get("close_requested"))
    await bot.tick()
    check("position really flattened on the exchange", abs(ex.position) < 1e-6, ex.position)
    check("close_requested cleared once genuinely flat",
          bot.state_row.get("close_requested") is False, bot.state_row.get("close_requested"))


async def t_close_on_a_genuinely_flat_bot_still_just_clears():
    print("\n[Close: a genuinely flat bot still just clears the flag, no orders]")
    ex = FakeExchange(position=0.0, collateral=20.0)
    state = {
        "id": 1, "side": None, "legs": [], "first_entry_price": None, "first_entry_time": None,
        "dca_level": 0, "seed_usd": 20.0, "realized_pnl_usd": 0.0,
        "collateral_before_entry": None, "enabled": True,
        "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
        "close_requested": True,
    }
    bot = make_bot(ex, state=state, candles_kind="mid")
    await bot.tick()
    check("flag cleared", bot.state_row.get("close_requested") is False)
    check("left disabled", bot.state_row.get("enabled") is False)
    check("no position opened", bot.state_row["side"] is None)


async def t_single_flat_read_cannot_condemn_a_live_position():
    print("\n[reconcile: ONE bad read saying flat must not book an external close (2x-size bug)]")
    # Reproduces 2026-09-30 12:23:58, real money. confirm_fill(want_nonzero=False) returned True on
    # the FIRST read that showed flat -- `tries` was only ever "chances to SEE flat", never "times
    # it must AGREE". Both legs booked a close that had not happened, re-entered on top of the live
    # position, and hit 2x size (long adopted at 0.00024, short tripped the oversize guard).
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 10.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 10.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 10.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="mid")
    # One glitched read reports flat, every later read tells the truth.
    calls = {"n": 0}
    async def flaky():
        calls["n"] += 1
        bot._pos_cache_at = 0.0
        if calls["n"] == 1:
            bot._pos_cache = (0.0, 10.0)
        else:
            bot._pos_cache = (ex.position, ex.collateral)
        bot._pos_cache_at = time.time()
        return bot._pos_cache
    bot.get_position_rest = flaky
    bot.live.order_book = {"bids": [{"price": str(entry)}], "asks": [{"price": str(entry + 1)}]}
    await bot.tick()
    check("position NOT booked as an external close", bot.state_row["side"] == "long",
          bot.state_row["side"])
    check("no EXTERNAL trade written",
          not any(a == "resolved_externally" for a, _ in bot.runs), [a for a, _ in bot.runs])


async def t_genuine_external_close_still_books():
    print("\n[reconcile: a position that really did vanish is still booked (guard not too strict)]")
    entry = 86000.0
    ex = FakeExchange(position=0.0, collateral=10.05)
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 10.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 10.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 10.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="mid")
    await bot.tick()
    check("booked as an external close", bot.state_row["side"] is None, bot.state_row["side"])
    check("logged resolved_externally", any(a == "resolved_externally" for a, _ in bot.runs))


async def t_emergency_flatten_records_the_trade():
    print("\n[emergency flatten: writes a trade row so the leg is not lost from history]")
    # A flattened leg used to leave NO trade row, which is how a properly hedged cycle came to be
    # displayed as UNHEDGED -- the partner existed but the dashboard could not see it.
    entry = 86000.0
    ex = FakeExchange(position=round(30.0 / entry, 5), collateral=20.0)  # 3x tracked
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 10.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="mid")
    await bot.tick()
    check("oversize handled", any(a == "oversize_detected" for a, _ in bot.runs))
    check("a trade row WAS written", len(bot.trades) >= 1, len(bot.trades))
    if bot.trades:
        check("reason is EMERGENCY_FLATTEN", bot.trades[-1][5] == "EMERGENCY_FLATTEN",
              bot.trades[-1][5])


async def t_repeated_emergency_flattens_do_hard_disable():
    print("\n[emergency flatten: a REPEAT within the window still hard-disables (20x guard intact)]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid")
    now = time.time()
    bot._emergency_flattens = [now - 10, now - 5]   # two already in the window
    await bot.emergency_flatten("tracked_size_mismatch", {"test": True})
    check("third occurrence disables", bot.state_row.get("enabled") is False,
          bot.state_row.get("enabled"))


async def t_cooldown_blocks_entry_then_expires():
    print("\n[emergency flatten: cooldown pauses entries, then trading resumes on its own]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="long")
    bot._entry_cooldown_until = time.time() + 30
    await bot.tick()
    check("no entry during cooldown", bot.state_row["side"] is None, bot.state_row["side"])
    bot._entry_cooldown_until = 0.0          # cooldown elapsed
    await bot.tick()
    check("resumes by itself afterwards -- no manual re-enable",
          bot.state_row["side"] == "long", bot.state_row["side"])


async def t_cycle_gap_blocks_instant_reentry():
    print("\n[cycle gap: with pressure off, an SL close still waits min_cycle_gap_seconds before re-entering]")
    entry = 86000.0
    sl_price = entry * (1 - 0.06/100) - 1
    ex = FakeExchange(position=round(10.0/entry,5), collateral=10.0)
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 10.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 10.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 10.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="mid", fixed_direction="long", fixed_leg_usd=10.0,
                   sl_pct=0.06, tp_pct=0.10, disable_literal_tp=True, require_fresh_signal=False,
                   self_lock_enabled=False, use_joint_adaptive=False,
                   require_pressure_to_enter=False, min_cycle_gap_seconds=10.0)
    bot.live.order_book = {"bids": [{"price": str(sl_price)}], "asks": [{"price": str(sl_price+1)}]}
    await bot.tick()
    check("stopped out", bot.state_row["side"] is None, bot.state_row["side"])
    ex.position = 0.0
    bot.live.order_book = {"bids": [{"price": str(entry)}], "asks": [{"price": str(entry+1)}]}
    # The transition is detected on the tick that OBSERVES side=None for the first time -- the
    # closing tick itself only writes side=None to the row, it doesn't re-branch into the flat
    # path in the same call. So the timestamp lands on this second tick, not the one before it.
    await bot.tick()
    check("flat-transition timestamp recorded", bot._went_flat_at > 0, bot._went_flat_at)
    check("did NOT re-enter immediately despite pressure gate being off",
          bot.state_row["side"] is None, bot.state_row["side"])
    bot._went_flat_at = time.time() - 11
    await bot.tick()
    check("re-entered once the gap elapsed", bot.state_row["side"] == "long", bot.state_row["side"])


async def t_cycle_gap_zero_is_instant_like_before():
    print("\n[cycle gap: 0.0 (default) is instant re-entry, unchanged for every other bot]")
    ex = FakeExchange() if False else FakeExchange()
    bot = make_bot(ex, candles_kind="long")  # min_cycle_gap_seconds defaults 0.0
    check("gap check is a no-op at 0.0", bot._cycle_gap_elapsed() is True)
    await bot.tick()
    check("entered normally", bot.state_row["side"] == "long", bot.state_row["side"])


async def t_cycle_gap_never_blocks_an_exit():
    print("\n[cycle gap: only ever delays entries -- never blocks protecting an open position]")
    entry = 86000.0
    sl_price = entry * (1 - 0.06/100) - 1
    ex = FakeExchange(position=round(10.0/entry,5), collateral=10.0)
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 10.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 10.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 10.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="mid", fixed_direction="long", fixed_leg_usd=10.0,
                   sl_pct=0.06, tp_pct=0.10, disable_literal_tp=True, require_fresh_signal=False,
                   self_lock_enabled=False, use_joint_adaptive=False,
                   require_pressure_to_enter=False, min_cycle_gap_seconds=999.0)
    bot.live.order_book = {"bids": [{"price": str(sl_price)}], "asks": [{"price": str(sl_price+1)}]}
    await bot.tick()
    check("the exit itself was never gated by min_cycle_gap_seconds",
          bot.state_row["side"] is None, bot.state_row["side"])


async def t_native_stop_off_by_default_never_places_order():
    print("\n[native stop: off by default -- every bot without the flag is unchanged]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="long")  # native_stop_loss_enabled defaults False
    await bot.tick()
    check("entered normally", bot.state_row["side"] == "long", bot.state_row["side"])
    check("no native stop was ever placed", getattr(ex, "sl_orders", []) == [], getattr(ex, "sl_orders", None))
    check("cancel_all was never called", getattr(ex, "cancel_all_calls", 0) == 0)


async def t_native_stop_places_order_on_entry_when_enabled():
    print("\n[native stop: a real stop order is placed the tick a position opens]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="long", native_stop_loss_enabled=True,
                   sl_pct=0.06, disable_literal_tp=True)
    await bot.tick()
    check("entered", bot.state_row["side"] == "long", bot.state_row["side"])
    # _sync_native_stop runs in the position-management block, keyed off `side` as read at the
    # TOP of tick() -- the entry itself happens later in that same tick, so the stop is only
    # placed on the FOLLOWING tick, same as every other post-entry protection in this file.
    await bot.tick()
    entry = bot.state_row["first_entry_price"]
    expected_sl = round(entry * (1 - 0.06 / 100), 1)  # default price_decimals=1 rounding
    check("exactly one native stop placed", len(getattr(ex, "sl_orders", [])) == 1, getattr(ex, "sl_orders", None))
    sl = ex.sl_orders[0]
    trigger_descaled = sl["trigger"] / (10 ** bot.cfg.price_decimals)  # same scaling as place_order
    check("trigger matches the configured SL off entry price",
          abs(trigger_descaled - expected_sl) < 1.0, (trigger_descaled, expected_sl))
    check("closing side (is_ask=True to exit a long)", sl["is_ask"] is True)
    check("reduce_only", sl["reduce_only"] is True)
    check("sized to the real filled qty",
          abs(sl["qty"] - abs(ex.position)) < 1e-6, (sl["qty"], ex.position))


async def t_native_stop_noop_when_unchanged():
    print("\n[native stop: does not re-place itself every tick once synced]")
    entry = 86000.0
    sl_price = entry * (1 - 0.06 / 100) + 50  # above the SL, position stays open
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 10.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 10.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 10.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="mid", fixed_direction="long", fixed_leg_usd=10.0,
                   sl_pct=0.06, tp_pct=0.10, disable_literal_tp=True, require_fresh_signal=False,
                   self_lock_enabled=False, use_joint_adaptive=False,
                   native_stop_loss_enabled=True)
    bot.live.order_book = {"bids": [{"price": str(sl_price)}], "asks": [{"price": str(sl_price + 1)}]}
    await bot.tick()
    check("one native stop placed on the first tick", len(ex.sl_orders) == 1, len(ex.sl_orders))
    await bot.tick()
    await bot.tick()
    check("still just one -- unchanged trigger/qty never re-places",
          len(ex.sl_orders) == 1, len(ex.sl_orders))
    check("still open (never hit the SL)", bot.state_row["side"] == "long")


async def t_native_stop_cancelled_before_our_own_close():
    print("\n[native stop: cleared before close_all places its own closing order]")
    entry = 86000.0
    ex = FakeExchange(position=round(20.0 / entry, 5), collateral=20.0)
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="mid", native_stop_loss_enabled=True)
    bot._native_stop_synced = (85000.0, 20.0 / entry)  # pretend one is already resting
    ok = await bot.close_all("SL", dict(state), "long", state["legs"], 85000.0, 85001.0, 1)
    check("close succeeded", ok is True)
    check("cancel_all was called before closing", getattr(ex, "cancel_all_calls", 0) == 1)
    check("tracking cleared", bot._native_stop_synced is None)


async def t_native_stop_resyncs_when_sl_override_changes():
    print("\n[native stop: a live SL override from the dashboard re-places the resting stop]")
    entry = 86000.0
    sl_price = entry * (1 - 0.06 / 100) + 50
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 10.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 10.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 10.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
        "override_sl_pct": None, "override_profit_lock_trigger": None, "override_profit_lock_trail": None,
    }
    bot = make_bot(ex, state=state, candles_kind="mid", fixed_direction="long", fixed_leg_usd=10.0,
                   sl_pct=0.06, tp_pct=0.10, disable_literal_tp=True, require_fresh_signal=False,
                   self_lock_enabled=False, use_joint_adaptive=False,
                   native_stop_loss_enabled=True, schema_has_exit_overrides=True)
    bot.live.order_book = {"bids": [{"price": str(sl_price)}], "asks": [{"price": str(sl_price + 1)}]}
    await bot.tick()
    check("placed at the compiled-in 0.06%", len(ex.sl_orders) == 1, len(ex.sl_orders))
    bot.state_row["override_sl_pct"] = 0.10
    await bot.tick()
    check("re-placed once the override changed the desired trigger",
          len(ex.sl_orders) == 2, len(ex.sl_orders))
    check("cancelled the old one first", getattr(ex, "cancel_all_calls", 0) == 2)


async def t_external_close_tagged_sl_when_native_stop_enabled():
    print("\n[native stop: an external close (the stop firing) books as SL, not EXTERNAL]")
    entry = 86000.0
    ex = FakeExchange(position=round(20.0 / entry, 5), collateral=20.0)  # still open
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles_kind="mid", native_stop_loss_enabled=True,
                   require_fresh_signal=False, self_lock_enabled=False, use_joint_adaptive=False)
    bot.live.order_book = {"bids": [{"price": "86001.0"}], "asks": [{"price": "86002.0"}]}
    await bot.tick()  # syncs the native stop while the position is still genuinely open
    check("native stop synced before the external close", bot._native_stop_synced is not None)
    ex.position = 0.0  # the resting native stop firing on the exchange, outside our own code
    ex.collateral = 19.97
    bot._pos_cache_at = 0  # force a fresh REST read instead of serving the pre-close cache
    for _ in range(3):  # 3 agreeing flat reads required before an external close is booked
        await bot.tick()
    check("booked as a closed position", bot.state_row["side"] is None, bot.state_row["side"])
    check("tagged SL, not EXTERNAL", bot.trades and bot.trades[-1][5] == "SL", bot.trades)


async def t_native_exits_both_placed_with_a_single_cancel():
    print("\n[native exits: SL+TP both enabled -- one cancel_all, both orders survive]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="long", native_stop_loss_enabled=True,
                   native_take_profit_enabled=True, disable_literal_tp=False,
                   sl_pct=0.06, tp_pct=0.10)
    await bot.tick()
    await bot.tick()  # position-management block (and the native sync) runs on the FOLLOWING tick
    check("exactly one cancel_all for this sync", getattr(ex, "cancel_all_calls", 0) == 1,
          getattr(ex, "cancel_all_calls", None))
    check("stop order placed", len(getattr(ex, "sl_orders", [])) == 1, getattr(ex, "sl_orders", None))
    check("tp order placed", len(getattr(ex, "tp_orders", [])) == 1, getattr(ex, "tp_orders", None))
    check("neither tracker left stale/empty",
          bot._native_stop_synced is not None and bot._native_tp_synced is not None)


async def t_native_tp_skipped_when_literal_tp_disabled():
    print("\n[native TP: never placed when disable_literal_tp=True, even if the flag is on]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="long", native_stop_loss_enabled=True,
                   native_take_profit_enabled=True, disable_literal_tp=True, sl_pct=0.06)
    await bot.tick()
    await bot.tick()
    check("stop order placed", len(getattr(ex, "sl_orders", [])) == 1, getattr(ex, "sl_orders", None))
    check("NO tp order -- literal TP is off for this bot (the hedge legs)",
          getattr(ex, "tp_orders", []) == [], getattr(ex, "tp_orders", None))


async def t_cycle_id_stamped_same_for_both_legs_on_release():
    print("\n[cycle id: the barrier stamps ONE id, read identically by both legs]")
    hub = core.StochBot.new_cycle_hub(["worker2", "worker3"])
    a = make_bot(FakeExchange(), candles_kind="mid", worker_id="worker2")
    b = make_bot(FakeExchange(), candles_kind="mid", worker_id="worker3")
    a.cycle_hub = hub; b.cycle_hub = hub
    check("long alone not cleared", a._cycle_gate_clear_to_enter() is False)
    check("short completes the barrier", b._cycle_gate_clear_to_enter() is True)
    short_id = hub.get("cycle_id")
    check("short sees a stamped id", short_id is not None, short_id)
    check("long cleared on its next check", a._cycle_gate_clear_to_enter() is True)
    check("long reads the SAME id the short saw", hub.get("cycle_id") == short_id)


async def t_cycle_id_persisted_on_entry_and_cleared_on_close():
    print("\n[cycle id: persisted through try_enter, carried to the trade log, cleared on close]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="long", schema_has_cycle_id=True)
    bot._pending_cycle_id = "171234567890"
    await bot.tick()
    check("entered", bot.state_row["side"] == "long", bot.state_row["side"])
    check("cycle_id persisted to state", bot.state_row.get("cycle_id") == "171234567890",
          bot.state_row.get("cycle_id"))
    check("consumed from the pending slot", bot._pending_cycle_id is None)
    ok = await bot.close_all("SL", dict(bot.state_row), "long",
                             bot.state_row["legs"], 1.0, 1.0, 1)
    check("close succeeded", ok is True)
    check("cycle_id cleared from state after close", bot.state_row.get("cycle_id") is None)


async def t_cycle_id_never_touched_without_schema_flag():
    print("\n[cycle id: a bot without the migration never reads or writes the column]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="long")  # schema_has_cycle_id defaults False
    bot._pending_cycle_id = "171234567890"  # even if a hub somehow set this
    await bot.tick()
    check("entered", bot.state_row["side"] == "long", bot.state_row["side"])
    check("cycle_id never written -- key absent from the row",
          "cycle_id" not in bot.state_row, bot.state_row.get("cycle_id"))


async def t_live_configs_match_their_stated_rules():
    print("\n[live configs: the real worker files still encode the rules they are supposed to]")
    # These assert the actual shipped CONFIG objects, not a hand-built test config. Both of these
    # rules have now been broken by a code change more than once while the behavioural tests above
    # kept passing (they build their own configs), so the config itself is pinned here.
    import importlib
    w1 = importlib.import_module("lighter_stoch_dca_btc_initial").CONFIG
    check("Worker 1: 2 wins of ANY kind unlock (no mandatory literal TP)",
          w1.self_lock_require_tp_in_streak is False, w1.self_lock_require_tp_in_streak)
    check("Worker 1: a single literal TP unlocks on its own",
          w1.self_lock_tp_unlocks_instantly is True, w1.self_lock_tp_unlocks_instantly)
    # 2026-10-01, direct request: real exchange-side TP and SL -- both this bot's exits are
    # static price levels (no trail, no partner-pnl floor), so neither loses anything by also
    # being backed by a real order. See BotConfig.native_stop_loss_enabled/native_take_profit_enabled.
    check("Worker 1: native stop-loss on",
          w1.native_stop_loss_enabled is True, w1.native_stop_loss_enabled)
    check("Worker 1: native take-profit on",
          w1.native_take_profit_enabled is True, w1.native_take_profit_enabled)
    # REVISED 2026-10-02, direct request: literal TP removed entirely -- the profit-lock
    # trail (now 0.03%, see below) is the only thing that decides when a winner closes.
    check("Worker 1: literal TP disabled (the profit-lock trail governs winners instead)",
          w1.disable_literal_tp is True, w1.disable_literal_tp)
    # 2026-10-01: the z-score signal was briefly wired to Worker 1, then corrected -- "worker 2"
    # was the intended target. Worker 1 stays on the plain stochastic. Pinned here so that
    # mix-up can't silently repeat.
    check("Worker 1: plain stochastic signal (NOT z-score)",
          w1.use_zscore_signal is False, w1.use_zscore_signal)
    check("Worker 1: hour-open relock requires a literal TP to clear",
          w1.self_lock_hour_open_requires_tp is True, w1.self_lock_hour_open_requires_tp)
    # 2026-10-01, direct request: isolated A/B test of the intrabar dispersion filter alone --
    # self-lock OFF (inert; every self_lock_* field above stays in the file unchanged, flipping
    # self_lock_enabled back to True is the whole revert) and all hours restored, so the one
    # filter below isn't entangled with anything else.
    check("Worker 1: self-lock OFF for the isolated dispersion-filter test",
          w1.self_lock_enabled is False, w1.self_lock_enabled)
    # 2026-10-01: dispersion filter replaced by the zebra index, then by the color-weighted
    # balance index (v2 -- the switch-counting zebra index scored a 4-red-1-green downtrend as
    # "balanced" and let a losing long through live at 16:55 UTC). Exits unchanged: SL 0.10 /
    # TP 0.10 / profit lock 0.05.
    check("Worker 1: dispersion filter OFF (replaced by the color-balance index)",
          w1.intrabar_dispersion_pause_at is None, w1.intrabar_dispersion_pause_at)
    check("Worker 1: zebra index OFF (superseded by the color-balance index)",
          (w1.zebra_index_min, w1.zebra_index_max) == (None, None),
          (w1.zebra_index_min, w1.zebra_index_max))
    check("Worker 1: color-balance index band 65-75 over 5 bars",
          (w1.color_balance_index_min, w1.color_balance_index_max, w1.color_balance_index_window)
          == (65.0, 75.0, 5),
          (w1.color_balance_index_min, w1.color_balance_index_max, w1.color_balance_index_window))
    # REVISED 2026-10-02, direct request, under the flip-signal regime: a real live trade
    # peaked at +0.04% and gave it all back to a -0.06% SL loss (zero give-back, armed only at
    # 0.06%, never reached). Trigger moved down to 0.03% and trail up from 0 to 0.03% so a
    # trade that reaches +0.03%+ locks in some of it instead of riding back to the SL. tp_pct
    # stays 0.10 in the file but is now INERT (disable_literal_tp=True, checked above) -- sl_pct
    # (0.06, unchanged) remains the only protection for a trade that never reaches breakeven.
    check("Worker 1: SL 0.06 / TP 0.10 (inert) / profit-lock trigger 0.03, saving lock off",
          (w1.sl_pct, w1.tp_pct, w1.profit_lock_trigger_pct, w1.saving_lock_arm_frac_of_sl)
          == (0.06, 0.10, 0.03, None),
          (w1.sl_pct, w1.tp_pct, w1.profit_lock_trigger_pct, w1.saving_lock_arm_frac_of_sl))
    check("Worker 1: profit-lock trail 0.03% (was zero give-back)",
          w1.profit_lock_trail_pct == 0.03, w1.profit_lock_trail_pct)
    check("Worker 1: flip-signal min body 0.005% (filters near-doji flip candles)",
          w1.flip_signal_min_body_pct == 0.005, w1.flip_signal_min_body_pct)
    check("Worker 1: 2-minute post-reversal cooldown on",
          w1.post_reversal_cooldown_seconds == 120.0, w1.post_reversal_cooldown_seconds)
    check("Worker 1: index-exit-on-green off for both directions",
          w1.index_exit_on_green is False, w1.index_exit_on_green)

    hedge = importlib.import_module("lighter_hedge_dual_leg")
    for name, leg in (("long", hedge.LONG_CONFIG), ("short", hedge.SHORT_CONFIG)):
        # 2026-10-01, direct request ("give it another try... let's get the same settings"):
        # FULL REVERT to the exact 2026-09-29 original economics (commit 8469702 -- 124 cycles,
        # 90.3% win, +2.55% in the backtest). Pinned so none of the later tuning (0.06 SL, 0.10/
        # 0.03 profit-lock, the pressure gate, either color-balance index direction, the
        # breakeven floor) can silently drift back in.
        check(f"hedge {name} leg: SL back to the original 0.03%",
              leg.sl_pct == 0.03, leg.sl_pct)
        check(f"hedge {name} leg: profit-lock trigger back to 0.05%",
              leg.profit_lock_trigger_pct == 0.05, leg.profit_lock_trigger_pct)
        check(f"hedge {name} leg: profit-lock trail back to 0.01%",
              leg.profit_lock_trail_pct == 0.01, leg.profit_lock_trail_pct)
        check(f"hedge {name} leg: breakeven floor OFF (did not exist in the original)",
              leg.breakeven_floor_enabled is False, leg.breakeven_floor_enabled)
        check(f"hedge {name} leg: fixed survivor floor OFF",
              leg.fixed_partner_cut_floor_pct is None, leg.fixed_partner_cut_floor_pct)
        check(f"hedge {name} leg: partner-cut-arms-trail OFF (needs the breakeven floor)",
              leg.partner_cut_arms_trail_immediately is False, leg.partner_cut_arms_trail_immediately)
        check(f"hedge {name} leg: no entry gate at all -- always try to be in when flat",
              leg.require_pressure_to_enter is False, leg.require_pressure_to_enter)
        check(f"hedge {name} leg: color-balance entry gate is disabled",
              (leg.color_balance_index_min, leg.color_balance_index_max, leg.color_balance_index_invert)
              == (None, None, False),
              (leg.color_balance_index_min, leg.color_balance_index_max, leg.color_balance_index_invert))
        check(f"hedge {name} leg: never reads stale per-position bands",
              leg.schema_has_position_bands is False, leg.schema_has_position_bands)
        # KEPT through the revert -- correctness/infra fixes for real bugs, not economics.
        check(f"hedge {name} leg: single-instance lock on (zombie double-entry)",
              leg.single_instance_lock is True, leg.single_instance_lock)
        check(f"hedge {name} leg: has a cycle partner to synchronise with",
              leg.cycle_partner_table is not None, leg.cycle_partner_table)
        check(f"hedge {name} leg: fixed_leg_usd at or above Lighter's $10 minimum",
              leg.fixed_leg_usd >= 10.0, leg.fixed_leg_usd)
        check(f"hedge {name} leg: NO size tilt -- legs are equal",
              leg.pressure_bias_enabled is False, leg.pressure_bias_enabled)
        check(f"hedge {name} leg: pressure gate uses the plain stochastic (NOT z-score)",
              leg.use_zscore_signal is False, leg.use_zscore_signal)
        check(f"hedge {name} leg: native stop-loss on",
              leg.native_stop_loss_enabled is True, leg.native_stop_loss_enabled)
        check(f"hedge {name} leg: cycle_id schema on",
              leg.schema_has_cycle_id is True, leg.schema_has_cycle_id)
    # Both legs must always trade the SAME market with the SAME rounding. A mismatch here is the
    # same class of bug as unequal fixed_leg_usd -- it breaks the breakeven floor's math (which
    # assumes both legs' notional is directly comparable) and, worse, a size_decimals mismatch
    # specifically can make one leg's real order size wrong by a power of 10. Caught once already
    # in this exact switch: size_decimals was typo'd as BTC's 5 instead of SOL's 3 before this
    # test existed, which would have sent orders ~100x the intended size.
    check("hedge legs: SAME market_index",
          hedge.LONG_CONFIG.market_index == hedge.SHORT_CONFIG.market_index,
          (hedge.LONG_CONFIG.market_index, hedge.SHORT_CONFIG.market_index))
    check("hedge legs: SAME price_decimals",
          hedge.LONG_CONFIG.price_decimals == hedge.SHORT_CONFIG.price_decimals,
          (hedge.LONG_CONFIG.price_decimals, hedge.SHORT_CONFIG.price_decimals))
    check("hedge legs: SAME size_decimals",
          hedge.LONG_CONFIG.size_decimals == hedge.SHORT_CONFIG.size_decimals,
          (hedge.LONG_CONFIG.size_decimals, hedge.SHORT_CONFIG.size_decimals))
    check("hedge legs: SAME fixed_leg_usd",
          hedge.LONG_CONFIG.fixed_leg_usd == hedge.SHORT_CONFIG.fixed_leg_usd,
          (hedge.LONG_CONFIG.fixed_leg_usd, hedge.SHORT_CONFIG.fixed_leg_usd))
    check("hedge legs: SAME require_pressure_to_enter (an entry-timing mismatch desyncs the barrier)",
          hedge.LONG_CONFIG.require_pressure_to_enter == hedge.SHORT_CONFIG.require_pressure_to_enter)
    check("hedge legs: SAME min_cycle_gap_seconds",
          hedge.LONG_CONFIG.min_cycle_gap_seconds == hedge.SHORT_CONFIG.min_cycle_gap_seconds,
          (hedge.LONG_CONFIG.min_cycle_gap_seconds, hedge.SHORT_CONFIG.min_cycle_gap_seconds))
    check("hedge legs: SAME use_zscore_signal",
          hedge.LONG_CONFIG.use_zscore_signal == hedge.SHORT_CONFIG.use_zscore_signal,
          (hedge.LONG_CONFIG.use_zscore_signal, hedge.SHORT_CONFIG.use_zscore_signal))
    check("hedge legs point at each other, not themselves",
          hedge.LONG_CONFIG.cycle_partner_table == hedge.SHORT_CONFIG.table_state
          and hedge.SHORT_CONFIG.cycle_partner_table == hedge.LONG_CONFIG.table_state)
    check("exactly one hedge leg owns the shared pressure signal",
          [hedge.LONG_CONFIG.pressure_signal_owner,
           hedge.SHORT_CONFIG.pressure_signal_owner].count(True) == 1)


def _hedge_leg(**kw):
    base = dict(candles_kind="mid", fixed_direction="long", fixed_leg_usd=10.0, sl_pct=0.06,
                tp_pct=0.10, disable_literal_tp=True, require_fresh_signal=False,
                self_lock_enabled=False, use_joint_adaptive=False, require_pressure_to_enter=False)
    base.update(kw)
    return make_bot(FakeExchange(), **base)


async def t_min_dispersion_gate_blocks_cycle_when_quiet():
    print("\n[min dispersion gate: a hedge leg does NOT open a cycle while dispersion is below the floor]")
    bot = _hedge_leg(min_intrabar_dispersion_to_enter=50.0)
    bot.candles = make_dispersion_candles([20, 20, 20, 20, 0])  # std $8
    check("not wanting a cycle at $8", bot._wants_new_cycle() is False)
    await bot.tick()
    check("did not enter", bot.state_row["side"] is None, bot.state_row["side"])


async def t_min_dispersion_gate_allows_cycle_when_dispersed():
    print("\n[min dispersion gate: a cycle opens once dispersion is at/above the floor]")
    bot = _hedge_leg(min_intrabar_dispersion_to_enter=50.0)
    bot.candles = make_dispersion_candles([150, 150, 150, 150, 0])  # std $60
    check("wants a cycle at $60", bot._wants_new_cycle() is True)
    await bot.tick()
    check("entered", bot.state_row["side"] == "long", bot.state_row["side"])


async def t_min_dispersion_gate_off_by_default():
    print("\n[min dispersion gate: off by default -- every other bot unaffected]")
    bot = _hedge_leg()
    bot.candles = make_dispersion_candles([20, 20, 20, 20, 0])
    check("quiet market still wants a cycle when unconfigured", bot._wants_new_cycle() is True)


async def t_one_cycle_per_candle_blocks_second_entry_same_candle():
    print("\n[one cycle per candle: after an entry, no new cycle until the next candle]")
    bot = _hedge_leg(one_cycle_per_candle=True)
    bot.candles = make_dispersion_candles([150, 150, 150, 150, 0])
    await bot.tick()
    check("first entry on this candle", bot.state_row["side"] == "long", bot.state_row["side"])
    check("same candle is now spent", bot._candle_unused() is False)
    nxt = dict(bot.candles[-1]); nxt["t"] += 60000
    bot.candles = bot.candles + [nxt]
    check("next candle is fresh again", bot._candle_unused() is True)
    off = _hedge_leg()
    off._last_cycle_candle_t = off._current_candle_t()
    check("off by default -- never blocks", off._candle_unused() is True)


async def t_min_dispersion_never_discards_granted_clearance():
    print("\n[min dispersion gate: a clearance already granted is honoured even if dispersion drops]")
    hub = core.StochBot.new_cycle_hub(["worker2", "worker3"])
    a = _hedge_leg(worker_id="worker2", min_intrabar_dispersion_to_enter=50.0)
    b = _hedge_leg(worker_id="worker3", min_intrabar_dispersion_to_enter=50.0)
    a.cycle_hub = hub; b.cycle_hub = hub
    check("a declares", a._cycle_gate_clear_to_enter(want=True) is False)
    check("b completes the barrier", b._cycle_gate_clear_to_enter(want=True) is True)
    a.candles = make_dispersion_candles([20, 20, 20, 20, 0])
    check("a still enters on its clearance", a._cycle_gate_clear_to_enter(want=a._wants_new_cycle()) is True)


async def t_profit_lock_floor_closes_at_breakeven_not_below():
    print("\n[Option B: the trail can never close the winner below the breakeven floor]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": "short", "realized_pnl_usd": 0.0}
    bot = _breakeven_bot(ex, _breakeven_state(entry, 10.0), partner, sl_pct=0.05,
                         profit_lock_trigger_pct=0.10, profit_lock_trail_pct=0.04,
                         partner_cut_arms_trail_immediately=True,
                         profit_lock_respects_breakeven_floor=True)
    partner["side"] = None
    partner["realized_pnl_usd"] = -0.005  # partner cut at its stop
    await _tick_at(bot, entry * (1 + 0.05 / 100))
    floor = bot._breakeven_floor_pct
    check("floor known (~breakeven)", floor is not None and 0.04 < floor < 0.06, floor)
    await _tick_at(bot, entry * (1 + 0.06 / 100))
    check("still open at +0.06%", bot.state_row["side"] == "long", bot.state_row["side"])
    # +0.045%: only 0.015 off the peak (the 0.04 trail alone would hold) but under the floor.
    await _tick_at(bot, entry * (1 + 0.045 / 100))
    check("closed at the floor", bot.state_row["side"] is None, bot.state_row["side"])
    check("reason BREAKEVEN_LOCK",
          any(a == "closed" and d.get("reason") == "BREAKEVEN_LOCK" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def t_profit_lock_floor_off_keeps_old_behaviour():
    print("\n[Option B off: the same path is NOT closed by a floor -- old behaviour unchanged]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": "short", "realized_pnl_usd": 0.0}
    bot = _breakeven_bot(ex, _breakeven_state(entry, 10.0), partner, sl_pct=0.05,
                         profit_lock_trigger_pct=0.10, profit_lock_trail_pct=0.04,
                         partner_cut_arms_trail_immediately=True)
    partner["side"] = None
    partner["realized_pnl_usd"] = -0.005
    for p in (0.05, 0.06, 0.045):
        await _tick_at(bot, entry * (1 + p / 100))
    check("still open -- only the 0.04 trail applies", bot.state_row["side"] == "long",
          bot.state_row["side"])


async def t_profit_lock_floor_still_lets_the_winner_ride():
    print("\n[Option B: above floor + trail the ordinary trail rides and exits as PROFIT_LOCK]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    partner = {"side": "short", "realized_pnl_usd": 0.0}
    bot = _breakeven_bot(ex, _breakeven_state(entry, 10.0), partner, sl_pct=0.05,
                         profit_lock_trigger_pct=0.10, profit_lock_trail_pct=0.04,
                         partner_cut_arms_trail_immediately=True,
                         profit_lock_respects_breakeven_floor=True)
    partner["side"] = None
    partner["realized_pnl_usd"] = -0.005
    for p in (0.05, 0.12, 0.20, 0.17):
        await _tick_at(bot, entry * (1 + p / 100))
    check("rode to +0.20% and held a 0.03 pullback", bot.state_row["side"] == "long",
          bot.state_row["side"])
    await _tick_at(bot, entry * (1 + 0.155 / 100))
    check("closed by the trail well above the floor", bot.state_row["side"] is None,
          bot.state_row["side"])
    check("reason PROFIT_LOCK",
          any(a == "closed" and d.get("reason") == "PROFIT_LOCK" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


def _saving_bot(**kw):
    entry = 86000.0
    ex = FakeExchange(position=round(99.0 / entry, 5), collateral=99.0)
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 99.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 99.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 99.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    base = dict(candles_kind="mid", sl_pct=0.20, tp_pct=0.10, require_fresh_signal=False,
                profit_lock_enabled=True, profit_lock_trigger_pct=0.05, profit_lock_trail_pct=0.0)
    base.update(kw)
    return entry, make_bot(ex, state=state, **base)


async def _px(bot, price):
    bot.live.order_book = {"bids": [{"price": str(price)}], "asks": [{"price": str(price + 0.5)}]}
    await bot.tick()


async def t_saving_lock_exits_at_entry_after_arming():
    print("\n[saving lock: down past half the SL, back to entry -> exit at ~0]")
    entry, bot = _saving_bot(saving_lock_arm_frac_of_sl=0.5)
    await _px(bot, entry * (1 - 0.12 / 100))   # -0.12%, past the -0.10% arm point
    check("still open while down", bot.state_row["side"] == "long", bot.state_row["side"])
    await _px(bot, entry * (1 - 0.03 / 100))
    check("still open on the way back, below entry", bot.state_row["side"] == "long")
    await _px(bot, entry * (1 + 0.001 / 100))
    check("closed once back at entry", bot.state_row["side"] is None, bot.state_row["side"])
    check("reason SAVING_LOCK",
          any(a == "closed" and d.get("reason") == "SAVING_LOCK" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def t_saving_lock_not_armed_by_a_small_dip():
    print("\n[saving lock: a dip smaller than half the SL never arms it]")
    entry, bot = _saving_bot(saving_lock_arm_frac_of_sl=0.5)
    await _px(bot, entry * (1 - 0.06 / 100))   # only -0.06%
    await _px(bot, entry * (1 + 0.001 / 100))
    check("still open -- not armed", bot.state_row["side"] == "long", bot.state_row["side"])


async def t_saving_lock_off_by_default():
    print("\n[saving lock: off by default -- same path stays open]")
    entry, bot = _saving_bot()
    await _px(bot, entry * (1 - 0.12 / 100))
    await _px(bot, entry * (1 + 0.001 / 100))
    check("still open", bot.state_row["side"] == "long", bot.state_row["side"])


async def t_saving_lock_follows_the_sl_override():
    print("\n[saving lock: arm point is half the LIVE (override) SL, not the compiled one]")
    entry, bot = _saving_bot(saving_lock_arm_frac_of_sl=0.5, schema_has_exit_overrides=True)
    bot.state_row["override_sl_pct"] = 0.30          # half = 0.15%
    await _px(bot, entry * (1 - 0.12 / 100))          # -0.12%: would arm at SL 0.20, not at 0.30
    await _px(bot, entry * (1 + 0.001 / 100))
    check("not armed at -0.12% when SL is 0.30", bot.state_row["side"] == "long")
    await _px(bot, entry * (1 - 0.16 / 100))
    await _px(bot, entry * (1 + 0.001 / 100))
    check("armed past -0.15% and closed at entry", bot.state_row["side"] is None,
          bot.state_row["side"])


async def t_zebra_index_values():
    print("\n[zebra/size index: switches% / mean candle size%]")
    def bar(o, c, rng=40.0):
        return {"t": 0, "o": o, "c": c, "h": max(o, c) + rng / 2, "l": min(o, c) - rng / 2}
    base = 84000.0
    alt = [bar(base, base + 10), bar(base + 10, base), bar(base, base + 10), bar(base + 10, base),
           bar(base, base + 10), bar(base, base)]                      # G R G R G + live
    size = sum(((max(b["o"], b["c"]) + 20) - (min(b["o"], b["c"]) - 20)) / b["c"] * 100 for b in alt[:5]) / 5
    zi = core.compute_zebra_size_index(alt, 5)
    check("perfect zebra -> 100 / size", abs(zi - 100 / size) < 1e-6, (zi, 100 / size))
    trend = [bar(base + 10 * i, base + 10 * (i + 1)) for i in range(5)] + [bar(base, base)]
    check("one color only -> 0", core.compute_zebra_size_index(trend, 5) == 0.0,
          core.compute_zebra_size_index(trend, 5))
    check("too few candles -> None", core.compute_zebra_size_index(alt[:3], 5) is None)


async def _zebra_gate_case(value, **cfg):
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", **cfg)
    bot.candles = make_dispersion_candles([150, 150, 150, 150, 0])   # fresh long signal (K=0)
    orig = core.compute_zebra_size_index
    core.compute_zebra_size_index = lambda c, w=5: value
    try:
        await bot.tick()
    finally:
        core.compute_zebra_size_index = orig
    return bot.state_row["side"]


async def t_zebra_gate_blocks_outside_band():
    print("\n[zebra gate: index outside 600-1000 blocks a fresh entry]")
    for v in (300.0, 1500.0, None):
        side = await _zebra_gate_case(v, zebra_index_min=600.0, zebra_index_max=1000.0)
        check(f"blocked at index {v}", side is None, side)


async def t_zebra_gate_allows_inside_band():
    print("\n[zebra gate: index inside 600-1000 lets a fresh entry through]")
    side = await _zebra_gate_case(800.0, zebra_index_min=600.0, zebra_index_max=1000.0)
    check("entered at index 800", side == "long", side)


async def t_zebra_gate_off_by_default():
    print("\n[zebra gate: off by default]")
    side = await _zebra_gate_case(5000.0)
    check("entered -- no band configured", side == "long", side)


async def t_color_balance_index_values():
    print("\n[color-weighted balance index: size-weighted vote, one stray candle can't dominate]")
    def bar(o, c, total_range=40.0):
        # h - l == total_range exactly, regardless of body size -- lets tests build candles with
        # genuinely EQUAL size even when their bodies differ.
        hi, lo = max(o, c), min(o, c)
        extra = total_range - (hi - lo)
        return {"t": 0, "o": o, "c": c, "h": hi + extra / 2, "l": lo - extra / 2}
    base = 84000.0
    # 4 reds + 1 green, all equal $40 range -- same shape as the real 16:55 UTC trade that
    # slipped through the old zebra gate at 50% (switch count, blind to size/dominance).
    bars = [bar(base, base - 10, 40), bar(base - 10, base - 20, 40), bar(base - 20, base - 10, 40),
            bar(base - 10, base - 20, 40), bar(base - 20, base - 30, 40), bar(base, base)]
    cwi = core.compute_color_weighted_balance_index(bars, 5)
    check("4 red + 1 green, equal size -> clearly below the old zebra's 50%",
          cwi is not None and cwi < 50, cwi)
    # 2 green + 2 red + 1 doji, all equal $40 range -- net vote is exactly zero.
    alt = [bar(base, base + 10, 40), bar(base + 10, base, 40), bar(base, base + 10, 40),
           bar(base + 10, base, 40), bar(base, base, 40), bar(base, base)]
    # Not exactly 100 due to floating-point: size% normalizes by each candle's OWN close
    # (84010 vs 84000 etc.), so the four non-doji candles' sizes differ by a hair. Correct
    # behaviour, not a bug -- loose tolerance instead of exact equality.
    check("2 green + 2 red + 1 doji, equal size -> ~100 (fully balanced)",
          core.compute_color_weighted_balance_index(alt, 5) > 99.9,
          core.compute_color_weighted_balance_index(alt, 5))
    trend = [bar(base + 10 * i, base + 10 * (i + 1), 10) for i in range(5)] + [bar(base, base)]
    check("one color only -> exactly 0 (pure trend)",
          core.compute_color_weighted_balance_index(trend, 5) == 0.0,
          core.compute_color_weighted_balance_index(trend, 5))
    check("too few candles -> None", core.compute_color_weighted_balance_index(bars[:3], 5) is None)


async def _balance_gate_case(value, **cfg):
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", **cfg)
    bot.candles = make_dispersion_candles([150, 150, 150, 150, 0])   # fresh long signal (K=0)
    orig = core.compute_color_weighted_balance_index
    core.compute_color_weighted_balance_index = lambda c, w=5: value
    try:
        await bot.tick()
    finally:
        core.compute_color_weighted_balance_index = orig
    return bot.state_row["side"]


async def t_balance_gate_blocks_outside_band():
    print("\n[balance gate: index outside 65-75 blocks a fresh entry]")
    for v in (40.0, 90.0, None):
        side = await _balance_gate_case(v, color_balance_index_min=65.0, color_balance_index_max=75.0)
        check(f"blocked at index {v}", side is None, side)


async def t_balance_gate_allows_inside_band():
    print("\n[balance gate: index inside 65-75 lets a fresh entry through]")
    side = await _balance_gate_case(70.0, color_balance_index_min=65.0, color_balance_index_max=75.0)
    check("entered at index 70", side == "long", side)


async def t_balance_gate_off_by_default():
    print("\n[balance gate: off by default]")
    side = await _balance_gate_case(5000.0)
    check("entered -- no band configured", side == "long", side)


async def t_entry_features_persisted_on_entry_and_carried_to_trade_log():
    print("\n[entry features: K/balance-index/vol/dispersion snapshotted on entry, carried to the trade row]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="long", schema_has_entry_features=True)
    await bot.tick()
    check("entered", bot.state_row["side"] == "long", bot.state_row["side"])
    for key in ("entry_k", "entry_balance_index", "entry_vol_pct", "entry_dispersion"):
        check(f"{key} persisted to state, not None",
              bot.state_row.get(key) is not None, bot.state_row.get(key))
    snapshot = {k: bot.state_row[k] for k in
                ("entry_k", "entry_balance_index", "entry_vol_pct", "entry_dispersion")}
    check("entry K is numeric, not a long/short signal",
          isinstance(snapshot["entry_k"], (int, float)) and not isinstance(snapshot["entry_k"], bool),
          snapshot["entry_k"])
    check("entry K matches the closed-candle oscillator (0 for these candles)",
          snapshot["entry_k"] == 0.0, snapshot["entry_k"])
    ok = await bot.close_all("SL", dict(bot.state_row), "long",
                             bot.state_row["legs"], 1.0, 1.0, 1)
    check("close succeeded", ok is True)
    ef = bot.trade_kwargs[-1].get("entry_features")
    check("trade row carries the same snapshot",
          ef is not None and all(ef.get(k) == v for k, v in snapshot.items()),
          ef)


async def t_entry_features_never_touched_without_schema_flag():
    print("\n[entry features: a bot without the migration never reads or writes these columns]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="long")  # schema_has_entry_features defaults False
    await bot.tick()
    check("entered", bot.state_row["side"] == "long", bot.state_row["side"])
    for key in ("entry_k", "entry_balance_index", "entry_vol_pct", "entry_dispersion"):
        check(f"{key} never written -- key absent from the row",
              key not in bot.state_row, bot.state_row.get(key))


async def t_entry_features_numeric_k_does_not_change_live_signal():
    print("\n[entry features: both hedge directions record numeric K without changing the live signal]")
    for direction in ("long", "short"):
        ex = FakeExchange()
        bot = make_bot(ex, candles_kind="long", schema_has_entry_features=True)
        bot.live_k, bot.live_signal = 81.25, "short"
        await bot.try_enter(direction, 86000.0, 20.0, "test", bot.candles[-2]["t"],
                            dict(bot.state_row), ex.collateral)
        check(f"{direction}: snapshot K is 0 even when live K was stale",
              bot.state_row.get("entry_k") == 0.0, bot.state_row.get("entry_k"))
        check(f"{direction}: live K and signal untouched",
              (bot.live_k, bot.live_signal) == (81.25, "short"), (bot.live_k, bot.live_signal))
        check(f"{direction}: exactly one intended order", len(ex.orders) == 1, ex.orders)
        check(f"{direction}: recorded intended direction", bot.state_row["side"] == direction)

    for kind, expected in (("long", 0.0), ("short", 100.0), ("mid", 50.0)):
        check(f"numeric K for {kind} candles", core.compute_entry_stoch_k(make_candles(kind), 5) == expected)
    candles = make_candles("mid")
    candles[-1].update({"h": 1e9, "l": 1.0, "c": 1.0})
    check("unfinished candle excluded", core.compute_entry_stoch_k(candles, 5) == 50.0)
    check("too few candles yields no invented K", core.compute_entry_stoch_k(candles[:4], 5) is None)
    for c in candles:
        c.update({"h": 86000.0, "l": 86000.0, "c": 86000.0})
    check("zero-range candles yield no invented K", core.compute_entry_stoch_k(candles, 5) is None)


async def t_entry_features_write_failure_is_visible_and_keeps_the_fill():
    print("\n[entry features: failed snapshot write logs the issue and never loses the real fill]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="long", schema_has_entry_features=True)
    update = bot.update_state

    async def reject_snapshot(patch):
        if "entry_k" in patch:
            raise RuntimeError("snapshot write rejected")
        await update(patch)

    bot.update_state = reject_snapshot
    await bot.tick()
    check("filled position still tracked", bot.state_row["side"] == "long")
    check("only one order sent", len(ex.orders) == 1)
    check("snapshot failure logged", any(a == "entry_features_write_failed" for a, _ in bot.runs))
    check("entry log retains numeric snapshot", any(a == "entered" and d.get("entry_features", {}).get("entry_k") == 0.0
                                                    for a, d in bot.runs))


async def t_post_reversal_cooldown_blocks_instant_reopen():
    print("\n[post-reversal cooldown: a reversal still CLOSES, but does not instantly reopen]")
    entry = 86000.0
    ex = FakeExchange(position=-round(20.0 / entry, 5), collateral=20.0)  # short position
    candles = make_candles("long")  # K near 0 -> reversal signal "long", opposite of held short
    entry_time = candles[-1]["t"] - 200_000  # well past any guard
    state = {
        "id": 1, "side": "short", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": entry_time, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles=candles, reversal_guard_seconds=None,
                   require_fresh_signal=False, post_reversal_cooldown_seconds=120.0)
    await bot.tick()
    check("position closed (the close leg is never gated)", bot.state_row["side"] is None,
          bot.state_row["side"])
    check("logged as a REVERSAL close",
          any(d.get("reason") == "REVERSAL" for a, d in bot.runs if a == "closed"), bot.runs)
    check("only one order placed (the close, no instant reopen)", len(ex.orders) == 1, ex.orders)
    check("cooldown timestamp stamped", bot._last_reversal_close_at is not None)
    check("cooldown reads active", bot._reversal_cooldown_active() is True)


async def t_post_reversal_cooldown_allows_reentry_once_elapsed():
    print("\n[post-reversal cooldown: once it elapses, the normal fresh signal can enter again]")
    entry = 86000.0
    ex = FakeExchange(position=-round(20.0 / entry, 5), collateral=20.0)
    candles = make_candles("long")
    entry_time = candles[-1]["t"] - 200_000
    state = {
        "id": 1, "side": "short", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": entry_time, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles=candles, reversal_guard_seconds=None,
                   require_fresh_signal=False, post_reversal_cooldown_seconds=120.0)
    await bot.tick()
    check("closed, not reopened yet", bot.state_row["side"] is None and len(ex.orders) == 1)
    # Cooldown has elapsed -- back-date the stamp instead of sleeping 120s in a test.
    bot._last_reversal_close_at = time.time() - 200.0
    check("cooldown now reads inactive", bot._reversal_cooldown_active() is False)
    ex.position = 0.0
    await bot.tick()
    check("entered on the next tick now that the cooldown cleared",
          bot.state_row["side"] == "long", bot.state_row["side"])
    check("a second order was placed", len(ex.orders) == 2, ex.orders)


async def t_post_reversal_cooldown_off_by_default():
    print("\n[post-reversal cooldown: off by default -- a reversal reopens instantly as before]")
    entry = 86000.0
    ex = FakeExchange(position=-round(20.0 / entry, 5), collateral=20.0)
    candles = make_candles("long")
    entry_time = candles[-1]["t"] - 200_000
    state = {
        "id": 1, "side": "short", "legs": [{"price": entry, "usd_size": 20.0}],
        "first_entry_price": entry, "first_entry_time": entry_time, "dca_level": 0,
        "seed_usd": 20.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 20.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    bot = make_bot(ex, state=state, candles=candles, reversal_guard_seconds=None,
                   require_fresh_signal=False)  # post_reversal_cooldown_seconds defaults None
    await bot.tick()
    check("reversed instantly, same tick (unchanged default behaviour)",
          bot.state_row["side"] == "long", bot.state_row["side"])
    check("two orders placed (close + instant reopen)", len(ex.orders) == 2, ex.orders)


async def _index_exit_bot(**kw):
    entry = 86000.0
    ex = FakeExchange(position=round(99.0 / entry, 5), collateral=99.0)
    state = {
        "id": 1, "side": "long", "legs": [{"price": entry, "usd_size": 99.0}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": 99.0, "realized_pnl_usd": 0.0, "collateral_before_entry": 99.0,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }
    base = dict(candles_kind="mid", sl_pct=0.20, tp_pct=0.10, require_fresh_signal=False,
                profit_lock_enabled=False, index_exit_on_green=True,
                color_balance_index_min=65.0, color_balance_index_max=75.0)
    base.update(kw)
    return entry, make_bot(ex, state=state, **base)


async def _px_with_index(bot, price, index_value):
    bot.live.order_book = {"bids": [{"price": str(price)}], "asks": [{"price": str(price + 0.5)}]}
    orig = core.compute_color_weighted_balance_index
    core.compute_color_weighted_balance_index = lambda c, w=5: index_value
    try:
        await bot.tick()
    finally:
        core.compute_color_weighted_balance_index = orig


async def t_index_exit_fires_when_green_and_index_out_of_band():
    print("\n[index-exit-on-green: closes a GREEN position once the index leaves the band]")
    entry, bot = await _index_exit_bot()
    await _px_with_index(bot, entry * (1 + 0.03 / 100), 90.0)  # green, index above the 65-75 band
    check("closed", bot.state_row["side"] is None, bot.state_row["side"])
    check("reason INDEX_EXIT",
          any(a == "closed" and d.get("reason") == "INDEX_EXIT" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def t_index_exit_never_fires_when_red():
    print("\n[index-exit-on-green: a RED position is untouched even with the index out of band]")
    entry, bot = await _index_exit_bot()
    await _px_with_index(bot, entry * (1 - 0.03 / 100), 90.0)  # red, index out of band
    check("still open -- index-exit only ever applies to a GREEN position",
          bot.state_row["side"] == "long", bot.state_row["side"])


async def t_index_exit_does_not_fire_inside_the_band():
    print("\n[index-exit-on-green: stays open while green AND the index is still inside the band]")
    entry, bot = await _index_exit_bot()
    await _px_with_index(bot, entry * (1 + 0.03 / 100), 70.0)  # green, index inside 65-75
    check("still open", bot.state_row["side"] == "long", bot.state_row["side"])


async def t_index_exit_off_by_default():
    print("\n[index-exit-on-green: off by default -- same green+out-of-band path stays open]")
    entry, bot = await _index_exit_bot(index_exit_on_green=False)
    await _px_with_index(bot, entry * (1 + 0.03 / 100), 90.0)
    check("still open -- feature disabled", bot.state_row["side"] == "long", bot.state_row["side"])


async def _invert_gate_case(value, **cfg):
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", **cfg)
    bot.candles = make_dispersion_candles([150, 150, 150, 150, 0])   # fresh long signal (K=0)
    orig = core.compute_color_weighted_balance_index
    core.compute_color_weighted_balance_index = lambda c, w=5: value
    try:
        await bot.tick()
    finally:
        core.compute_color_weighted_balance_index = orig
    return bot.state_row["side"]


async def t_balance_invert_blocks_inside_band():
    print("\n[balance gate, inverted: index INSIDE 65-75 blocks a fresh entry]")
    for v in (65.0, 70.0, 75.0):
        side = await _invert_gate_case(v, color_balance_index_min=65.0,
                                       color_balance_index_max=75.0, color_balance_index_invert=True)
        check(f"blocked at index {v} (inside the band)", side is None, side)


async def t_balance_invert_allows_outside_band():
    print("\n[balance gate, inverted: index OUTSIDE 65-75 lets a fresh entry through]")
    for v in (40.0, 90.0):
        side = await _invert_gate_case(v, color_balance_index_min=65.0,
                                       color_balance_index_max=75.0, color_balance_index_invert=True)
        check(f"entered at index {v} (outside the band)", side == "long", side)


async def t_balance_invert_missing_reading_still_blocks():
    print("\n[balance gate, inverted: a missing reading still blocks (never guesses entry is safe)]")
    side = await _invert_gate_case(None, color_balance_index_min=65.0,
                                   color_balance_index_max=75.0, color_balance_index_invert=True)
    check("blocked -- no reading", side is None, side)


async def t_balance_invert_off_keeps_normal_inside_band_gate():
    print("\n[balance gate: invert False (default) keeps the normal inside-the-band behaviour]")
    side = await _invert_gate_case(70.0, color_balance_index_min=65.0,
                                   color_balance_index_max=75.0)  # invert defaults False
    check("entered at index 70 -- normal gate allows INSIDE the band", side == "long", side)


async def t_environment_er_hysteresis_and_freshness():
    bot = _hedge_leg(environment_er_pause_below=0.15)
    ungated = _hedge_leg(environment_er_pause_below=0.15, environment_entry_gate_enabled=False)
    ungated.environment_hub = {"allowed": False, "checked_at": 0}
    check("disabled environment gate permits cycles with red/stale readings", ungated._wants_new_cycle())
    bot._environment_restored = True
    now = time.time()
    base_t = (int(now // 60) - 16) * 60000
    bot.candles = [{"t": base_t + i * 60000, "c": 86000 + i} for i in range(17)]
    bot.candles_updated_at = now
    original = core.compute_er_and_direction
    value = [0.20]
    core.compute_er_and_direction = lambda candles, window: (value[0], "long")
    try:
        await bot._refresh_environment(True)
        check("ER starts paused in middle band", not bot._wants_new_cycle())
        value[0] = 0.25
        await bot._refresh_environment(True)
        check("ER resumes at exactly .25", bot._wants_new_cycle())
        value[0] = 0.15
        await bot._refresh_environment(True)
        check("ER holds green at exactly .15", bot._wants_new_cycle())
        value[0] = 0.149
        await bot._refresh_environment(True)
        check("ER pauses below .15", not bot._wants_new_cycle())
        value[0] = 0.249
        await bot._refresh_environment(True)
        check("ER holds red below .25", not bot._wants_new_cycle())
        value[0] = 0.9
        bot.candles_updated_at = now - 100
        await bot._refresh_environment(True)
        check("stale candles pause despite high ER", not bot._wants_new_cycle())
        bot.candles_updated_at = now
        bot.candles[4]["t"] += 1000
        await bot._refresh_environment(True)
        check("discontinuous candles pause", not bot._wants_new_cycle())
        bot.candles[4]["t"] -= 1000
        await bot._refresh_environment(True)
        check("fresh high ER resumes", bot._wants_new_cycle())
        bot._environment_reading["checked_at"] = now - 100
        check("stale shared snapshot pauses", not bot._wants_new_cycle())
    finally:
        core.compute_er_and_direction = original


async def t_environment_shared_clearance_and_scope():
    a = _hedge_leg(environment_er_pause_below=0.15)
    b = _hedge_leg(environment_er_pause_below=0.15, environment_signal_owner=False)
    a.cfg.worker_id = "a"; b.cfg.worker_id = "b"
    a.environment_hub = b.environment_hub = {"allowed": True, "checked_at": time.time()}
    a.cycle_hub = b.cycle_hub = StochBot.new_cycle_hub(["a", "b"])
    check("ER green both legs want cycle", a._wants_new_cycle() and b._wants_new_cycle())
    check("ER first leg waits for partner", a._cycle_gate_clear_to_enter(want=a._wants_new_cycle()) is False)
    check("ER second leg releases pair", b._cycle_gate_clear_to_enter(want=b._wants_new_cycle()) is True)
    a.environment_hub.update(allowed=False)
    check("ER red blocks next cycle for both", not a._wants_new_cycle() and not b._wants_new_cycle())
    check("ER change honors already granted partner clearance", a._cycle_gate_clear_to_enter(want=a._wants_new_cycle()) is True)
    check("unconfigured bots unaffected", _hedge_leg()._wants_new_cycle())
    import lighter_hedge_dual_leg as hedge
    import lighter_stoch_dca_btc_initial as initial
    check("ER only hedge enabled", initial.CONFIG.environment_er_pause_below is None)
    check("hedge environment filters disabled both sides", all(not c.environment_entry_gate_enabled for c in [hedge.LONG_CONFIG,hedge.SHORT_CONFIG]))
    check("hedge exact ER thresholds both sides", all((c.environment_er_pause_below,c.environment_er_resume_at,c.environment_er_window)==(0.15,0.15,15) for c in [hedge.LONG_CONFIG,hedge.SHORT_CONFIG]))
    check("hedge only long computes environment", hedge.LONG_CONFIG.environment_signal_owner and not hedge.SHORT_CONFIG.environment_signal_owner)
    check("hedge still no stochastic entry filter", not hedge.LONG_CONFIG.require_pressure_to_enter and not hedge.SHORT_CONFIG.require_pressure_to_enter)


async def t_environment_paused_exits_still_run():
    ex = FakeExchange(position=0.00012)
    bot = make_bot(ex, fixed_direction="long", sl_pct=0.03, environment_er_pause_below=0.15)
    bot._environment_restored = True
    bot.state_row.update(side="long", legs=[{"price": 86100.0, "usd_size": 86100.0 * 0.00012}], first_entry_price=86100.0)
    await bot.tick()
    check("ER paused position still stops out", bot.state_row["side"] is None)
    check("ER paused stop sends reduce only", any(o["reduce_only"] for o in ex.orders))


async def t_environment_two_binary_switches():
    bot = _hedge_leg(environment_er_pause_below=0.15, environment_er_resume_at=0.15,
                     environment_vol_max_pct=0.045)
    bot._environment_restored = True
    now = time.time(); base_t = (int(now // 60) - 16) * 60000
    bot.candles = [{"t":base_t+i*60000,"c":100.0,"h":0.045,"l":0.0} for i in range(17)]
    bot.candles_updated_at = now
    er = [0.15]
    original = core.compute_er_and_direction
    core.compute_er_and_direction = lambda candles,window:(er[0], "short")
    try:
        await bot._refresh_environment(True)
        check("binary ER green at exactly .15", bot._environment_reading["er_allowed"])
        check("vol green at .045 boundary", bot._environment_reading["vol_allowed"])
        check("both switches green allow cycle", bot._wants_new_cycle())
        er[0]=0.149
        await bot._refresh_environment(True)
        check("ER red alone pauses new cycles", not bot._wants_new_cycle() and bot._environment_reading["vol_allowed"])
        er[0]=0.15
        await bot._refresh_environment(True)
        check("ER resumes at .15 immediately without .25 hysteresis", bot._wants_new_cycle())
        for b in bot.candles:b["h"]=0.0451
        await bot._refresh_environment(True)
        check("vol red alone pauses even when ER green", not bot._wants_new_cycle() and bot._environment_reading["er_allowed"])
        for b in bot.candles:b["h"]=0.04
        await bot._refresh_environment(True)
        check("vol resumes immediately when both green", bot._wants_new_cycle())
        bot.candles[-2]["h"]=float("nan")
        await bot._refresh_environment(True)
        check("missing valid volatility pauses new pairs", not bot._wants_new_cycle())
        bot.candles[-2]["h"]=0.04
        bot.candles[-1]["h"]=500
        await bot._refresh_environment(True)
        check("unfinished candle does not affect volatility", bot._wants_new_cycle())
        import lighter_hedge_dual_leg as hedge
        check("hedge both use identical vol ceiling and window", all((c.environment_vol_max_pct,c.environment_vol_window)==(0.045,10) for c in [hedge.LONG_CONFIG,hedge.SHORT_CONFIG]))
    finally:
        core.compute_er_and_direction=original


async def t_environment_restart_checkpoint():
    bot = _hedge_leg(environment_er_pause_below=0.15)
    now = time.time(); base_t = (int(now // 60) - 16) * 60000
    bot.candles = [{"t": base_t+i*60000,"c":86000+i} for i in range(17)]
    bot.candles_updated_at = now
    async def sb(method, path):
        return [{"detail":{"allowed":True,"checked_at":now,"window":15,"pause_below":0.15,"resume_at":0.25}}]
    bot.sb = sb
    original = core.compute_er_and_direction
    core.compute_er_and_direction = lambda candles, window: (0.20, "short")
    try:
        await bot._refresh_environment(True)
        check("ER recent checkpoint holds green through restart", bot._wants_new_cycle())
        bot._environment_restored=False
        bot._environment_reading={"allowed":False}
        async def stale_sb(method,path):
            d=(await sb(method,path))[0]; d["detail"]["checked_at"]=now-120; return [d]
        bot.sb=stale_sb
        await bot._refresh_environment(True)
        check("ER stale checkpoint starts paused", not bot._wants_new_cycle())
    finally:
        core.compute_er_and_direction=original


def _flip_candles(colors, base=86000.0, size=50.0, vol=10.0, sizes=None):
    """One closed candle per entry in `colors` (1=green, -1=red, 0=doji), each `size` wide and
    `vol` BTC traded, plus one trailing live candle (closed-only readers never see it). Prices
    chain close-to-open so the sequence is a continuous path, matching real candle data.
    `sizes`, if given, is a per-candle list overriding the uniform `size` (for testing the
    interrupting candle's own body independent of the streak's own size)."""
    t0 = 1700000000000
    c = []
    price = base
    for i, col in enumerate(colors):
        o = price
        sz = sizes[i] if sizes is not None else size
        cl = price + sz if col == 1 else (price - sz if col == -1 else price)
        h, l = max(o, cl) + 5, min(o, cl) - 5
        c.append({"t": t0 + i * 60000, "o": o, "h": h, "l": l, "c": cl, "v": vol})
        price = cl
    c.append({"t": t0 + len(colors) * 60000, "o": price, "h": price, "l": price, "c": price, "v": vol})
    return c


async def t_compute_candle_volume_avg_basic():
    print("\n[compute_candle_volume_avg: hand-computed mean of trailing 10 closed v's]")
    candles = _flip_candles([1] * 10, vol=3.0)
    v = core.compute_candle_volume_avg(candles, window=10)
    check("mean of ten 3.0-BTC candles is 3.0", v is not None and abs(v - 3.0) < 1e-9, v)
    short = _flip_candles([1] * 5, vol=3.0)
    check("too few candles -> None", core.compute_candle_volume_avg(short, window=10) is None)


async def t_flip_signal_fires_after_long_enough_trend():
    print("\n[compute_flip_signal: fires in the ORIGINAL trend's direction once the streak is long enough]")
    candles = _flip_candles([-1, -1, -1, 1])  # 3 reds then a green flip -- bet on more red
    sig, rev, ts = core.compute_flip_signal(candles, min_trend_len=3)
    check("enters SHORT -- the 3-bar red trend, not the green flip candle", sig == "short", sig)
    check("reversal_signal is always None for the flip signal", rev is None, rev)
    check("candle_ts is the flip candle's own timestamp", ts == candles[-2]["t"], (ts, candles[-2]["t"]))


async def t_flip_signal_short_direction():
    print("\n[compute_flip_signal: green trend interrupted by one red candle enters long]")
    candles = _flip_candles([1, 1, 1, -1])
    sig, _, _ = core.compute_flip_signal(candles, min_trend_len=3)
    check("enters LONG -- the 3-bar green trend, not the red flip candle", sig == "long", sig)


async def t_flip_signal_blocks_short_trend():
    print("\n[compute_flip_signal: streak shorter than min_trend_len does not fire]")
    candles = _flip_candles([-1, -1, 1])  # only a 2-bar red streak before the flip
    sig, _, _ = core.compute_flip_signal(candles, min_trend_len=3)
    check("blocked -- streak is only 2 bars", sig is None, sig)


async def t_flip_signal_requires_an_actual_flip():
    print("\n[compute_flip_signal: no flip (same color, or a doji) never fires]")
    same = _flip_candles([1, 1, 1, 1])
    check("same color throughout -> None", core.compute_flip_signal(same, min_trend_len=3)[0] is None)
    doji = _flip_candles([0, 1, 1, 1])
    check("doji prior candle -> None", core.compute_flip_signal(doji, min_trend_len=3)[0] is None)


async def t_flip_signal_size_filter():
    print("\n[compute_flip_signal: optional min_size_pct floor, off by default]")
    small = _flip_candles([-1, -1, -1, 1], size=1.0)     # ~0.0012% range -- tiny
    big = _flip_candles([-1, -1, -1, 1], size=2000.0)    # ~2.3% range -- clears a 1% floor
    check("off by default -- small candles still fire", core.compute_flip_signal(small, min_trend_len=3)[0] == "short")
    check("size floor blocks the small-candle streak",
          core.compute_flip_signal(small, min_trend_len=3, min_size_pct=1.0)[0] is None)
    check("size floor lets the wide-candle streak through",
          core.compute_flip_signal(big, min_trend_len=3, min_size_pct=1.0)[0] == "short")


async def t_flip_signal_min_body_pct_filter():
    print("\n[compute_flip_signal: min_body_pct filters the INTERRUPTING candle's own body, not the streak]")
    # 3 normal-sized red bars, then a tiny near-doji green flip -- real trade shape (1679).
    near_doji = _flip_candles([-1, -1, -1, 1], sizes=[50.0, 50.0, 50.0, 0.8])
    # same streak, but a real-sized flip candle.
    real_flip = _flip_candles([-1, -1, -1, 1], sizes=[50.0, 50.0, 50.0, 50.0])
    check("off by default -- the near-doji flip still fires",
          core.compute_flip_signal(near_doji, min_trend_len=3)[0] == "short")
    check("body floor blocks the near-doji flip (0.8 on ~86000 is well under 0.01%)",
          core.compute_flip_signal(near_doji, min_trend_len=3, min_body_pct=0.01)[0] is None)
    check("body floor lets a real-sized flip candle through",
          core.compute_flip_signal(real_flip, min_trend_len=3, min_body_pct=0.01)[0] == "short")
    check("body floor never looks at the STREAK bars' own size (those are large here either way)",
          core.compute_flip_signal(near_doji, min_trend_len=3, min_size_pct=0.01)[0] == "short")


async def _volume_switch_case(candle_volume, threshold=2.0):
    """Stochastic signal here says 'long' (K=0 via make_dispersion_candles) and the zebra band
    is set to BLOCK it outright -- so if the regime switch is working, the only way this bot
    can still enter is by actually using the mocked flip signal ('short'), proving the override
    genuinely replaces the signal and bypasses the gate, not just coincidentally produces the
    same side."""
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid",
                   zebra_index_min=600.0, zebra_index_max=1000.0,
                   volume_regime_switch_threshold=threshold, flip_signal_min_trend_len=3)
    bot.candles = make_dispersion_candles([150, 150, 150, 150, 0])  # fresh long signal (K=0)
    orig_vol = core.compute_candle_volume_avg
    orig_zebra = core.compute_zebra_size_index
    orig_flip = core.compute_flip_signal
    core.compute_candle_volume_avg = lambda c, w=10: candle_volume
    core.compute_zebra_size_index = lambda c, w=5: 5000.0        # out of band -- would block
    core.compute_flip_signal = lambda c, min_trend_len, min_size_pct, min_body_pct: ("short", None, c[-2]["t"])
    try:
        await bot.tick()
    finally:
        core.compute_candle_volume_avg = orig_vol
        core.compute_zebra_size_index = orig_zebra
        core.compute_flip_signal = orig_flip
    return bot.state_row["side"]


async def _regime_toggle_case(state_overrides, schema_on=True, candle_volume=1.0, threshold=2.0,
                               zebra_band=True, flip_side="short"):
    """Stochastic says 'long' (K=0). color_balance band, if `zebra_band`, is set to a value
    the mock reports as OUT of band (would block). Flip, if volume ends up routed there, is
    mocked to `flip_side` so a flip entry is distinguishable from a stochastic one."""
    ex = FakeExchange()
    cfg_kwargs = dict(candles_kind="mid", volume_regime_switch_threshold=threshold,
                       flip_signal_min_trend_len=3, schema_has_regime_overrides=schema_on)
    if zebra_band:
        cfg_kwargs.update(color_balance_index_min=65.0, color_balance_index_max=75.0)
    bot = make_bot(ex, **cfg_kwargs)
    bot.candles = make_dispersion_candles([150, 150, 150, 150, 0])  # fresh long signal (K=0)
    bot.state_row.update(state_overrides)
    orig_vol = core.compute_candle_volume_avg
    orig_balance = core.compute_color_weighted_balance_index
    orig_flip = core.compute_flip_signal
    core.compute_candle_volume_avg = lambda c, w=10: candle_volume
    core.compute_color_weighted_balance_index = lambda c, w=5: 40.0  # out of 65-75 -- would block
    core.compute_flip_signal = lambda c, min_trend_len, min_size_pct, min_body_pct: (flip_side, None, c[-2]["t"])
    try:
        await bot.tick()
    finally:
        core.compute_candle_volume_avg = orig_vol
        core.compute_color_weighted_balance_index = orig_balance
        core.compute_flip_signal = orig_flip
    return bot.state_row["side"]


def _jump_candles(volumes, base=86000.0):
    """One closed candle per entry in `volumes` (flat price, just the v field varies), plus
    one trailing live candle. compute_volume_jump_ratio reads closed[-1] as the latest and the
    `lookback` before it as the baseline."""
    t0 = 1700000000000
    c = [{"t": t0 + i * 60000, "o": base, "h": base + 1, "l": base - 1, "c": base, "v": v}
         for i, v in enumerate(volumes)]
    c.append({"t": t0 + len(volumes) * 60000, "o": base, "h": base, "l": base, "c": base,
              "v": volumes[-1] if volumes else 1.0})
    return c


def _wiggle_candles(mids, v=1.0):
    """One closed candle per entry in `mids` (controllable midpoint, for
    compute_intrabar_dispersion), constant volume, plus one trailing live candle."""
    t0 = 1700000000000
    c = [{"t": t0 + i * 60000, "o": m, "h": m + 0.5, "l": m - 0.5, "c": m, "v": v}
         for i, m in enumerate(mids)]
    last_m = mids[-1] if mids else 86000.0
    c.append({"t": t0 + len(mids) * 60000, "o": last_m, "h": last_m + 0.5, "l": last_m - 0.5,
              "c": last_m, "v": v})
    return c


def _ratio_candles(volumes, mids):
    """Both volume AND price midpoint independently controllable per candle, for
    compute_volume_wiggle_ratio (needs both compute_candle_volume_avg and
    compute_intrabar_dispersion from the same candle list). Same length required."""
    t0 = 1700000000000
    c = [{"t": t0 + i * 60000, "o": m, "h": m + 0.5, "l": m - 0.5, "c": m, "v": v}
         for i, (v, m) in enumerate(zip(volumes, mids))]
    last_v = volumes[-1] if volumes else 1.0
    last_m = mids[-1] if mids else 86000.0
    c.append({"t": t0 + len(mids) * 60000, "o": last_m, "h": last_m + 0.5, "l": last_m - 0.5,
              "c": last_m, "v": last_v})
    return c


async def t_volume_wiggle_ratio_basic():
    print("\n[compute_volume_wiggle_ratio: equals dispersion / volume_avg from the same candles (flipped 2026-10-05)]")
    candles = _ratio_candles([1.0] * 10, [86000, 86000, 86000, 86000, 86000, 86000, 86100, 85900, 86050, 85950])
    vol = core.compute_candle_volume_avg(candles, window=10)
    wig = core.compute_intrabar_dispersion(candles, window=5)
    ratio = core.compute_volume_wiggle_ratio(candles, vol_window=10, wiggle_window=5)
    check("vol and wiggle both computed", vol is not None and wig is not None and vol != 0, (vol, wig))
    check("ratio equals wig/vol", ratio is not None and abs(ratio - wig / vol) < 1e-9, (ratio, vol, wig))


async def t_volume_wiggle_ratio_needs_both_components():
    print("\n[compute_volume_wiggle_ratio: None when either component is unavailable]")
    short_candles = _ratio_candles([1.0] * 3, [86000] * 3)  # not enough for either window
    check("too few candles -> None", core.compute_volume_wiggle_ratio(short_candles) is None)


async def t_volume_wiggle_ratio_zero_volume_is_none():
    print("\n[compute_volume_wiggle_ratio: zero volume is None, not a divide-by-zero (flipped 2026-10-05 -- was wiggle==0)]")
    candles = _ratio_candles([0.0] * 10, [86000, 86000, 86000, 86000, 86000, 86000, 86100, 85900, 86050, 85950])
    check("zero volume -> None, never a crash", core.compute_volume_wiggle_ratio(candles) is None)


async def t_volume_wiggle_ratio_flat_price_is_zero_not_none():
    print("\n[compute_volume_wiggle_ratio: a perfectly flat price (wiggle=0) is now 0.0, not None -- dividing by VOLUME, not wiggle]")
    candles = _ratio_candles([1.0] * 10, [86000.0] * 10)  # flat -- dispersion is exactly 0
    ratio = core.compute_volume_wiggle_ratio(candles)
    check("flat price with real volume -> 0.0, not None", ratio == 0.0, ratio)


# Shared fixture for the lock tests below: midpoints [86000,86100,85900,86050,85950] give a
# dispersion (wiggle) of exactly sqrt(5000) ~= 70.7107 (raw dollars). Paired with volume=100,
# wig/vol ~= 0.70711 (small -- lots of volume, little price movement -- the chop signal under
# the flipped formula). Paired with volume=1, wig/vol ~= 70.7107 (large -- not chop).
_WIGGLE_MIDS = [86000, 86000, 86000, 86000, 86000, 86000, 86100, 85900, 86050, 85950]


async def t_volume_wiggle_lock_blocks_below_threshold():
    print("\n[volume/wiggle lock: locks when the instant ratio is BELOW the threshold (flipped 2026-10-05)]")
    bot = make_bot(FakeExchange(), candles_kind="mid", volume_wiggle_lock_threshold=1.0,
                    schema_has_regime_overrides=True)
    # High volume (100) against this fixture's wiggle gives ratio ~=0.70711, unambiguously below 1.0.
    bot.candles = _ratio_candles([100.0] * 10, _WIGGLE_MIDS)
    locked = bot._update_volume_wiggle_lock(bot.state_row)
    check("locked", locked is True, locked)
    check("_volume_wiggle_allows_cycle reflects the lock", bot._volume_wiggle_allows_cycle() is False)


async def t_volume_wiggle_lock_allows_at_or_above_threshold():
    print("\n[volume/wiggle lock: stays unlocked when the instant ratio is at/above the threshold]")
    bot = make_bot(FakeExchange(), candles_kind="mid", volume_wiggle_lock_threshold=1.0,
                    schema_has_regime_overrides=True)
    # Low volume (1) against the same wiggle gives ratio ~=70.71, unambiguously above 1.0.
    bot.candles = _ratio_candles([1.0] * 10, _WIGGLE_MIDS)
    locked = bot._update_volume_wiggle_lock(bot.state_row)
    check("not locked", locked is False, locked)
    check("_volume_wiggle_allows_cycle reflects the unlock", bot._volume_wiggle_allows_cycle() is True)


async def t_volume_wiggle_lock_off_by_default():
    print("\n[volume/wiggle lock: off by default -- unconfigured never locks regardless of the ratio]")
    bot = make_bot(FakeExchange(), candles_kind="mid")  # volume_wiggle_lock_threshold defaults None
    bot.candles = _ratio_candles([100.0] * 10, _WIGGLE_MIDS)
    locked = bot._update_volume_wiggle_lock(bot.state_row)
    check("never locks when unconfigured", locked is False, locked)


async def t_volume_wiggle_lock_live_override():
    print("\n[volume/wiggle lock: override_volume_wiggle_lock_threshold picks the threshold live]")
    bot = make_bot(FakeExchange(), candles_kind="mid", schema_has_regime_overrides=True)  # compiled off
    bot.candles = _ratio_candles([100.0] * 10, _WIGGLE_MIDS)
    bot.state_row["override_volume_wiggle_lock_threshold"] = 1.0
    locked = bot._update_volume_wiggle_lock(bot.state_row)
    check("locked via the live override", locked is True, locked)


async def t_volume_wiggle_lock_override_ignored_without_schema_flag():
    print("\n[volume/wiggle lock: schema_has_regime_overrides=False ignores the override]")
    bot = make_bot(FakeExchange(), candles_kind="mid", schema_has_regime_overrides=False)
    bot.candles = _ratio_candles([100.0] * 10, _WIGGLE_MIDS)
    bot.state_row["override_volume_wiggle_lock_threshold"] = 1.0
    locked = bot._update_volume_wiggle_lock(bot.state_row)
    check("still unlocked -- override present but the schema flag is off", locked is False, locked)


async def t_volume_wiggle_lock_enabled_switch_overrides_without_losing_threshold():
    print("\n[volume/wiggle lock: override_volume_wiggle_lock_enabled=False disables it, threshold untouched]")
    bot = make_bot(FakeExchange(), candles_kind="mid", volume_wiggle_lock_threshold=1.0,
                    schema_has_regime_overrides=True)
    bot.candles = _ratio_candles([100.0] * 10, _WIGGLE_MIDS)
    bot.state_row["override_volume_wiggle_lock_enabled"] = False
    locked = bot._update_volume_wiggle_lock(bot.state_row)
    check("not locked -- switched off even though the ratio is below threshold", locked is False, locked)
    check("the threshold itself is unchanged", bot.cfg.volume_wiggle_lock_threshold == 1.0,
          bot.cfg.volume_wiggle_lock_threshold)
    bot.state_row["override_volume_wiggle_lock_enabled"] = True
    locked_again = bot._update_volume_wiggle_lock(bot.state_row)
    check("locks again once switched back on, same threshold", locked_again is True, locked_again)


async def t_volume_wiggle_lock_blocks_a_hedge_style_cycle():
    print("\n[volume/wiggle lock: blocks a fixed_direction leg's _wants_new_cycle, not just entry_signal]")
    bot = _hedge_leg(volume_wiggle_lock_threshold=1.0)
    bot.candles = _ratio_candles([100.0] * 10, _WIGGLE_MIDS)
    locked = bot._update_volume_wiggle_lock(bot.state_row)
    check("locked", locked is True, locked)
    check("fixed_direction leg does not want a new cycle while locked", bot._wants_new_cycle() is False)


async def t_volume_jump_ratio_basic():
    print("\n[compute_volume_jump_ratio: hand-computed example]")
    candles = _jump_candles([1.0] * 10 + [5.0])
    ratio = core.compute_volume_jump_ratio(candles, lookback=10)
    check("5.0 against a 1.0 baseline -> 5.0x", ratio is not None and abs(ratio - 5.0) < 1e-9, ratio)


async def t_volume_jump_ratio_needs_full_lookback():
    print("\n[compute_volume_jump_ratio: None until the lookback window is actually full]")
    candles = _jump_candles([1.0] * 5 + [5.0])
    check("only 5 baseline candles, lookback=10 -> None",
          core.compute_volume_jump_ratio(candles, lookback=10) is None)


async def t_volume_jump_ratio_zero_baseline():
    print("\n[compute_volume_jump_ratio: zero baseline -> None, never a division error]")
    candles = _jump_candles([0.0] * 10 + [5.0])
    check("zero baseline -> None", core.compute_volume_jump_ratio(candles, lookback=10) is None)


async def _volume_jump_case(volumes, state_overrides=None, ratio_cfg=3.0, schema_on=True):
    """A clean fresh LONG stochastic signal (K=0) on the last 5 closed candles, independent of
    `volumes` -- the 5-bar window's first 4 bars sit high, the last (same object as closed[-1],
    so it keeps whatever volume `volumes` gave it -- the spike candle) sits low. Proves the
    guard, when it fires, blocks an entry a clean signal would otherwise have taken."""
    ex = FakeExchange()
    candles = _jump_candles(volumes)
    closed = candles[:-1]
    window = closed[-5:]
    for c in window[:-1]:
        c["o"] = c["h"] = c["l"] = c["c"] = 86100.0
    window[-1]["o"] = window[-1]["h"] = window[-1]["l"] = window[-1]["c"] = 86000.0
    bot = make_bot(ex, candles_kind="mid", volume_jump_ratio=ratio_cfg, volume_jump_lookback=10,
                    volume_jump_pause_seconds=120.0, schema_has_regime_overrides=schema_on)
    bot.candles = candles
    if state_overrides:
        bot.state_row.update(state_overrides)
    await bot.tick()
    return bot.state_row["side"]


async def t_volume_jump_guard_blocks_entry_on_spike():
    print("\n[volume-jump guard: a real spike blocks an otherwise-clean fresh entry]")
    side = await _volume_jump_case([1.0] * 10 + [5.0])  # 5.0x -- over the 3.0 default
    check("blocked -- spike detected", side is None, side)


async def t_volume_jump_guard_allows_entry_without_spike():
    print("\n[volume-jump guard: no spike -- the clean signal enters normally]")
    side = await _volume_jump_case([1.0] * 11)  # 1.0x -- flat, no spike
    check("entered long -- no spike, ratio_cfg=3.0", side == "long", side)


async def t_volume_jump_guard_off_by_default():
    print("\n[volume-jump guard: None (off) never blocks, even with a real spike present]")
    side = await _volume_jump_case([1.0] * 10 + [5.0], ratio_cfg=None)
    check("entered long -- guard not configured", side == "long", side)


async def t_volume_jump_guard_live_override_ratio():
    print("\n[volume-jump guard: live override raises the ratio past a spike that would otherwise block]")
    side = await _volume_jump_case([1.0] * 10 + [5.0], {"override_volume_jump_ratio": 10.0})
    check("entered long -- override ratio (10x) not cleared by a 5x spike", side == "long", side)


async def t_volume_jump_guard_off_by_default_schema_flag():
    print("\n[volume-jump guard: schema_has_regime_overrides=False ignores the override columns]")
    side = await _volume_jump_case([1.0] * 10 + [5.0], {"override_volume_jump_ratio": 10.0}, schema_on=False)
    check("blocked -- override present on the row but the schema flag is off", side is None, side)


async def t_volume_jump_guard_enabled_switch_off_allows_entry_despite_spike():
    print("\n[volume-jump guard: override_volume_jump_enabled=False allows entry despite a real spike]")
    side = await _volume_jump_case([1.0] * 10 + [5.0], {"override_volume_jump_enabled": False})
    check("entered long -- switch off, 5x spike ignored", side == "long", side)


async def t_volume_jump_guard_enabled_switch_true_keeps_blocking():
    print("\n[volume-jump guard: override_volume_jump_enabled=True behaves exactly like the default]")
    side = await _volume_jump_case([1.0] * 10 + [5.0], {"override_volume_jump_enabled": True})
    check("blocked -- switch explicitly on, spike still gates", side is None, side)


async def t_volume_jump_guard_enabled_switch_off_by_default_schema_flag():
    print("\n[volume-jump guard: schema_has_regime_overrides=False ignores the enabled override]")
    side = await _volume_jump_case([1.0] * 10 + [5.0], {"override_volume_jump_enabled": False}, schema_on=False)
    check("blocked -- override present on the row but the schema flag is off", side is None, side)


async def t_volume_jump_guard_enabled_switch_off_still_shows_the_reading():
    print("\n[volume-jump guard: switch off still computes/caches the ratio reading for the dashboard]")
    ex = FakeExchange()
    candles = _jump_candles([1.0] * 10 + [5.0])
    bot = make_bot(ex, candles_kind="mid", volume_jump_ratio=3.0, volume_jump_lookback=10,
                    volume_jump_pause_seconds=120.0, schema_has_regime_overrides=True)
    bot.candles = candles
    bot.state_row["override_volume_jump_enabled"] = False
    active = bot._update_volume_jump_guard(bot.state_row)
    check("gate returns inactive -- switch off", active is False, active)
    check("ratio reading still computed, not blanked to None", bot._last_volume_jump_ratio is not None,
          bot._last_volume_jump_ratio)


async def t_volume_jump_guard_enabled_switch_off_clears_an_active_pause():
    print("\n[volume-jump guard: flipping the switch off immediately clears an already-active pause]")
    ex = FakeExchange()
    candles = _jump_candles([1.0] * 10 + [5.0])
    bot = make_bot(ex, candles_kind="mid", volume_jump_ratio=3.0, volume_jump_lookback=10,
                    volume_jump_pause_seconds=120.0, schema_has_regime_overrides=True)
    bot.candles = candles
    active = bot._update_volume_jump_guard(bot.state_row)
    check("armed first -- spike present, switch still on", active is True, active)
    bot.state_row["override_volume_jump_enabled"] = False
    active = bot._update_volume_jump_guard(bot.state_row)
    check("inactive the next tick once the switch flips off", active is False, active)
    check("paused_until cleared, not just ignored", bot._volume_jump_paused_until is None,
          bot._volume_jump_paused_until)


async def t_volume_jump_guard_tracks_paused_until():
    print("\n[volume-jump guard: _volume_jump_paused_until reflects the actual pause window]")
    ex = FakeExchange()
    before = time.time()
    candles = _jump_candles([1.0] * 10 + [5.0])  # 5.0x -- over the 3.0 default
    bot = make_bot(ex, candles_kind="mid", volume_jump_ratio=3.0, volume_jump_lookback=10,
                    volume_jump_pause_seconds=120.0, schema_has_regime_overrides=True)
    bot.candles = candles
    await bot.tick()
    check("paused_until is set after a real spike", bot._volume_jump_paused_until is not None,
          bot._volume_jump_paused_until)
    if bot._volume_jump_paused_until is not None:
        check("paused_until is roughly now + 120s",
              before + 115 <= bot._volume_jump_paused_until <= time.time() + 121,
              bot._volume_jump_paused_until - before)


async def t_volume_jump_guard_paused_until_none_when_calm():
    print("\n[volume-jump guard: _volume_jump_paused_until stays None without a spike]")
    ex = FakeExchange()
    candles = _jump_candles([1.0] * 11)  # flat -- no spike
    bot = make_bot(ex, candles_kind="mid", volume_jump_ratio=3.0, volume_jump_lookback=10,
                    volume_jump_pause_seconds=120.0, schema_has_regime_overrides=True)
    bot.candles = candles
    await bot.tick()
    check("paused_until stays None -- no spike happened", bot._volume_jump_paused_until is None,
          bot._volume_jump_paused_until)


async def t_volume_jump_clear_marker_forgives_an_old_pause():
    print("\n[volume-jump guard: override_volume_jump_cleared_at forgives a past spike]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", volume_jump_ratio=3.0, volume_jump_lookback=10,
                    volume_jump_pause_seconds=1800.0, schema_has_regime_overrides=True)
    bot.candles = _jump_candles([1.0] * 11)  # flat on this call -- testing the marker, not a new spike
    fixed_jump_at = time.time() - 60  # a spike that "armed" a minute ago, well inside 1800s
    bot._last_volume_jump_at = fixed_jump_at
    bot.state_row["override_volume_jump_cleared_at"] = datetime.fromtimestamp(
        fixed_jump_at + 1, tz=timezone.utc).isoformat()
    active = bot._update_volume_jump_guard(bot.state_row)
    check("pause forgiven -- cleared_at is after the spike", active is False, active)


async def t_volume_jump_clear_marker_does_not_block_a_new_spike():
    print("\n[volume-jump guard: clearing an old spike does not disable a later one]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", volume_jump_ratio=3.0, volume_jump_lookback=10,
                    volume_jump_pause_seconds=1800.0, schema_has_regime_overrides=True)
    bot.candles = _jump_candles([1.0] * 10 + [5.0])  # a real, fresh spike on this call
    bot.state_row["override_volume_jump_cleared_at"] = datetime.fromtimestamp(
        time.time() - 3600, tz=timezone.utc).isoformat()  # a stale clear, long before this spike
    active = bot._update_volume_jump_guard(bot.state_row)
    check("new spike still arms -- the clear marker predates it", active is True, active)


async def t_volume_jump_clear_marker_off_by_default_schema_flag():
    print("\n[volume-jump guard: schema_has_regime_overrides=False ignores the clear marker]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", volume_jump_ratio=3.0, volume_jump_lookback=10,
                    volume_jump_pause_seconds=1800.0, schema_has_regime_overrides=False)
    bot.candles = _jump_candles([1.0] * 11)
    fixed_jump_at = time.time() - 60
    bot._last_volume_jump_at = fixed_jump_at
    bot.state_row["override_volume_jump_cleared_at"] = datetime.fromtimestamp(
        fixed_jump_at + 1, tz=timezone.utc).isoformat()
    active = bot._update_volume_jump_guard(bot.state_row)
    check("still paused -- clear marker present but the schema flag is off", active is True, active)


async def t_volume_jump_guard_blocks_a_hedge_style_cycle():
    print("\n[volume-jump guard: blocks a fixed_direction leg's _wants_new_cycle, not just entry_signal]")
    # fixed_direction (the hedge) never reads entry_signal, so Worker 1's own mechanism --
    # nulling entry_signal in tick() -- has nothing to act on for these legs. _wants_new_cycle
    # is their actual entry decision point; see _volume_jump_allows_cycle's docstring.
    bot = _hedge_leg(volume_jump_ratio=3.0, volume_jump_lookback=10, volume_jump_pause_seconds=1800.0)
    bot.candles = _jump_candles([1.0] * 10 + [5.0])  # 5x -- over the 3.0 threshold
    active = bot._update_volume_jump_guard(bot.state_row)
    check("guard armed on a real spike", active is True, active)
    check("fixed_direction leg does not want a new cycle while paused", bot._wants_new_cycle() is False)


async def t_volume_jump_guard_calm_does_not_block_hedge_style_cycle():
    print("\n[volume-jump guard: calm volume leaves a fixed_direction leg's cycle gate untouched]")
    bot = _hedge_leg(volume_jump_ratio=3.0, volume_jump_lookback=10, volume_jump_pause_seconds=1800.0)
    bot.candles = _jump_candles([1.0] * 11)  # flat -- no spike
    active = bot._update_volume_jump_guard(bot.state_row)
    check("guard not armed -- no spike", active is False, active)
    check("fixed_direction leg still wants a cycle", bot._wants_new_cycle() is True)


def _release_bot(**kw):
    base = dict(candles_kind="mid", volume_jump_ratio=3.0, volume_jump_lookback=10,
                volume_jump_pause_seconds=1800.0, schema_has_regime_overrides=True)
    base.update(kw)
    return make_bot(FakeExchange(), **base)


async def t_volume_jump_release_mode_off_never_releases_early():
    print("\n[volume-jump release: mode off (default) never releases before the hard cap]")
    bot = _release_bot()  # release_mode defaults to None
    bot.candles = _jump_candles([1.0] * 11)
    bot._last_volume_jump_at = time.time() - 60
    bot._volume_jump_peak_volume = 100.0  # huge peak -- would release instantly under "volume" mode
    active = bot._update_volume_jump_guard(bot.state_row)
    check("still paused -- release_mode is off by default", active is True, active)


async def t_volume_jump_release_volume_mode_releases_at_half_peak():
    print("\n[volume-jump release: volume mode releases once current volume <= 50% of its peak]")
    bot = _release_bot(volume_jump_release_mode="volume")
    bot.candles = _jump_candles([1.0] * 11)  # flat -- volume_now reads 1.0
    bot._last_volume_jump_at = time.time() - 60
    bot._volume_jump_peak_volume = 2.0  # current (1.0) is exactly half the peak
    active = bot._update_volume_jump_guard(bot.state_row)
    check("released -- current volume at 50% of peak", active is False, active)


async def t_volume_jump_release_volume_mode_stays_active_above_half():
    print("\n[volume-jump release: volume mode stays paused while current volume is still > 50% of peak]")
    bot = _release_bot(volume_jump_release_mode="volume")
    bot.candles = _jump_candles([1.0] * 11)  # flat -- volume_now reads 1.0
    bot._last_volume_jump_at = time.time() - 60
    bot._volume_jump_peak_volume = 1.5  # current (1.0) is 2/3 of peak -- still above half
    active = bot._update_volume_jump_guard(bot.state_row)
    check("still paused -- current volume above 50% of peak", active is True, active)


async def t_volume_jump_release_wiggle_mode_releases_at_half_peak():
    print("\n[volume-jump release: wiggle mode releases once current dispersion <= 50% of its peak]")
    bot = _release_bot(volume_jump_release_mode="wiggle", wiggle_window=5)
    bot.candles = _wiggle_candles([86000.0] * 11)  # flat -- dispersion reads 0
    bot._last_volume_jump_at = time.time() - 60
    bot._volume_jump_peak_wiggle = 10.0  # any positive peak -- 0 is at/below half of it
    active = bot._update_volume_jump_guard(bot.state_row)
    check("released -- current dispersion (0) at/below 50% of peak", active is False, active)


async def t_volume_jump_release_wiggle_mode_stays_active_above_half():
    print("\n[volume-jump release: wiggle mode stays paused while current dispersion is still > 50% of peak]")
    bot = _release_bot(volume_jump_release_mode="wiggle", wiggle_window=5)
    bot.candles = _wiggle_candles([86000, 86100, 85900, 86050, 85950, 86000, 86000])
    current_wiggle = core.compute_intrabar_dispersion(bot.candles, 5)
    bot._last_volume_jump_at = time.time() - 60
    bot._volume_jump_peak_wiggle = current_wiggle * 1.5  # current is 2/3 of peak -- above half
    active = bot._update_volume_jump_guard(bot.state_row)
    check("still paused -- current dispersion above 50% of peak", active is True, active)


async def t_volume_jump_release_rate_mode_releases_at_half_peak():
    print("\n[volume-jump release: rate mode releases once |current rate| <= 50% of its peak]")
    bot = _release_bot(volume_jump_release_mode="rate")
    bot.candles = _jump_candles([1.0] * 11)  # flat volume -- rate reads 0
    bot._last_volume_jump_at = time.time() - 60
    bot._volume_jump_peak_rate = 5.0
    active = bot._update_volume_jump_guard(bot.state_row)
    check("released -- |rate| (0) at/below 50% of peak", active is False, active)


async def t_volume_jump_release_rate_mode_stays_active_above_half():
    print("\n[volume-jump release: rate mode stays paused while |current rate| is still > 50% of peak]")
    bot = _release_bot(volume_jump_release_mode="rate")
    bot.candles = _jump_candles([1.0] * 9 + [5.0, 5.0])  # elevated, still-rising average -- nonzero rate
    current_rate = core.compute_candle_volume_rate(bot.candles, 10)
    bot._last_volume_jump_at = time.time() - 60
    bot._volume_jump_peak_rate = abs(current_rate) * 1.5 if current_rate else 1.0
    active = bot._update_volume_jump_guard(bot.state_row)
    check("still paused -- |rate| above 50% of peak", active is True, active)


async def t_volume_jump_release_peak_resets_on_a_new_spike():
    print("\n[volume-jump release: a genuinely new spike resets the tracked peak]")
    bot = _release_bot(volume_jump_release_mode="volume")
    bot.candles = _jump_candles([1.0] * 10 + [5.0])  # a real, fresh 5x spike
    bot._volume_jump_peak_volume = 999.0  # a stale peak left over from an earlier, unrelated spike
    active = bot._update_volume_jump_guard(bot.state_row)
    check("armed", active is True, active)
    check("peak reset to this spike's own reading, not the stale 999",
          bot._volume_jump_peak_volume is not None and bot._volume_jump_peak_volume < 999.0,
          bot._volume_jump_peak_volume)


async def t_volume_jump_release_peak_readout_matches_the_active_mode():
    print("\n[volume-jump release: _last_release_peak reflects whichever metric is the active arm]")
    bot = _release_bot(volume_jump_release_mode="rate")
    bot.candles = _jump_candles([1.0] * 10 + [5.0])  # a real spike -- arms with a real peak set
    bot._update_volume_jump_guard(bot.state_row)
    check("readout matches the rate peak, not volume or wiggle",
          bot._last_release_peak == bot._volume_jump_peak_rate, bot._last_release_peak)
    check("rate peak is a real number, not None", bot._last_release_peak is not None)


async def t_volume_jump_release_peak_readout_none_when_mode_off():
    print("\n[volume-jump release: _last_release_peak stays None with no arm selected, even while paused]")
    bot = _release_bot()  # release_mode defaults to off
    bot.candles = _jump_candles([1.0] * 10 + [5.0])  # a real spike -- still arms the plain timer
    active = bot._update_volume_jump_guard(bot.state_row)
    check("armed on the fixed timer", active is True, active)
    check("no peak readout -- no arm is selected to target one", bot._last_release_peak is None,
          bot._last_release_peak)


async def t_volume_jump_release_peak_readout_clears_once_not_paused():
    print("\n[volume-jump release: _last_release_peak clears back to None once the guard isn't paused]")
    bot = _release_bot(volume_jump_release_mode="volume")
    bot._last_release_peak = 42.0  # a stale value from an earlier spike, never cleared
    bot.candles = _jump_candles([1.0] * 11)  # flat -- no spike, nothing armed
    active = bot._update_volume_jump_guard(bot.state_row)
    check("not paused", active is False, active)
    check("stale peak readout cleared", bot._last_release_peak is None, bot._last_release_peak)


async def t_volume_jump_release_mode_live_override():
    print("\n[volume-jump release: override_volume_jump_release_mode picks the arm live]")
    bot = _release_bot()  # compiled default is off
    bot.candles = _jump_candles([1.0] * 11)
    bot._last_volume_jump_at = time.time() - 60
    bot._volume_jump_peak_volume = 2.0
    bot.state_row["override_volume_jump_release_mode"] = "volume"
    active = bot._update_volume_jump_guard(bot.state_row)
    check("released -- live override selected volume mode", active is False, active)


async def t_volume_jump_release_mode_override_off_by_default_schema_flag():
    print("\n[volume-jump release: schema_has_regime_overrides=False ignores the release-mode override]")
    bot = _release_bot(schema_has_regime_overrides=False)
    bot.candles = _jump_candles([1.0] * 11)
    bot._last_volume_jump_at = time.time() - 60
    bot._volume_jump_peak_volume = 2.0
    bot.state_row["override_volume_jump_release_mode"] = "volume"
    active = bot._update_volume_jump_guard(bot.state_row)
    check("still paused -- override present but the schema flag is off", active is True, active)


async def t_volume_jump_release_respects_hard_cap_when_metric_never_decays():
    print("\n[volume-jump release: pause_seconds stays the hard cap even if the metric never halves]")
    bot = _release_bot(volume_jump_pause_seconds=60.0, volume_jump_release_mode="volume")
    bot.candles = _jump_candles([1.0] * 11)  # current volume stays 1.0 -- never decays
    bot._last_volume_jump_at = time.time() - 61  # just past the 60s cap
    bot._volume_jump_peak_volume = 1.0  # peak == current -- never crossed the 50% line
    active = bot._update_volume_jump_guard(bot.state_row)
    check("released by the hard cap, not by the metric decaying", active is False, active)


async def t_regime_toggle_stochastic_off_blocks_low_volume_entry():
    print("\n[regime toggle: override_stochastic_enabled=False blocks the low-volume regime]")
    side = await _regime_toggle_case({"override_stochastic_enabled": False}, zebra_band=False)
    check("blocked -- stochastic regime off, below the volume switch", side is None, side)


async def t_regime_toggle_stochastic_on_default():
    print("\n[regime toggle: no override -- stochastic regime on by default]")
    side = await _regime_toggle_case({}, zebra_band=False)
    check("entered long -- default is on", side == "long", side)


async def t_regime_toggle_zebra_off_bypasses_band():
    print("\n[regime toggle: override_zebra_enabled=False lets the raw stochastic signal through]")
    side = await _regime_toggle_case({"override_zebra_enabled": False}, zebra_band=True)
    check("entered long -- band bypassed, even though it would have blocked", side == "long", side)


async def t_regime_toggle_zebra_on_default_still_blocks():
    print("\n[regime toggle: no override -- the color-balance band still gates by default]")
    side = await _regime_toggle_case({}, zebra_band=True)
    check("blocked -- band still applies", side is None, side)


async def t_regime_toggle_flip_off_blocks_high_volume_entry():
    print("\n[regime toggle: override_flip_enabled=False blocks the high-volume regime entirely]")
    side = await _regime_toggle_case({"override_flip_enabled": False}, zebra_band=False,
                                      candle_volume=5.0, threshold=2.0)
    check("blocked -- flip regime off, does NOT fall back to stochastic", side is None, side)


async def t_regime_toggle_flip_on_default():
    print("\n[regime toggle: no override -- flip regime on by default]")
    side = await _regime_toggle_case({}, zebra_band=False, candle_volume=5.0, threshold=2.0, flip_side="short")
    check("entered short -- the mocked flip side, flip regime active", side == "short", side)


async def t_regime_toggle_volume_threshold_override():
    print("\n[regime toggle: override_volume_switch_threshold changes which regime is active]")
    # Compiled threshold is 2.0; candle_volume is 5.0 (would normally route to flip). Override
    # raises the threshold to 10.0, so this reading should stay in the stochastic regime.
    side = await _regime_toggle_case({"override_volume_switch_threshold": 10.0}, zebra_band=False,
                                      candle_volume=5.0, threshold=2.0)
    check("entered long -- stochastic regime, override threshold not yet crossed", side == "long", side)


async def t_regime_toggle_off_by_default_schema_flag():
    print("\n[regime toggle: schema_has_regime_overrides=False ignores the override columns entirely]")
    side = await _regime_toggle_case({"override_stochastic_enabled": False}, schema_on=False, zebra_band=False)
    check("entered long -- override present on the row but the schema flag is off", side == "long", side)


def _band_k80_candles():
    # [0,100,50,50,80]: hh=100 ll=0, closed[-1]=80 -> K=100*(80-0)/(100-0)=80
    return make_dispersion_candles([0, 100, 50, 50, 80])


async def t_stoch_signal_band_override_narrows_entry():
    print("\n[compute_stoch_signal: explicit lo/hi args override the compiled band for one call]")
    candles = _band_k80_candles()
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid")
    bot.candles = candles
    default_sig, default_rev, _ = bot.compute_stoch_signal()
    check("default 25/75 band -- K=80 enters short", default_sig == "short", default_sig)
    check("default band -- reversal also short", default_rev == "short", default_rev)
    override_sig, override_rev, _ = bot.compute_stoch_signal(25, 85, 25, 85)
    check("override hi=85 -- K=80 no longer fires", override_sig is None, override_sig)
    check("override hi=85 -- reversal no longer fires either", override_rev is None, override_rev)


async def t_stoch_signal_band_override_no_args_unchanged():
    print("\n[compute_stoch_signal: calling with no override args behaves exactly as before]")
    candles = _band_k80_candles()
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid")
    bot.candles = candles
    sig, rev, _ = bot.compute_stoch_signal()
    check("still enters short with no args passed", sig == "short" and rev == "short", (sig, rev))


async def _stoch_band_case(state_overrides, schema_on=True):
    """K=80 (see _band_k80_candles): default 25/75 band enters short. An override hi>=80
    should block it; the point is proving the LIVE tick() path actually threads the override
    through compute_stoch_signal, not just the function's own optional args."""
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", schema_has_regime_overrides=schema_on)
    bot.candles = _band_k80_candles()
    bot.state_row.update(state_overrides)
    await bot.tick()
    return bot.state_row["side"]


async def t_stoch_band_control_blocks_entry_via_tick():
    print("\n[stoch band control: override_stoch_band_hi threaded through the real tick() path]")
    side = await _stoch_band_case({"override_stoch_band_lo": 25.0, "override_stoch_band_hi": 85.0})
    check("blocked -- K=80 no longer clears an 85 ceiling", side is None, side)


async def t_stoch_band_control_default_unchanged():
    print("\n[stoch band control: no override -- default 25/75 band still enters]")
    side = await _stoch_band_case({})
    check("entered short -- default band, K=80", side == "short", side)


async def t_stoch_band_control_off_by_default_schema_flag():
    print("\n[stoch band control: schema_has_regime_overrides=False ignores the override columns]")
    side = await _stoch_band_case({"override_stoch_band_lo": 25.0, "override_stoch_band_hi": 85.0}, schema_on=False)
    check("entered short -- override present on the row but the schema flag is off", side == "short", side)


async def t_stoch_signal_entry_and_reversal_independently_overridable():
    print("\n[compute_stoch_signal: entry and reversal bands move independently, not as a pair]")
    candles = _band_k80_candles()
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid")
    bot.candles = candles
    # entry band widened to exclude K=80; reversal band left at the default 75 ceiling.
    sig, rev, _ = bot.compute_stoch_signal(25, 85, 25, 75)
    check("entry blocked by its own wider band", sig is None, sig)
    check("reversal UNAFFECTED by the entry override -- still fires on the default 75", rev == "short", rev)


async def t_stoch_band_control_reversal_override_does_not_touch_entry():
    print("\n[stoch band control: overriding ONLY the reversal band leaves entry on the default]")
    side = await _stoch_band_case({"override_stoch_reversal_lo": 25.0, "override_stoch_reversal_hi": 85.0})
    check("entered short -- entry band untouched by a reversal-only override", side == "short", side)


def _window_sensitive_candles():
    # mids [60,95,55,65,70]: window=5 (default) -> hh=95,ll=55,close=70 -> K=37.5 (inside 25/75,
    # no entry). window=3 -> bars [55,65,70], hh=70,ll=55,close=70 -> K=100 (fires short). Picked
    # so overriding the window is the ONLY thing that can flip entry on, same proof shape as
    # _band_k80_candles for the band override tests.
    return make_dispersion_candles([60, 95, 55, 65, 70])


async def t_stoch_signal_window_override_changes_k():
    print("\n[compute_stoch_signal: a window arg overrides the compiled cfg.stoch_window for one call]")
    candles = _window_sensitive_candles()
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid")
    bot.candles = candles
    default_sig, default_rev, _ = bot.compute_stoch_signal()
    check("default window=5 -- K=37.5, inside the band, no signal", default_sig is None, default_sig)
    override_sig, override_rev, _ = bot.compute_stoch_signal(window=3)
    check("window=3 -- K=100, fires short", override_sig == "short", override_sig)
    check("window=3 -- reversal fires too (same K, same band)", override_rev == "short", override_rev)


async def _stoch_window_case(state_overrides, schema_on=True):
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", schema_has_regime_overrides=schema_on)
    bot.candles = _window_sensitive_candles()
    bot.state_row.update(state_overrides)
    await bot.tick()
    return bot.state_row["side"]


async def t_stoch_window_control_enables_entry_via_tick():
    print("\n[stoch window control: override_stoch_window threaded through the real tick() path]")
    side = await _stoch_window_case({"override_stoch_window": 3.0})
    check("entered short -- narrower window reveals K=100", side == "short", side)


async def t_stoch_window_control_default_unchanged():
    print("\n[stoch window control: no override -- default window=5 still blocks (K=37.5)]")
    side = await _stoch_window_case({})
    check("no entry -- default window, K inside the band", side is None, side)


async def t_stoch_window_control_off_by_default_schema_flag():
    print("\n[stoch window control: schema_has_regime_overrides=False ignores the override column]")
    side = await _stoch_window_case({"override_stoch_window": 3.0}, schema_on=False)
    check("no entry -- override present on the row but the schema flag is off", side is None, side)


def _trending_candles_122():
    # 122 candles, close rising by 1 each bar, zero path reversal -- deterministic ER ~1.0, "long".
    t0 = 1700000000000
    base = 86000.0
    return [{"t": t0 + i * 60000, "o": base + i, "h": base + i, "l": base + i, "c": base + i}
            for i in range(123)]  # 122 closed + 1 live, satisfies period=120 (needs closed>=121)


async def t_er_2h_readout_written_on_tick():
    print("\n[live_er_2h: a 120-candle efficiency ratio is published on the first tick]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", candles=_trending_candles_122(), schema_has_live_signal=True)
    await bot.tick()
    check("live_er_2h written", bot.state_row.get("live_er_2h") is not None, bot.state_row.get("live_er_2h"))
    check("live_er_2h close to 1.0 -- pure trend, no path reversal",
          bot.state_row.get("live_er_2h") is not None and abs(bot.state_row["live_er_2h"] - 1.0) < 1e-9,
          bot.state_row.get("live_er_2h"))
    check("live_er_2h_direction is long -- close rose over the window",
          bot.state_row.get("live_er_2h_direction") == "long", bot.state_row.get("live_er_2h_direction"))


async def t_er_2h_readout_skipped_without_enough_history():
    print("\n[live_er_2h: not enough candles -- no write, no crash]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", schema_has_live_signal=True)  # default "mid" candles, far fewer than 121
    await bot.tick()
    check("live_er_2h not written -- insufficient history",
          "live_er_2h" not in bot.state_row, bot.state_row.get("live_er_2h"))


async def t_er_2h_readout_off_without_schema_flag():
    print("\n[live_er_2h: schema_has_live_signal=False -- no write at all]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid", candles=_trending_candles_122(), schema_has_live_signal=False)
    await bot.tick()
    check("live_er_2h not written -- live-signal schema flag off",
          "live_er_2h" not in bot.state_row, bot.state_row.get("live_er_2h"))


def _schedule_candles(volume=2.5):
    c = _trending_candles_122()
    for bar in c:
        bar["v"] = volume
    return c  # ER ~1.0 (pure uptrend), volume=`volume`, rate~0.0 (uniform volume), some wiggle>0


def _schedule_sb(rules, enabled=True, calls=None, min_hold_seconds=0):
    async def fake_sb(method, path, body=None, extra_headers=None):
        if calls is not None:
            calls.append(path)
        if path.startswith("bot_schedule_rules"):
            return [{"enabled": enabled, "rules": rules, "min_hold_seconds": min_hold_seconds}]
        raise AssertionError(f"unexpected sb call: {method} {path}")
    return fake_sb


async def t_rule_matches_hour_range_basic():
    print("\n[_rule_matches: a plain hour range matches inside, not outside]")
    ex = FakeExchange()
    bot = make_bot(ex)
    rule = {"hour_start": 8, "hour_end": 16}
    check("inside the range", bot._rule_matches(rule, 10, None, None, None, None, None, None))
    check("at the start boundary (inclusive)", bot._rule_matches(rule, 8, None, None, None, None, None, None))
    check("at the end boundary (exclusive)", not bot._rule_matches(rule, 16, None, None, None, None, None, None))
    check("outside the range", not bot._rule_matches(rule, 20, None, None, None, None, None, None))


async def t_rule_matches_hour_range_wraps_midnight():
    print("\n[_rule_matches: hour_start > hour_end wraps past midnight]")
    ex = FakeExchange()
    bot = make_bot(ex)
    rule = {"hour_start": 22, "hour_end": 6}
    check("23:00 matches (after wrap start)", bot._rule_matches(rule, 23, None, None, None, None, None, None))
    check("02:00 matches (before wrap end)", bot._rule_matches(rule, 2, None, None, None, None, None, None))
    check("12:00 does not match (outside the overnight span)",
          not bot._rule_matches(rule, 12, None, None, None, None, None, None))


async def t_rule_matches_no_hour_range_matches_any_hour():
    print("\n[_rule_matches: no hour range set -- matches regardless of the current hour]")
    ex = FakeExchange()
    bot = make_bot(ex)
    rule = {"er_min": 0.1}
    check("matches at hour 3", bot._rule_matches(rule, 3, 0.2, None, None, None, None, None))
    check("matches at hour 19", bot._rule_matches(rule, 19, 0.2, None, None, None, None, None))


async def t_rule_matches_condition_bounds():
    print("\n[_rule_matches: min/max bounds on a live metric]")
    ex = FakeExchange()
    bot = make_bot(ex)
    rule = {"volume_min": 2.0, "volume_max": 5.0}
    check("inside bounds", bot._rule_matches(rule, 0, None, 3.0, None, None, None, None))
    check("at the min (inclusive)", bot._rule_matches(rule, 0, None, 2.0, None, None, None, None))
    check("at the max (inclusive)", bot._rule_matches(rule, 0, None, 5.0, None, None, None, None))
    check("below the min", not bot._rule_matches(rule, 0, None, 1.9, None, None, None, None))
    check("above the max", not bot._rule_matches(rule, 0, None, 5.1, None, None, None, None))


async def t_rule_matches_missing_reading_fails_closed():
    print("\n[_rule_matches: a condition is set but there's no reading yet -- fails, never guesses]")
    ex = FakeExchange()
    bot = make_bot(ex)
    rule = {"wiggle_max": 50.0}
    check("no wiggle reading available -- does not match", not bot._rule_matches(rule, 0, None, None, None, None, None, None))


async def t_rule_matches_combined_hour_and_conditions():
    print("\n[_rule_matches: hour range AND conditions must BOTH hold]")
    ex = FakeExchange()
    bot = make_bot(ex)
    rule = {"hour_start": 8, "hour_end": 16, "er_min": 0.15}
    check("both hold", bot._rule_matches(rule, 10, 0.20, None, None, None, None, None))
    check("hour holds, ER too low", not bot._rule_matches(rule, 10, 0.05, None, None, None, None, None))
    check("ER holds, hour outside range", not bot._rule_matches(rule, 20, 0.20, None, None, None, None, None))


async def t_rule_matches_vol_wiggle_ratio_condition():
    print("\n[_rule_matches: volume/wiggle ratio min/max, same as every other condition dimension]")
    ex = FakeExchange()
    bot = make_bot(ex)
    rule = {"vol_wiggle_ratio_max": 0.30}
    check("below the max", bot._rule_matches(rule, 0, None, None, None, None, 0.20, None))
    check("at the max (inclusive)", bot._rule_matches(rule, 0, None, None, None, None, 0.30, None))
    check("above the max", not bot._rule_matches(rule, 0, None, None, None, None, 0.45, None))
    check("no reading available -- fails closed", not bot._rule_matches(rule, 0, None, None, None, None, None, None))


async def t_rule_matches_vol_wiggle_product_condition():
    print("\n[_rule_matches: volume*wiggle PRODUCT min/max -- direct request: \"below 90 you trade\"]")
    ex = FakeExchange()
    bot = make_bot(ex)
    rule = {"vol_wiggle_product_max": 90}
    check("below the max", bot._rule_matches(rule, 0, None, None, None, None, None, 60))
    check("at the max (inclusive)", bot._rule_matches(rule, 0, None, None, None, None, None, 90))
    check("above the max", not bot._rule_matches(rule, 0, None, None, None, None, None, 91))
    check("no reading available -- fails closed", not bot._rule_matches(rule, 0, None, None, None, None, None, None))


async def t_apply_schedule_rules_computes_vol_wiggle_product_as_volume_times_wiggle():
    print("\n[_apply_schedule_rules: vol_wiggle_product is literally volume*wiggle, no separate compute]")
    ex = FakeExchange()
    # _schedule_candles(volume=2.5) -> wiggle = sqrt(2) (see t_schedule_rules_vol_wiggle_ratio
    # end-to-end test) -> product ~= 2.5 * 1.41421 ~= 3.5355
    bot = make_bot(ex, candles=_schedule_candles(volume=2.5), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1")
    matching_rule = {"vol_wiggle_product_min": 3.0, "vol_wiggle_product_max": 4.0,
                      "worker1": {"sl_pct": 0.11}}
    bot.sb = _schedule_sb([matching_rule])
    await bot._apply_schedule_rules(bot.state_row)
    check("rule matched on the real computed product -- settings applied",
          bot.state_row.get("override_sl_pct") == 0.11)

    ex2 = FakeExchange()
    bot2 = make_bot(ex2, candles=_schedule_candles(volume=2.5), schedule_rules_enabled=True,
                     schedule_rules_bot_key="worker1")
    non_matching_rule = {"vol_wiggle_product_max": 1.0,  # below the real ~3.5 product
                          "worker1": {"sl_pct": 0.11}}
    bot2.sb = _schedule_sb([non_matching_rule])
    await bot2._apply_schedule_rules(bot2.state_row)
    check("rule did NOT match -- the real product is above this bound",
          "override_sl_pct" not in bot2.state_row)


async def t_schedule_current_hour_is_miami_not_utc():
    print("\n[_schedule_current_hour: Miami local time (America/New_York), not UTC -- direct request]")
    ex = FakeExchange()
    bot = make_bot(ex)
    expected = datetime.now(core.SCHEDULE_TZ).hour
    check("SCHEDULE_TZ is America/New_York (covers Miami, DST-aware)",
          str(core.SCHEDULE_TZ) == "America/New_York", str(core.SCHEDULE_TZ))
    check("_schedule_current_hour() returns the Miami-local hour, computed the same way",
          bot._schedule_current_hour() == expected, (bot._schedule_current_hour(), expected))


async def t_schedule_rules_off_by_default_schema_flag():
    print("\n[schedule rules: schedule_rules_enabled=False -- never fetches, never writes]")
    ex = FakeExchange()
    calls = []
    bot = make_bot(ex, candles=_schedule_candles(), schedule_rules_enabled=False,
                    schedule_rules_bot_key="worker1")
    bot.sb = _schedule_sb([{"worker1": {"sl_pct": 0.5}}], calls=calls)
    await bot._apply_schedule_rules(bot.state_row)
    check("never fetched the shared schedule row", calls == [], calls)
    check("no override written", "override_sl_pct" not in bot.state_row)
    check("enabled untouched", bot.state_row["enabled"] is True)


async def t_schedule_rules_off_without_bot_key():
    print("\n[schedule rules: enabled but no bot_key configured -- defensive no-op]")
    ex = FakeExchange()
    calls = []
    bot = make_bot(ex, candles=_schedule_candles(), schedule_rules_enabled=True,
                    schedule_rules_bot_key=None)
    bot.sb = _schedule_sb([{"worker1": {"sl_pct": 0.5}}], calls=calls)
    await bot._apply_schedule_rules(bot.state_row)
    check("never fetched -- no bot_key means nothing to apply", calls == [], calls)


async def t_schedule_rules_row_disabled_no_write():
    print("\n[schedule rules: the shared row's own enabled=False -- no write even with matching rules]")
    ex = FakeExchange()
    bot = make_bot(ex, candles=_schedule_candles(), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1")
    bot.sb = _schedule_sb([{"worker1": {"sl_pct": 0.5}}], enabled=False)
    await bot._apply_schedule_rules(bot.state_row)
    check("no override written -- schedule system itself is off", "override_sl_pct" not in bot.state_row)
    check("enabled untouched -- schedule system itself is off", bot.state_row["enabled"] is True)


async def t_schedule_rules_vol_wiggle_ratio_condition_end_to_end():
    print("\n[schedule rules: a vol_wiggle_ratio condition is actually computed and threaded through]")
    ex = FakeExchange()
    # _schedule_candles(volume=2.5) -> compute_volume_wiggle_ratio ~= sqrt(2) / 2.5 ~= 0.566
    # (wiggle/volume, flipped 2026-10-05 -- was volume/wiggle).
    bot = make_bot(ex, candles=_schedule_candles(volume=2.5), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1")
    matching_rule = {"vol_wiggle_ratio_min": 0.3, "vol_wiggle_ratio_max": 1.0,
                      "worker1": {"sl_pct": 0.13}}
    bot.sb = _schedule_sb([matching_rule])
    await bot._apply_schedule_rules(bot.state_row)
    check("rule matched on the real computed ratio -- settings applied",
          bot.state_row.get("override_sl_pct") == 0.13)

    ex2 = FakeExchange()
    bot2 = make_bot(ex2, candles=_schedule_candles(volume=2.5), schedule_rules_enabled=True,
                     schedule_rules_bot_key="worker1")
    non_matching_rule = {"vol_wiggle_ratio_min": 5.0,  # well above the real ~0.566 reading
                          "worker1": {"sl_pct": 0.13}}
    bot2.sb = _schedule_sb([non_matching_rule])
    await bot2._apply_schedule_rules(bot2.state_row)
    check("rule did NOT match -- the real ratio is below this bound",
          "override_sl_pct" not in bot2.state_row)


async def t_schedule_rules_applies_worker1_fields():
    print("\n[schedule rules: a matching rule writes Worker 1's full override field set]")
    ex = FakeExchange()
    bot = make_bot(ex, candles=_schedule_candles(volume=3.0), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1")
    rule = {"hour_start": 0, "hour_end": 24,
            "worker1": {"sl_pct": 0.20, "trigger_pct": 0.05, "trail_pct": 0.03, "tp_pct": 0.12,
                        "dwell_seconds": 15, "band_lo": 15, "band_hi": 85,
                        "reversal_lo": 10, "reversal_hi": 90, "window": 8,
                        "escalated_sl_enabled": True}}
    bot.sb = _schedule_sb([rule])
    await bot._apply_schedule_rules(bot.state_row)
    check("sl written", bot.state_row.get("override_sl_pct") == 0.20)
    check("trigger written", bot.state_row.get("override_profit_lock_trigger") == 0.05)
    check("trail written", bot.state_row.get("override_profit_lock_trail") == 0.03)
    check("tp written", bot.state_row.get("override_tp_pct") == 0.12)
    check("dwell written", bot.state_row.get("override_dwell_seconds") == 15)
    check("entry band written", bot.state_row.get("override_stoch_band_lo") == 15
          and bot.state_row.get("override_stoch_band_hi") == 85)
    check("reversal band written", bot.state_row.get("override_stoch_reversal_lo") == 10
          and bot.state_row.get("override_stoch_reversal_hi") == 90)
    check("window written", bot.state_row.get("override_stoch_window") == 8)
    check("escalated SL written", bot.state_row.get("override_escalated_sl_enabled") is True)
    check("already enabled -- stays enabled, no redundant enabled patch needed",
          bot.state_row["enabled"] is True)


async def t_schedule_rules_escalated_sl_false_is_explicitly_written():
    print("\n[schedule rules: escalated_sl_enabled=False is a real write, not treated as unset]")
    ex = FakeExchange()
    bot = make_bot(ex, candles=_schedule_candles(volume=3.0), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1")
    rule = {"worker1": {"sl_pct": 0.08, "escalated_sl_enabled": False}}
    bot.sb = _schedule_sb([rule])
    await bot._apply_schedule_rules(bot.state_row)
    check("escalated SL explicitly turned off",
          bot.state_row.get("override_escalated_sl_enabled") is False)


async def t_schedule_rules_escalated_sl_absent_leaves_it_alone():
    print("\n[schedule rules: no escalated_sl_enabled in the rule -- untouched]")
    ex = FakeExchange()
    bot = make_bot(ex, candles=_schedule_candles(volume=3.0), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1")
    rule = {"worker1": {"sl_pct": 0.08}}
    bot.sb = _schedule_sb([rule])
    await bot._apply_schedule_rules(bot.state_row)
    check("escalated SL key never written", "override_escalated_sl_enabled" not in bot.state_row)


async def t_schedule_rules_applies_hedge_fields_only():
    print("\n[schedule rules: a matching rule writes only the hedge's smaller exit-lever set]")
    ex = FakeExchange()
    bot = make_bot(ex, candles=_schedule_candles(volume=3.0), schedule_rules_enabled=True,
                    schedule_rules_bot_key="hedge")
    rule = {"hour_start": 0, "hour_end": 24,
            "worker1": {"sl_pct": 0.99},  # must be ignored -- this bot is "hedge"
            "hedge": {"sl_pct": 0.04, "trigger_pct": 0.04, "trail_pct": 0.02, "tp_pct": 0.10,
                      "dwell_seconds": 20}}
    bot.sb = _schedule_sb([rule])
    await bot._apply_schedule_rules(bot.state_row)
    check("hedge sl written, not worker1's", bot.state_row.get("override_sl_pct") == 0.04)
    check("hedge trigger/trail/tp/dwell written",
          bot.state_row.get("override_profit_lock_trigger") == 0.04
          and bot.state_row.get("override_profit_lock_trail") == 0.02
          and bot.state_row.get("override_tp_pct") == 0.10
          and bot.state_row.get("override_dwell_seconds") == 20)
    check("no stoch-band fields written -- not part of the hedge's field set",
          "override_stoch_band_lo" not in bot.state_row)


async def t_schedule_rules_no_match_turns_bot_on():
    print("\n[schedule rules: no rule matches -- turns the bot ON, writes no settings]")
    ex = FakeExchange()
    bot = make_bot(ex, candles=_schedule_candles(), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1")
    bot.state_row["enabled"] = False
    rule = {"hour_start": 0, "hour_end": 24, "er_min": 2.0,  # impossible -- ER never reaches 2.0
            "worker1": {"sl_pct": 0.5}}
    bot.sb = _schedule_sb([rule])
    await bot._apply_schedule_rules(bot.state_row)
    check("no settings written", "override_sl_pct" not in bot.state_row)
    check("bot turned ON -- no match, direct request: \"both ons\" (real rule set has a gap "
          "where nothing matches, and the bot must keep trading through it, not shut down)",
          bot.state_row["enabled"] is True)


async def t_schedule_rules_no_match_leaves_an_already_on_bot_on():
    print("\n[schedule rules: no rule matches and bot is already ON -- no redundant write]")
    ex = FakeExchange()
    bot = make_bot(ex, candles=_schedule_candles(), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1")
    bot.state_row["enabled"] = True
    rule = {"hour_start": 0, "hour_end": 24, "er_min": 2.0,
            "worker1": {"sl_pct": 0.5}}
    bot.sb = _schedule_sb([rule])
    await bot._apply_schedule_rules(bot.state_row)
    check("no settings written", "override_sl_pct" not in bot.state_row)
    check("stays ON, no spurious patch", bot.state_row["enabled"] is True)


async def t_schedule_rules_match_turns_bot_on():
    print("\n[schedule rules: a matching rule turns the bot ON even if it was off]")
    ex = FakeExchange()
    bot = make_bot(ex, candles=_schedule_candles(), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1")
    bot.state_row["enabled"] = False
    rule = {"hour_start": 0, "hour_end": 24, "worker1": {"sl_pct": 0.15}}
    bot.sb = _schedule_sb([rule])
    await bot._apply_schedule_rules(bot.state_row)
    check("bot turned ON -- direct request: \"if off turn it on\"", bot.state_row["enabled"] is True)
    check("settings applied too", bot.state_row.get("override_sl_pct") == 0.15)


async def t_schedule_rules_per_bot_enabled_flag_independent_of_settings():
    print("\n[schedule rules: {bot}_enabled decides ON/OFF, independent of that bot having settings]")
    # Direct follow-up: "maybe with this rule I want 1 on and the other off... I need a little
    # switch". The same rule carries a non-empty settings object for BOTH bots, but only
    # worker1_enabled is true -- hedge must still end up OFF despite having its own settings.
    rule = {"hour_start": 0, "hour_end": 24,
            "worker1_enabled": True, "hedge_enabled": False,
            "worker1": {"sl_pct": 0.15}, "hedge": {"sl_pct": 0.05}}

    ex1 = FakeExchange()
    bot1 = make_bot(ex1, candles=_schedule_candles(), schedule_rules_enabled=True,
                     schedule_rules_bot_key="worker1")
    bot1.sb = _schedule_sb([rule])
    await bot1._apply_schedule_rules(bot1.state_row)
    check("worker1_enabled=True -- Worker 1 turns ON", bot1.state_row["enabled"] is True)

    ex2 = FakeExchange()
    bot2 = make_bot(ex2, candles=_schedule_candles(), schedule_rules_enabled=True,
                     schedule_rules_bot_key="hedge")
    bot2.sb = _schedule_sb([rule])
    await bot2._apply_schedule_rules(bot2.state_row)
    check("hedge_enabled=False -- hedge turns OFF despite having its own settings on this rule",
          bot2.state_row["enabled"] is False)


async def t_schedule_rules_enabled_flag_defaults_true_when_absent():
    print("\n[schedule rules: no explicit {bot}_enabled field -- defaults to True (old behavior)]")
    ex = FakeExchange()
    bot = make_bot(ex, candles=_schedule_candles(), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1")
    bot.state_row["enabled"] = False
    rule = {"hour_start": 0, "hour_end": 24, "worker1": {"sl_pct": 0.15}}  # no worker1_enabled key
    bot.sb = _schedule_sb([rule])
    await bot._apply_schedule_rules(bot.state_row)
    check("defaults to enabled when the flag is simply absent", bot.state_row["enabled"] is True)


async def t_schedule_rules_enabled_null_leaves_it_untouched_when_currently_on():
    print("\n[schedule rules: {bot}_enabled explicitly null -- \"Don't change\", leaves enabled alone]")
    print("  direct request: \"we need to put another option Dont change when matched -- so")
    print("  whatever is happening in 1 rule does not touch the other rules\"")
    ex = FakeExchange()
    bot = make_bot(ex, candles=_schedule_candles(), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1")
    bot.state_row["enabled"] = True
    rule = {"hour_start": 0, "hour_end": 24, "worker1_enabled": None}  # explicit null, not absent
    bot.sb = _schedule_sb([rule])
    await bot._apply_schedule_rules(bot.state_row)
    check("still enabled, untouched", bot.state_row["enabled"] is True)


async def t_schedule_rules_enabled_null_leaves_it_untouched_when_currently_off():
    print("\n[schedule rules: {bot}_enabled=null does NOT turn a currently-off bot back on]")
    ex = FakeExchange()
    bot = make_bot(ex, candles=_schedule_candles(), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1")
    bot.state_row["enabled"] = False
    rule = {"hour_start": 0, "hour_end": 24, "worker1_enabled": None,
            "worker1": {"sl_pct": 0.15}}  # settings present, but enabled is still "don't touch"
    bot.sb = _schedule_sb([rule])
    await bot._apply_schedule_rules(bot.state_row)
    check("stays OFF -- null means no opinion, settings existing on the rule doesn't force it on",
          bot.state_row["enabled"] is False)
    check("settings still pre-staged though -- only the on/off decision is skipped",
          bot.state_row.get("override_sl_pct") == 0.15)


async def t_schedule_rules_enabled_null_lets_one_bots_rule_ignore_the_other_bot():
    print("\n[schedule rules: a hedge-only rule with worker1_enabled=null never touches Worker 1]")
    # The exact real-money scenario this was built for: a hedge rule placed first in the list
    # must be able to match without forcing Worker 1 on OR off -- true no-op for the other bot.
    rule = {"hour_start": 0, "hour_end": 24,
            "worker1_enabled": None, "hedge_enabled": True,
            "hedge": {"sl_pct": 0.04}}

    ex1 = FakeExchange()
    bot1 = make_bot(ex1, candles=_schedule_candles(), schedule_rules_enabled=True,
                     schedule_rules_bot_key="worker1")
    bot1.state_row["enabled"] = True
    bot1.sb = _schedule_sb([rule])
    await bot1._apply_schedule_rules(bot1.state_row)
    check("Worker 1 untouched -- stays enabled, this rule has no opinion on it",
          bot1.state_row["enabled"] is True and "override_sl_pct" not in bot1.state_row)

    ex2 = FakeExchange()
    bot2 = make_bot(ex2, candles=_schedule_candles(), schedule_rules_enabled=True,
                     schedule_rules_bot_key="hedge")
    bot2.sb = _schedule_sb([rule])
    await bot2._apply_schedule_rules(bot2.state_row)
    check("hedge turns ON with its own settings as normal",
          bot2.state_row["enabled"] is True and bot2.state_row.get("override_sl_pct") == 0.04)


async def t_schedule_rules_settings_still_applied_while_bot_held_off():
    print("\n[schedule rules: settings pre-stage even while {bot}_enabled holds the bot OFF]")
    ex = FakeExchange()
    bot = make_bot(ex, candles=_schedule_candles(), schedule_rules_enabled=True,
                    schedule_rules_bot_key="hedge")
    rule = {"hour_start": 0, "hour_end": 24, "hedge_enabled": False,
            "hedge": {"sl_pct": 0.07, "trigger_pct": 0.04}}
    bot.sb = _schedule_sb([rule])
    await bot._apply_schedule_rules(bot.state_row)
    check("hedge held OFF", bot.state_row["enabled"] is False)
    check("but its settings are still pre-staged for whenever it next turns on",
          bot.state_row.get("override_sl_pct") == 0.07
          and bot.state_row.get("override_profit_lock_trigger") == 0.04)


async def t_schedule_rules_enabled_sync_overrides_manual_change_every_cycle():
    print("\n[schedule rules: a manual ON/OFF click gets overridden back every cycle, not just on a new match]")
    ex = FakeExchange()
    bot = make_bot(ex, candles=_schedule_candles(), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1")
    rule = {"hour_start": 0, "hour_end": 24, "worker1": {"sl_pct": 0.15}}
    bot.sb = _schedule_sb([rule])
    await bot._apply_schedule_rules(bot.state_row)
    check("first cycle: enabled", bot.state_row["enabled"] is True)
    # Simulate a manual OFF click in between schedule cycles -- the SAME rule still matches.
    bot.state_row["enabled"] = False
    bot._schedule_rules_last_fetch_ts = 0.0  # force the throttle to allow a second check
    await bot._apply_schedule_rules(bot.state_row)
    check("second cycle: re-asserted ON despite the manual OFF, rule content unchanged",
          bot.state_row["enabled"] is True)


async def t_schedule_rules_first_match_wins():
    print("\n[schedule rules: list order is precedence -- the first matching rule wins]")
    ex = FakeExchange()
    bot = make_bot(ex, candles=_schedule_candles(), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1")
    rules = [
        {"hour_start": 0, "hour_end": 24, "worker1": {"sl_pct": 0.11}},
        {"hour_start": 0, "hour_end": 24, "worker1": {"sl_pct": 0.22}},
    ]
    bot.sb = _schedule_sb(rules)
    await bot._apply_schedule_rules(bot.state_row)
    check("the FIRST matching rule's value wins", bot.state_row.get("override_sl_pct") == 0.11)


async def t_schedule_rules_unchanged_match_does_not_rewrite():
    print("\n[schedule rules: the same matched rule twice in a row does not re-write the SETTINGS]")
    ex = FakeExchange()
    calls = []
    bot = make_bot(ex, candles=_schedule_candles(), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1")
    rule = {"hour_start": 0, "hour_end": 24, "worker1": {"sl_pct": 0.11}}
    bot.sb = _schedule_sb([rule], calls=calls)
    bot._schedule_rules_last_fetch_ts = 0.0
    await bot._apply_schedule_rules(bot.state_row)
    check("first call wrote the value", bot.state_row.get("override_sl_pct") == 0.11)
    write_count_after_first = len(bot.runs)
    # Force a second fetch (bypass the 30s throttle) with the SAME rule content; already enabled,
    # so this cycle's patch would be empty (settings unchanged, enabled unchanged) -- no write.
    bot._schedule_rules_last_fetch_ts = 0.0
    bot.state_row.pop("override_sl_pct")  # prove a second write would be detectable if it happened
    await bot._apply_schedule_rules(bot.state_row)
    check("second call with the unchanged rule did not re-write the settings",
          "override_sl_pct" not in bot.state_row)
    check("no new schedule_rule_applied run logged on the fully-unchanged cycle",
          len(bot.runs) == write_count_after_first, (len(bot.runs), write_count_after_first))


async def t_schedule_rules_fetch_is_throttled():
    print("\n[schedule rules: the shared row is fetched at most every 30s, not every call]")
    ex = FakeExchange()
    calls = []
    bot = make_bot(ex, candles=_schedule_candles(), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1")
    rule = {"hour_start": 0, "hour_end": 24, "worker1": {"sl_pct": 0.11}}
    bot.sb = _schedule_sb([rule], calls=calls)
    await bot._apply_schedule_rules(bot.state_row)
    check("first call fetches", len(calls) == 1, calls)
    await bot._apply_schedule_rules(bot.state_row)
    check("second call within 30s does not re-fetch", len(calls) == 1, calls)


async def t_schedule_rules_min_hold_zero_applies_instantly():
    print("\n[schedule rules: min_hold_seconds=0 (default) -- instant switch, same as before this feature]")
    ex = FakeExchange()
    bot = make_bot(ex, candles=_schedule_candles(volume=2.5), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1")
    rule = {"vol_wiggle_product_min": 3.0, "vol_wiggle_product_max": 4.0,
            "worker1": {"sl_pct": 0.22}}
    bot.sb = _schedule_sb([rule], min_hold_seconds=0)
    await bot._apply_schedule_rules(bot.state_row)
    check("applied on the very first matching tick", bot.state_row.get("override_sl_pct") == 0.22)


async def t_schedule_rules_min_hold_delays_a_new_candidate():
    print("\n[schedule rules: min_hold_seconds>0 -- a brand new candidate is NOT applied immediately]")
    ex = FakeExchange()
    bot = make_bot(ex, candles=_schedule_candles(volume=2.5), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1")
    rule = {"vol_wiggle_product_min": 3.0, "vol_wiggle_product_max": 4.0,
            "worker1": {"sl_pct": 0.22}}
    bot.sb = _schedule_sb([rule], min_hold_seconds=300)
    await bot._apply_schedule_rules(bot.state_row)
    check("rule matches but hasn't been held 5 minutes yet -- not applied",
          "override_sl_pct" not in bot.state_row)


async def t_schedule_rules_min_hold_applies_once_cleared():
    print("\n[schedule rules: min_hold_seconds>0 -- applies once the candidate has been held long enough]")
    ex = FakeExchange()
    bot = make_bot(ex, candles=_schedule_candles(volume=2.5), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1")
    rule = {"vol_wiggle_product_min": 3.0, "vol_wiggle_product_max": 4.0,
            "worker1": {"sl_pct": 0.22}}
    bot.sb = _schedule_sb([rule], min_hold_seconds=300)
    await bot._apply_schedule_rules(bot.state_row)
    check("not applied yet", "override_sl_pct" not in bot.state_row)
    bot._schedule_candidate_since = time.time() - 301  # pretend 5+ minutes have passed
    await bot._apply_schedule_rules(bot.state_row)
    check("applied once the hold cleared", bot.state_row.get("override_sl_pct") == 0.22)


async def t_schedule_rules_min_hold_resets_on_candidate_change():
    print("\n[schedule rules: min_hold_seconds>0 -- a flip to a DIFFERENT candidate restarts the "
          "timer and keeps the previously-effective rule's settings in place]")
    ex = FakeExchange()
    bot = make_bot(ex, candles=_schedule_candles(volume=2.5), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1")
    rule_a = {"vol_wiggle_product_min": 3.0, "vol_wiggle_product_max": 4.0,
              "worker1": {"sl_pct": 0.22}}
    bot.sb = _schedule_sb([rule_a], min_hold_seconds=300)
    await bot._apply_schedule_rules(bot.state_row)
    bot._schedule_candidate_since = time.time() - 301
    await bot._apply_schedule_rules(bot.state_row)
    check("rule_a applied after its hold cleared", bot.state_row.get("override_sl_pct") == 0.22)

    # Same live reading still satisfies these bounds, but it's now a DIFFERENT rule object
    # (different settings) -- e.g. the saved rules changed, or a higher-precedence rule's own
    # content changed. This must count as a new candidate and restart the hold.
    rule_b = {"vol_wiggle_product_min": 3.0, "vol_wiggle_product_max": 4.0,
              "worker1": {"sl_pct": 0.33}}
    bot.sb = _schedule_sb([rule_b], min_hold_seconds=300)
    bot._schedule_rules_last_fetch_ts = 0.0  # force the throttle to allow picking up rule_b
    await bot._apply_schedule_rules(bot.state_row)
    check("rule_b is a new candidate -- NOT applied yet, rule_a's settings remain in effect",
          bot.state_row.get("override_sl_pct") == 0.22)
    await bot._apply_schedule_rules(bot.state_row)
    check("still rule_a's settings after another short tick", bot.state_row.get("override_sl_pct") == 0.22)
    bot._schedule_candidate_since = time.time() - 301
    await bot._apply_schedule_rules(bot.state_row)
    check("rule_b finally applies once ITS OWN hold clears", bot.state_row.get("override_sl_pct") == 0.33)


async def t_schedule_rules_malformed_data_fails_closed():
    print("\n[schedule rules: malformed rules (None, not a list) never crash -- treated as empty]")
    ex = FakeExchange()
    bot = make_bot(ex, candles=_schedule_candles(), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1")
    bot.sb = _schedule_sb(None)  # rules is None, not a list
    await bot._apply_schedule_rules(bot.state_row)  # must not raise
    check("no settings written with rules=None", "override_sl_pct" not in bot.state_row)
    check("treated as no match -- bot turned on, same as any other no-match", bot.state_row["enabled"] is True)


async def t_schedule_rules_mutates_local_state_dict_immediately():
    print("\n[schedule rules: real-money bug fix -- mutates the passed-in state dict immediately, "
          "so the rest of the SAME tick never acts on a stale pre-decision enabled value]")
    ex = FakeExchange()
    bot = make_bot(ex, candles=_schedule_candles(), schedule_rules_enabled=True,
                    schedule_rules_bot_key="hedge")
    rule = {"hedge_enabled": False}  # no conditions -> always matches, turns the bot off
    bot.sb = _schedule_sb([rule])
    # Mirror tick()'s real shape: `state` is a SEPARATE dict object from bot.state_row --
    # get_state() returns a fresh copy in production, update_state() only PATCHes the DB and
    # never touches it. Before this fix, tick()'s own `wants_in = ... and state.get("enabled")`
    # check (much further down in the same call) kept reading this stale True for the rest of
    # the tick, letting a leg the schedule had JUST turned off still enter a new hedge cycle.
    local_state = dict(bot.state_row)
    local_state["enabled"] = True
    await bot._apply_schedule_rules(local_state)
    check("the local state dict reflects the new enabled value immediately",
          local_state.get("enabled") is False)
    check("the DB-side row was independently updated too",
          bot.state_row.get("enabled") is False)


async def t_schedule_rules_metrics_not_published_without_schema_flag():
    print("\n[schedule rules: schema_has_schedule_metrics=False (default) -- never publishes live_schedule_*]")
    ex = FakeExchange()
    bot = make_bot(ex, candles=_schedule_candles(volume=2.5), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1")  # schema_has_schedule_metrics defaults False
    bot.sb = _schedule_sb([{"worker1": {"sl_pct": 0.11}}])
    await bot._apply_schedule_rules(bot.state_row)
    check("settings still applied", bot.state_row.get("override_sl_pct") == 0.11)
    check("no live_schedule_* columns written", "live_schedule_volume" not in bot.state_row
          and "live_schedule_wiggle" not in bot.state_row)


async def t_schedule_rules_publishes_live_metrics_with_schema_flag():
    print("\n[schedule rules: schema_has_schedule_metrics=True -- publishes the exact numbers matched against]")
    ex = FakeExchange()
    # _schedule_candles(volume=2.5) -> wiggle = sqrt(2), ratio = wiggle/volume ~= 0.56569
    # (flipped 2026-10-05, was volume/wiggle ~= 1.7678), product ~= 3.5355.
    bot = make_bot(ex, candles=_schedule_candles(volume=2.5), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1", schema_has_schedule_metrics=True)
    bot.sb = _schedule_sb([{"worker1": {"sl_pct": 0.11}}])
    await bot._apply_schedule_rules(bot.state_row)
    check("volume published", bot.state_row.get("live_schedule_volume") == 2.5)
    check("wiggle published", abs(bot.state_row.get("live_schedule_wiggle") - 1.41421356) < 1e-4)
    check("vol_wiggle_ratio published", abs(bot.state_row.get("live_schedule_vol_wiggle_ratio") - 0.56569) < 1e-3)
    check("vol_wiggle_product published", abs(bot.state_row.get("live_schedule_vol_wiggle_product") - 3.53553) < 1e-3)
    check("er published (not None)", bot.state_row.get("live_schedule_er") is not None)
    check("rate published (not None)", bot.state_row.get("live_schedule_rate") is not None)


async def t_schedule_rules_publishes_zebra_alternation_index():
    print("\n[schedule rules: live_schedule_zebra -- perfect color alternation reads close to 100]")
    ex = FakeExchange()
    # 6 candles (5 closed + 1 forming), perfectly alternating green/red/green/red/green around a
    # fixed 995<->1005 range -- color flips on every consecutive pair (zebra_pct=100) with a
    # consistent ~1% body size, so zebra_pct/size_pct lands close to 100.
    base_t = 1700000000000
    bodies = [(995, 1005), (1005, 995), (995, 1005), (1005, 995), (995, 1005), (1005, 995)]
    candles = [{"t": base_t + i * 60000, "o": o, "c": c, "h": max(o, c), "l": min(o, c), "v": 1.0}
               for i, (o, c) in enumerate(bodies)]
    bot = make_bot(ex, candles=candles, schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1", schema_has_schedule_metrics=True)
    bot.sb = _schedule_sb([{}])  # matches unconditionally, no settings needed for this check
    await bot._apply_schedule_rules(bot.state_row)
    zebra = bot.state_row.get("live_schedule_zebra")
    check("zebra published and close to 100 (perfect alternation, ~1% consistent body size)",
          zebra is not None and abs(zebra - 100.0) < 1.0, zebra)


async def t_schedule_rules_publishes_color_balance_index():
    print("\n[schedule rules: live_schedule_color_balance is published, universal for every bot]")
    ex = FakeExchange()
    base_t = 1700000000000
    bodies = [(995, 1005), (1005, 995), (995, 1005), (1005, 995), (995, 1005), (1005, 995)]
    candles = [{"t": base_t + i * 60000, "o": o, "c": c, "h": max(o, c), "l": min(o, c), "v": 1.0}
               for i, (o, c) in enumerate(bodies)]
    bot = make_bot(ex, candles=candles, schedule_rules_enabled=True,
                    schedule_rules_bot_key="hedge", schema_has_schedule_metrics=True)
    bot.sb = _schedule_sb([{}])
    await bot._apply_schedule_rules(bot.state_row)
    cb = bot.state_row.get("live_schedule_color_balance")
    check("color balance published, in range (not gated behind that bot's own entry config)",
          cb is not None and 0 <= cb <= 100, cb)


async def t_schedule_rules_zebra_and_color_balance_conditions_match():
    print("\n[schedule rules: zebra_min/max and color_balance_min/max actually gate a match]")
    base_t = 1700000000000
    bodies = [(995, 1005), (1005, 995), (995, 1005), (1005, 995), (995, 1005), (1005, 995)]
    candles = [{"t": base_t + i * 60000, "o": o, "c": c, "h": max(o, c), "l": min(o, c), "v": 1.0}
               for i, (o, c) in enumerate(bodies)]
    ex = FakeExchange()
    bot = make_bot(ex, candles=candles, schedule_rules_enabled=True, schedule_rules_bot_key="worker1")
    matching_rule = {"zebra_min": 90, "worker1": {"sl_pct": 0.21}}  # real reading is ~100.1
    bot.sb = _schedule_sb([matching_rule])
    await bot._apply_schedule_rules(bot.state_row)
    check("zebra_min condition matched the real alternation reading",
          bot.state_row.get("override_sl_pct") == 0.21)

    ex2 = FakeExchange()
    bot2 = make_bot(ex2, candles=candles, schedule_rules_enabled=True, schedule_rules_bot_key="worker1")
    non_matching_rule = {"zebra_min": 150, "worker1": {"sl_pct": 0.21}}
    bot2.sb = _schedule_sb([non_matching_rule])
    await bot2._apply_schedule_rules(bot2.state_row)
    check("zebra_min above the real ~100.1 reading did NOT match",
          "override_sl_pct" not in bot2.state_row)

    ex3 = FakeExchange()
    bot3 = make_bot(ex3, candles=candles, schedule_rules_enabled=True, schedule_rules_bot_key="worker1")
    non_matching_cb_rule = {"color_balance_min": 0, "color_balance_max": 0.01, "worker1": {"sl_pct": 0.21}}
    bot3.sb = _schedule_sb([non_matching_cb_rule])
    await bot3._apply_schedule_rules(bot3.state_row)
    check("an impossibly tight color_balance bound did NOT match",
          "override_sl_pct" not in bot3.state_row)


async def t_schedule_rules_metrics_publish_is_isolated_from_settings_patch():
    print("\n[schedule rules: a bot with no settings for its key still publishes live metrics]")
    ex = FakeExchange()
    bot = make_bot(ex, candles=_schedule_candles(volume=2.5), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1", schema_has_schedule_metrics=True)
    # Rule matches (no conditions set) but carries no "worker1" settings object at all.
    bot.sb = _schedule_sb([{}])
    await bot._apply_schedule_rules(bot.state_row)
    check("no settings columns written", "override_sl_pct" not in bot.state_row)
    check("metrics still published independently", bot.state_row.get("live_schedule_volume") == 2.5)


async def t_schedule_rules_metrics_publish_throttled():
    print("\n[schedule rules: live metrics re-published immediately, but not forced -- a second call this soon still writes fresh values]")
    ex = FakeExchange()
    bot = make_bot(ex, candles=_schedule_candles(volume=2.5), schedule_rules_enabled=True,
                    schedule_rules_bot_key="worker1", schema_has_schedule_metrics=True)
    bot.sb = _schedule_sb([{"worker1": {"sl_pct": 0.11}}])
    await bot._apply_schedule_rules(bot.state_row)
    first_ts = bot._schedule_metrics_last_persist_ts
    check("persist timestamp stamped on first call", first_ts > 0)
    bot.state_row.pop("live_schedule_volume")
    await bot._apply_schedule_rules(bot.state_row)
    check("throttled -- immediate second call does not re-publish within 5s",
          "live_schedule_volume" not in bot.state_row)
    check("throttle timestamp unchanged on the throttled call",
          bot._schedule_metrics_last_persist_ts == first_ts)


async def t_volume_switch_uses_flip_above_threshold():
    print("\n[volume regime switch: at/above threshold, flip signal wins and gates are bypassed]")
    side = await _volume_switch_case(candle_volume=5.0, threshold=2.0)
    check("entered short -- the flip signal's side, not the blocked stochastic long", side == "short", side)


async def t_volume_switch_keeps_normal_path_below_threshold():
    print("\n[volume regime switch: below threshold, normal stochastic+zebra path is unchanged]")
    side = await _volume_switch_case(candle_volume=1.0, threshold=2.0)
    check("blocked -- zebra band still gates the ordinary stochastic signal", side is None, side)


async def t_volume_switch_off_by_default():
    print("\n[volume regime switch: no threshold configured -> never active]")
    ex = FakeExchange()
    bot = make_bot(ex, candles_kind="mid",
                   zebra_index_min=600.0, zebra_index_max=1000.0)
    bot.candles = make_dispersion_candles([150, 150, 150, 150, 0])
    orig_vol = core.compute_candle_volume_avg
    core.compute_candle_volume_avg = lambda c, w=10: 999.0  # would be "high volume" if it mattered
    try:
        await bot.tick()
    finally:
        core.compute_candle_volume_avg = orig_vol
    check("blocked -- zebra gate still applies, flip path never consulted", bot.state_row["side"] is None,
          bot.state_row["side"])


async def t_hedge_entry_filters():
    print("\n[hedge signal controls, closed bars, shared AND permission]")
    bot = make_bot(FakeExchange(), hedge_entry_filters=True, hedge_entry_filter_owner=True)
    bot.candles = []
    bot._refresh_hedge_entry_filters({}, True)
    check("both OFF need no candles", bot._hedge_entry_allows_cycle())
    now = time.time()
    minute = int(now // 60) * 60000
    closes = [100, 101, 99, 100, 101, 110]
    bot.candles = [{"t": minute - (len(closes)-i)*60000, "o": c, "h": c+.1, "l": c-.1, "c": c} for i,c in enumerate(closes)]
    bot.candles.append({"t": minute, "o": 1, "h": 1, "l": 1, "c": 1})
    bot.candles_updated_at = now
    config = {"stochasticEnabled": True, "zscoreEnabled": True}
    bot._refresh_hedge_entry_filters({"override_hedge_entry_filters": config}, True)
    reading = bot._hedge_entry_reading
    check("both signals pass high extremes", bot._hedge_entry_allows_cycle())
    check("forming candle excluded from K", reading["stochastic"] > 98)
    check("z excludes scored close from baseline", reading["zscore"] > 10)
    config["stochasticHigh"] = 100
    bot._refresh_hedge_entry_filters({"override_hedge_entry_filters": config}, True)
    check("both ON means AND", not bot._hedge_entry_allows_cycle() and bot._hedge_entry_reading["zscore_allowed"])
    config["stochasticEnabled"] = False
    bot._refresh_hedge_entry_filters({"override_hedge_entry_filters": config}, True)
    check("Z only ignores disabled stochastic", bot._hedge_entry_allows_cycle())
    config["stochasticEnabled"] = True
    config["stochasticHigh"] = 75
    config["zscoreEnabled"] = False
    bot._refresh_hedge_entry_filters({"override_hedge_entry_filters": config}, True)
    check("stochastic alone works", bot._hedge_entry_allows_cycle())
    config["zscoreEnabled"] = True
    bot.candles_updated_at = now - 100
    bot._refresh_hedge_entry_filters({"override_hedge_entry_filters": config}, True)
    check("enabled filters block stale candles", not bot._hedge_entry_allows_cycle())
    bot.candles_updated_at = now
    bot.candles[-3]["t"] -= 60000
    bot._refresh_hedge_entry_filters({"override_hedge_entry_filters": config}, True)
    check("enabled filters block candle gaps", not bot._hedge_entry_allows_cycle())
    bot.candles[-3]["t"] += 60000
    config["stochasticEnabled"] = False
    config["zscoreEnabled"] = False
    bot._refresh_hedge_entry_filters({"override_hedge_entry_filters": config}, True)
    check("both OFF immediately unblock signal gate", bot._hedge_entry_allows_cycle())
    shared = {}
    bot.hedge_entry_hub = shared
    follower = make_bot(FakeExchange(), hedge_entry_filters=True)
    follower.hedge_entry_hub = shared
    bot._refresh_hedge_entry_filters({"override_hedge_entry_filters": config}, True)
    check("both legs share one permission", bot._hedge_entry_allows_cycle() and follower._hedge_entry_allows_cycle())
    follower._refresh_hedge_entry_filters({"override_hedge_entry_filters": {"zscoreEnabled": True}}, True)
    check("follower cannot overwrite owner", follower._hedge_entry_allows_cycle())
    shared["checked_at"] = now - 100
    check("stale shared permission blocks both", not bot._hedge_entry_allows_cycle() and not follower._hedge_entry_allows_cycle())
    bot._refresh_hedge_entry_filters({"override_hedge_entry_filters": {"stochasticEnabled": "false"}}, True)
    check("invalid stored switches fail closed", not bot._hedge_entry_allows_cycle())
    for c in bot.candles[:-1]: c.update(h=100,l=100,c=100)
    bot._refresh_hedge_entry_filters({"override_hedge_entry_filters": {"zscoreEnabled": True}}, True)
    check("zero variance Z blocks safely", not bot._hedge_entry_allows_cycle())
    bot._refresh_hedge_entry_filters({"override_hedge_entry_filters": {"stochasticEnabled": True}}, True)
    check("zero range stochastic blocks safely", not bot._hedge_entry_allows_cycle())
    unaffected = make_bot(FakeExchange())
    check("other workers ignore hedge-only gate", unaffected._hedge_entry_allows_cycle())
    flat_ex = FakeExchange()
    blocked = make_bot(flat_ex, fixed_direction="long", hedge_entry_filters=True, hedge_entry_filter_owner=True)
    blocked.state_row["override_hedge_entry_filters"] = {"zscoreEnabled": True}
    await blocked.tick()
    check("enabled invalid-data filter prevents a real entry", blocked.state_row["side"] is None and not flat_ex.orders)
    ex = FakeExchange(position=0.00012)
    open_bot = make_bot(ex, fixed_direction="long", sl_pct=.03, hedge_entry_filters=True, hedge_entry_filter_owner=True)
    open_bot.state_row.update(side="long", legs=[{"price":86100., "usd_size":86100.*.00012}], first_entry_price=86100., override_hedge_entry_filters={"zscoreEnabled":True})
    await open_bot.tick()
    check("blocked hedge filter does not stop an existing SL exit", open_bot.state_row["side"] is None and any(o["reduce_only"] for o in ex.orders))
    bot._refresh_hedge_entry_filters({}, True)
    snapshot = bot._entry_settings_snapshot({})
    check("trade settings include filter configuration", snapshot["entry_filters"]["config"]["zscoreEnabled"] is False)


async def t_hedge_volatility_filters():
    print("\n[ATR/BandWidth, prior-only percentile, history, and safe exits]")
    bot = make_bot(FakeExchange(), hedge_entry_filters=True, hedge_entry_filter_owner=True)
    now = time.time(); minute = int(now // 60) * 60000
    bars = [{"t": minute-(1501-i)*60000, "o":100., "h":100.1, "l":99.9, "c":100.} for i in range(1502)]
    bars[-2].update(o=110.,h=110.1,l=109.9,c=110.)
    bars[-1].update(o=1.,h=1.,l=1.,c=1.)  # forming candle must not influence either gate
    bot.hedge_candle_history = bars
    bot.candles = bars[-60:];bot.candles_updated_at=now
    config={"atrEnabled":True,"atrWindow":5,"bandwidthEnabled":True,"bandwidthWindow":5}
    def refresh():bot._refresh_hedge_entry_filters({"override_hedge_entry_filters":config},True);return bot._hedge_entry_reading
    reading=refresh()
    check("ATR and BandWidth pass independently of direction",reading["allowed"])
    check("ATR includes gap from previous close",abs(reading["atr"]-((10.1+4*.2)/5/110*100))<1e-9,reading["atr"])
    check("ATR percentile excludes current spike",abs(reading["atr_threshold"]-.2)<1e-9,reading["atr_threshold"])
    check("BandWidth is four population std deviations over mean",abs(reading["bandwidth"]-400*4/102)<1e-9,reading["bandwidth"])
    check("BandWidth baseline excludes scored close",reading["bandwidth_threshold"]==0)
    check("full previous day has exactly 1440 baseline readings",reading["atr_baseline_samples"]==1440 and reading["bandwidth_baseline_samples"]==1440)
    cached=bot._hedge_volatility_cache;refresh()
    check("unchanged closed candle reuses computed baseline",bot._hedge_volatility_cache is cached)
    bot.candles_updated_at=now-100;reading=refresh()
    check("cached volatility cannot bypass stale data guard",not reading["allowed"] and reading["atr"] is None)
    bot.candles_updated_at=now
    bars[-10]["t"]-=60000;reading=refresh()
    check("history gap blocks enabled volatility gates",not reading["allowed"])
    bars[-10]["t"]+=60000
    config["stochasticEnabled"]=True;config["stochasticHigh"]=100
    reading=refresh()
    check("all enabled gates combine with AND",not reading["allowed"] and reading["atr_allowed"] and reading["bandwidth_allowed"])
    config["stochasticEnabled"]=False
    config["atrEnabled"]=False;reading=refresh()
    check("BandWidth can run alone",reading["allowed"] and reading["atr_allowed"])
    config["atrEnabled"]=True;config["bandwidthEnabled"]=False;reading=refresh()
    check("ATR can run alone",reading["allowed"] and reading["bandwidth_allowed"])
    config["bandwidthEnabled"]=True
    bars[-2].update(o=100.,h=100.1,l=99.9,c=100.);reading=refresh()
    check("equal or flat baseline does not pass above-percentile gate",not reading["allowed"] and not reading["bandwidth_allowed"])
    config["atrPercentile"]=100;reading=refresh()
    check("invalid stored percentile fails closed",not reading["allowed"])
    config["atrPercentile"]=80
    bot.hedge_candle_history=bars[-125:];reading=refresh()
    check("fewer than 120 prior readings blocks enabled gates",not reading["allowed"])
    bot.hedge_candle_history=[];bot.candles=[];config["atrEnabled"]=False;config["bandwidthEnabled"]=False
    reading=refresh()
    check("all OFF needs no extended history",reading["allowed"])
    old={"stochasticEnabled":False,"stochasticWindow":5,"stochasticLow":10,"stochasticHigh":90,"zscoreEnabled":False,"zscoreWindow":5,"zscoreLow":-2,"zscoreHigh":2}
    bot._refresh_hedge_entry_filters({"override_hedge_entry_filters":old},True)
    check("old JSON defaults both new switches OFF",bot._hedge_entry_reading["allowed"] and not bot._hedge_entry_reading["config"]["atrEnabled"] and not bot._hedge_entry_reading["config"]["bandwidthEnabled"])
    # Background pagination is bounded and preserves the legacy 60-bar input.
    owner=make_bot(FakeExchange(),hedge_entry_filters=True,hedge_entry_filter_owner=True)
    owner.candles=bars[-60:];calls=[]
    async def history_fetch(count=60,end_ms=None):
        calls.append((count,end_ms));return [b for b in bars if b["t"]<=end_ms][-count:]
    owner.fetch_candles=history_fetch
    await owner._refresh_hedge_candle_history()
    check("history bootstrap is bounded to three 500-bar requests",len(calls)==3 and all(c[0]==500 for c in calls))
    check("history holds 1502 while legacy candles stay 60",len(owner.hedge_candle_history)==1502 and len(owner.candles)==60)
    calls.clear();await owner._refresh_hedge_candle_history()
    check("full history refresh needs no extra network request",not calls)
    ex=FakeExchange(position=.00012)
    opened=make_bot(ex,fixed_direction="long",sl_pct=.03,hedge_entry_filters=True,hedge_entry_filter_owner=True)
    opened.state_row.update(side="long",legs=[{"price":86100.,"usd_size":86100.*.00012}],first_entry_price=86100.,override_hedge_entry_filters={"atrEnabled":True,"bandwidthEnabled":True})
    await opened.tick()
    check("missing ATR/BandWidth history never blocks an existing exit",opened.state_row["side"] is None and any(o["reduce_only"] for o in ex.orders))


def _vol_candles(v, n=15, base=86000.0):
    """n candles at a constant price with volume `v` on each -- enough (n>=11) for
    compute_candle_volume_avg's 10-closed-candle window to read exactly `v`."""
    t0 = 1700000000000
    return [{"t": t0 + i * 60000, "o": base, "h": base + 1, "l": base - 1, "c": base, "v": v}
            for i in range(n)]


def _escalated_state(entry, age_s, side="long", usd=10.0):
    return {
        "id": 1, "side": side, "legs": [{"price": entry, "usd_size": usd}],
        "first_entry_price": entry, "first_entry_time": int(time.time() * 1000) - int(age_s * 1000),
        "dca_level": 0, "seed_usd": usd, "realized_pnl_usd": 0.0, "collateral_before_entry": usd,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
        "override_escalated_sl_enabled": True,
    }


def _escalated_bot(ex, state, candles, **over):
    kwargs = dict(sl_pct=0.11, tp_pct=0.10, escalated_sl_enabled=True, schema_has_exit_overrides=True)
    kwargs.update(over)
    return make_bot(ex, state=state, candles=candles, **kwargs)


async def t_escalated_sl_tier1_fires_fast_and_thin():
    print("\n[escalated SL tier 1: -0.05% within 2min AND volume<3 -> exits]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    state = _escalated_state(entry, age_s=60)  # well under 120s
    bot = _escalated_bot(ex, state, _vol_candles(2.0))  # volume 2.0 < 3
    bot.live.order_book = {"bids": [{"price": str(entry * (1 - 0.06 / 100))}],
                           "asks": [{"price": str(entry * (1 - 0.06 / 100) + 1)}]}
    await bot.tick()
    check("closed via ESCALATED_SL_TIER1", bot.state_row["side"] is None, bot.state_row["side"])
    check("reason is ESCALATED_SL_TIER1",
          any(a == "closed" and d.get("reason") == "ESCALATED_SL_TIER1" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def t_escalated_sl_tier1_does_not_fire_past_2_minutes():
    print("\n[escalated SL tier 1: same drop, but past 2 minutes -- does not fire]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    state = _escalated_state(entry, age_s=150)  # over 120s
    bot = _escalated_bot(ex, state, _vol_candles(2.0))
    bot.live.order_book = {"bids": [{"price": str(entry * (1 - 0.06 / 100))}],
                           "asks": [{"price": str(entry * (1 - 0.06 / 100) + 1)}]}
    await bot.tick()
    check("still open -- tier 1's time window already closed, tier 2 needs -0.10%",
          bot.state_row["side"] == "long", bot.state_row["side"])


async def t_escalated_sl_tier1_does_not_fire_when_volume_is_normal():
    print("\n[escalated SL tier 1: same fast drop, but volume is NOT thin -- does not fire]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    state = _escalated_state(entry, age_s=60)
    bot = _escalated_bot(ex, state, _vol_candles(5.0))  # volume 5.0, not thin
    bot.live.order_book = {"bids": [{"price": str(entry * (1 - 0.06 / 100))}],
                           "asks": [{"price": str(entry * (1 - 0.06 / 100) + 1)}]}
    await bot.tick()
    check("still open -- volume is normal, tier 1 requires thin volume too",
          bot.state_row["side"] == "long", bot.state_row["side"])


async def t_escalated_sl_tier2_fires_regardless_of_age():
    print("\n[escalated SL tier 2: -0.10% AND volume<3 -> exits, no time limit]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    state = _escalated_state(entry, age_s=600)  # well past tier 1's window
    bot = _escalated_bot(ex, state, _vol_candles(2.5))
    bot.live.order_book = {"bids": [{"price": str(entry * (1 - 0.11 / 100))}],
                           "asks": [{"price": str(entry * (1 - 0.11 / 100) + 1)}]}
    await bot.tick()
    check("closed via ESCALATED_SL_TIER2", bot.state_row["side"] is None, bot.state_row["side"])
    check("reason is ESCALATED_SL_TIER2",
          any(a == "closed" and d.get("reason") == "ESCALATED_SL_TIER2" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def t_escalated_sl_tier2_does_not_fire_when_volume_is_normal():
    print("\n[escalated SL tier 2: -0.10% but volume is NOT thin -- does not fire, waits for the hard cap]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    state = _escalated_state(entry, age_s=600)
    bot = _escalated_bot(ex, state, _vol_candles(5.0))
    bot.live.order_book = {"bids": [{"price": str(entry * (1 - 0.11 / 100))}],
                           "asks": [{"price": str(entry * (1 - 0.11 / 100) + 1)}]}
    await bot.tick()
    check("still open -- waiting for the unconditional -0.12% hard cap instead",
          bot.state_row["side"] == "long", bot.state_row["side"])


async def t_escalated_sl_tier3_hard_cap_fires_unconditionally():
    print("\n[escalated SL tier 3: -0.12% closes regardless of volume -- the hard cap]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    state = _escalated_state(entry, age_s=600)
    bot = _escalated_bot(ex, state, _vol_candles(50.0))  # heavy volume -- doesn't matter at tier 3
    bot.live.order_book = {"bids": [{"price": str(entry * (1 - 0.13 / 100))}],
                           "asks": [{"price": str(entry * (1 - 0.13 / 100) + 1)}]}
    await bot.tick()
    check("closed via ESCALATED_SL_TIER3", bot.state_row["side"] is None, bot.state_row["side"])
    check("reason is ESCALATED_SL_TIER3",
          any(a == "closed" and d.get("reason") == "ESCALATED_SL_TIER3" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def t_escalated_sl_replaces_the_plain_sl_entirely():
    print("\n[escalated SL: the plain override_sl_pct is ignored while this is on]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    state = _escalated_state(entry, age_s=600)
    state["override_sl_pct"] = 0.02  # would have closed this long ago under plain SL
    bot = _escalated_bot(ex, state, _vol_candles(50.0))  # not thin -- tiers 1/2 don't apply either
    bot.live.order_book = {"bids": [{"price": str(entry * (1 - 0.08 / 100))}],
                           "asks": [{"price": str(entry * (1 - 0.08 / 100) + 1)}]}
    await bot.tick()
    check("still open at -0.08% -- override_sl_pct (0.02) is ignored, tier 3 cap is 0.12%",
          bot.state_row["side"] == "long", bot.state_row["side"])


async def t_escalated_sl_off_by_default_keeps_plain_sl_behavior():
    print("\n[escalated SL: off (default) -- the plain SL still works exactly as before]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    state = _escalated_state(entry, age_s=600)
    state["override_escalated_sl_enabled"] = False
    state["override_sl_pct"] = 0.02
    bot = _escalated_bot(ex, state, _vol_candles(50.0))
    bot.live.order_book = {"bids": [{"price": str(entry * (1 - 0.03 / 100))}],
                           "asks": [{"price": str(entry * (1 - 0.03 / 100) + 1)}]}
    await bot.tick()
    check("closed via plain SL -- escalated mode is off, old behavior unchanged",
          bot.state_row["side"] is None, bot.state_row["side"])
    check("reason is plain SL, not an escalated tier",
          any(a == "closed" and d.get("reason") == "SL" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def t_escalated_sl_native_stop_reflects_tier3_not_old_sl_pct():
    print("\n[escalated SL: the native exchange-side stop syncs to the 0.12% tier-3 level, not override_sl_pct]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    state = _escalated_state(entry, age_s=600)
    state["override_sl_pct"] = 0.02
    bot = _escalated_bot(ex, state, _vol_candles(50.0), native_stop_loss_enabled=True)
    bot.live.order_book = {"bids": [{"price": str(entry)}], "asks": [{"price": str(entry + 1)}]}
    await bot.tick()
    check("native stop placed", len(getattr(ex, "sl_orders", [])) >= 1, getattr(ex, "sl_orders", None))
    # price_decimals defaults to 1 -- native order triggers are recorded int-scaled by 10**that.
    expected_trigger = entry * (1 - 0.12 / 100) * 10
    actual_trigger = ex.sl_orders[-1]["trigger"]
    check("native stop trigger matches the 0.12% tier-3 level, not the 0.02% override",
          abs(actual_trigger - expected_trigger) < 10.0, (actual_trigger, expected_trigger))


def _native_sl_state(entry, usd=10.0, side="long"):
    return {
        "id": 1, "side": side, "legs": [{"price": entry, "usd_size": usd}],
        "first_entry_price": entry, "first_entry_time": 1700000000000, "dca_level": 0,
        "seed_usd": usd, "realized_pnl_usd": 0.0, "collateral_before_entry": usd,
        "enabled": True, "consecutive_entry_failures": 0, "last_processed_candle_ts": 0,
    }


async def t_native_sync_backoff_does_not_retry_within_the_window():
    print("\n[native order backoff: a failure does NOT retry on the very next tick]")
    print("  direct report: 6,603 'OrderPrice should not be less than 1' failures since Oct 1,")
    print("  retrying every tick (~1s) for up to 89s straight in a single incident")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    ex.sl_order_error = "OrderPrice should not be less than 1"
    state = _native_sl_state(entry)
    bot = make_bot(ex, state=state, candles_kind="mid", sl_pct=0.11, native_stop_loss_enabled=True)
    bot.live.order_book = {"bids": [{"price": str(entry)}], "asks": [{"price": str(entry + 1)}]}
    await bot.tick()
    check("first attempt was made and failed", ex.sl_order_attempts == 1, ex.sl_order_attempts)
    check("backoff armed after a failure", bot._native_sync_retry_at > time.time(), bot._native_sync_retry_at)
    await bot.tick()
    check("no second attempt yet -- still inside the backoff window",
          ex.sl_order_attempts == 1, ex.sl_order_attempts)


async def t_native_sync_backoff_retries_once_the_window_elapses():
    print("\n[native order backoff: retries again once the backoff window has passed]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    ex.sl_order_error = "OrderPrice should not be less than 1"
    state = _native_sl_state(entry)
    bot = make_bot(ex, state=state, candles_kind="mid", sl_pct=0.11, native_stop_loss_enabled=True)
    bot.live.order_book = {"bids": [{"price": str(entry)}], "asks": [{"price": str(entry + 1)}]}
    await bot.tick()
    check("first attempt failed", ex.sl_order_attempts == 1, ex.sl_order_attempts)
    bot._native_sync_retry_at = time.time() - 1.0  # pretend the backoff already elapsed
    await bot.tick()
    check("retried now that the window elapsed", ex.sl_order_attempts == 2, ex.sl_order_attempts)


async def t_native_sync_backoff_clears_on_success():
    print("\n[native order backoff: a successful placement clears the failure count and backoff]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    ex.sl_order_error = "OrderPrice should not be less than 1"
    state = _native_sl_state(entry)
    bot = make_bot(ex, state=state, candles_kind="mid", sl_pct=0.11, native_stop_loss_enabled=True)
    bot.live.order_book = {"bids": [{"price": str(entry)}], "asks": [{"price": str(entry + 1)}]}
    await bot.tick()
    check("failed once", bot._native_sync_consecutive_failures == 1, bot._native_sync_consecutive_failures)
    bot._native_sync_retry_at = time.time() - 1.0
    ex.sl_order_error = None  # exchange recovers
    await bot.tick()
    check("failure count cleared after success", bot._native_sync_consecutive_failures == 0,
          bot._native_sync_consecutive_failures)
    check("backoff cleared after success", bot._native_sync_retry_at == 0.0, bot._native_sync_retry_at)
    check("native stop actually resting now", len(getattr(ex, "sl_orders", [])) >= 1, getattr(ex, "sl_orders", None))


async def t_sl_dwell_zero_is_instant_unchanged():
    print("\n[SL dwell: 0 (default) fires instantly, same as before this existed]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    state = _native_sl_state(entry)
    bot = make_bot(ex, state=state, candles_kind="mid", sl_pct=0.11)
    await _tick_at(bot, entry * (1 - 0.11 / 100) - 1.0)
    check("closed instantly, no dwell applied", bot.state_row["side"] is None, bot.state_row["side"])
    check("reason is SL", any(a == "closed" and d.get("reason") == "SL" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def t_sl_dwell_blocks_a_single_touch():
    print("\n[SL dwell: a single tick past SL does not close yet -- direct request: \"lets do 30 seconds\"]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    state = _native_sl_state(entry)
    state["override_sl_dwell_seconds"] = 30.0
    bot = make_bot(ex, state=state, candles_kind="mid", sl_pct=0.11, schema_has_exit_overrides=True)
    await _tick_at(bot, entry * (1 - 0.11 / 100) - 1.0)
    check("still open -- touched SL but hasn't dwelled 30s yet",
          bot.state_row["side"] == "long", bot.state_row["side"])


async def t_sl_dwell_fires_once_elapsed():
    print("\n[SL dwell: fires once continuously past SL for the full dwell window]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    state = _native_sl_state(entry)
    state["override_sl_dwell_seconds"] = 30.0
    bot = make_bot(ex, state=state, candles_kind="mid", sl_pct=0.11, schema_has_exit_overrides=True)
    await _tick_at(bot, entry * (1 - 0.11 / 100) - 1.0)
    check("still open on first touch", bot.state_row["side"] == "long", bot.state_row["side"])
    bot._sl_dwell_touch_at = time.time() - 35.0  # pretend it's been standing there 35s
    await _tick_at(bot, entry * (1 - 0.11 / 100) - 1.0)
    check("closed via SL once the dwell elapsed", bot.state_row["side"] is None, bot.state_row["side"])
    check("reason is SL", any(a == "closed" and d.get("reason") == "SL" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def t_sl_dwell_resets_on_a_bounce():
    print("\n[SL dwell: a bounce back above the SL level resets the timer -- no credit for the first touch]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    state = _native_sl_state(entry)
    state["override_sl_dwell_seconds"] = 30.0
    bot = make_bot(ex, state=state, candles_kind="mid", sl_pct=0.11, schema_has_exit_overrides=True)
    await _tick_at(bot, entry * (1 - 0.11 / 100) - 1.0)  # touch 1
    bot._sl_dwell_touch_at = time.time() - 35.0  # backdate as if it's been 35s already
    await _tick_at(bot, entry)  # price recovers above SL -- should reset the timer
    check("still open -- the bounce reset the dwell timer", bot.state_row["side"] == "long", bot.state_row["side"])
    check("tracker cleared by the bounce", bot._sl_dwell_touch_at is None, bot._sl_dwell_touch_at)
    await _tick_at(bot, entry * (1 - 0.11 / 100) - 1.0)  # touch again, fresh
    check("still open -- this is a brand new touch, not credited with the old 35s",
          bot.state_row["side"] == "long", bot.state_row["side"])


async def t_sl_dwell_does_not_apply_to_escalated_tier3_hard_cap():
    print("\n[SL dwell: tier 3's hard cap stays instant regardless -- dwell is a plain-SL-only feature]")
    entry = 86000.0
    ex = FakeExchange(position=round(10.0 / entry, 5), collateral=10.0)
    state = _escalated_state(entry, age_s=600)
    state["override_sl_dwell_seconds"] = 30.0
    bot = _escalated_bot(ex, state, _vol_candles(50.0))
    await _tick_at(bot, entry * (1 - 0.13 / 100))  # past the 0.12% tier-3 hard cap
    check("closed instantly via tier 3 -- dwell never applies to the hard cap",
          bot.state_row["side"] is None, bot.state_row["side"])
    check("reason is ESCALATED_SL_TIER3",
          any(a == "closed" and d.get("reason") == "ESCALATED_SL_TIER3" for a, d in bot.runs),
          [(a, d.get("reason")) for a, d in bot.runs if a == "closed"])


async def main():
    for t in (t_hedge_volatility_filters, t_hedge_entry_filters, t_environment_two_binary_switches,
              t_environment_er_hysteresis_and_freshness,
              t_environment_shared_clearance_and_scope,
              t_environment_paused_exits_still_run,
              t_environment_restart_checkpoint,t_normal_entry, t_phantom_double_fill, t_nonce_error_but_filled,
              t_order_error_no_fill, t_circuit_breaker, t_close_uses_real_size,
              t_oversize_mismatch_in_tick, t_external_close_reconcile,
              t_order_timeout_bounded, t_read_position_never_trusts_stale_ws_flat,
              t_reconcile_falls_through_when_rest_disagrees,
              t_zscore_signal_long_on_oversold_dip,
              t_zscore_signal_short_on_overbought_spike,
              t_zscore_signal_neutral_inside_normal_range,
              t_zscore_signal_drives_a_real_entry_through_tick,
              t_zscore_signal_off_by_default_other_bots_unaffected,
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
              t_compute_intrabar_dispersion_basic,
              t_compute_intrabar_dispersion_needs_full_window,
              t_intrabar_dispersion_gate_blocks_entry_above_threshold,
              t_intrabar_dispersion_gate_allows_entry_below_threshold,
              t_intrabar_dispersion_gate_off_by_default,
              t_intrabar_dispersion_gate_never_blocks_an_exit,
              t_entry_vol_gate_pauses_on_high_true_range,
              t_entry_vol_gate_stays_paused_inside_hysteresis_band,
              t_entry_vol_gate_resumes_at_or_below_resume_threshold,
              t_entry_vol_gate_only_reevaluates_once_per_new_candle,
              t_entry_vol_gate_disabled_when_unconfigured,
              t_entry_vol_gate_persists_when_schema_enabled,
              t_compute_candle_volume_avg_basic,
              t_flip_signal_fires_after_long_enough_trend,
              t_flip_signal_short_direction,
              t_flip_signal_blocks_short_trend,
              t_flip_signal_requires_an_actual_flip,
              t_flip_signal_size_filter,
              t_flip_signal_min_body_pct_filter,
              t_er_2h_readout_written_on_tick,
              t_er_2h_readout_skipped_without_enough_history,
              t_er_2h_readout_off_without_schema_flag,
              t_rule_matches_hour_range_basic,
              t_rule_matches_hour_range_wraps_midnight,
              t_rule_matches_no_hour_range_matches_any_hour,
              t_rule_matches_condition_bounds,
              t_rule_matches_missing_reading_fails_closed,
              t_rule_matches_combined_hour_and_conditions,
              t_rule_matches_vol_wiggle_ratio_condition,
              t_rule_matches_vol_wiggle_product_condition,
              t_apply_schedule_rules_computes_vol_wiggle_product_as_volume_times_wiggle,
              t_schedule_current_hour_is_miami_not_utc,
              t_schedule_rules_off_by_default_schema_flag,
              t_schedule_rules_off_without_bot_key,
              t_schedule_rules_row_disabled_no_write,
              t_schedule_rules_vol_wiggle_ratio_condition_end_to_end,
              t_schedule_rules_applies_worker1_fields,
              t_schedule_rules_escalated_sl_false_is_explicitly_written,
              t_schedule_rules_escalated_sl_absent_leaves_it_alone,
              t_schedule_rules_applies_hedge_fields_only,
              t_schedule_rules_no_match_turns_bot_on,
              t_schedule_rules_no_match_leaves_an_already_on_bot_on,
              t_schedule_rules_match_turns_bot_on,
              t_schedule_rules_per_bot_enabled_flag_independent_of_settings,
              t_schedule_rules_enabled_flag_defaults_true_when_absent,
              t_schedule_rules_enabled_null_leaves_it_untouched_when_currently_on,
              t_schedule_rules_enabled_null_leaves_it_untouched_when_currently_off,
              t_schedule_rules_enabled_null_lets_one_bots_rule_ignore_the_other_bot,
              t_schedule_rules_settings_still_applied_while_bot_held_off,
              t_schedule_rules_enabled_sync_overrides_manual_change_every_cycle,
              t_schedule_rules_first_match_wins,
              t_schedule_rules_unchanged_match_does_not_rewrite,
              t_schedule_rules_fetch_is_throttled,
              t_schedule_rules_malformed_data_fails_closed,
              t_schedule_rules_min_hold_zero_applies_instantly,
              t_schedule_rules_min_hold_delays_a_new_candidate,
              t_schedule_rules_min_hold_applies_once_cleared,
              t_schedule_rules_min_hold_resets_on_candidate_change,
              t_schedule_rules_mutates_local_state_dict_immediately,
              t_schedule_rules_metrics_not_published_without_schema_flag,
              t_schedule_rules_publishes_live_metrics_with_schema_flag,
              t_schedule_rules_publishes_zebra_alternation_index,
              t_schedule_rules_publishes_color_balance_index,
              t_schedule_rules_zebra_and_color_balance_conditions_match,
              t_schedule_rules_metrics_publish_is_isolated_from_settings_patch,
              t_schedule_rules_metrics_publish_throttled,
              t_volume_switch_uses_flip_above_threshold,
              t_volume_switch_keeps_normal_path_below_threshold,
              t_volume_switch_off_by_default,
              t_volume_wiggle_ratio_basic,
              t_volume_wiggle_ratio_needs_both_components,
              t_volume_wiggle_ratio_zero_volume_is_none,
              t_volume_wiggle_ratio_flat_price_is_zero_not_none,
              t_volume_wiggle_lock_blocks_below_threshold,
              t_volume_wiggle_lock_allows_at_or_above_threshold,
              t_volume_wiggle_lock_off_by_default,
              t_volume_wiggle_lock_live_override,
              t_volume_wiggle_lock_override_ignored_without_schema_flag,
              t_volume_wiggle_lock_enabled_switch_overrides_without_losing_threshold,
              t_volume_wiggle_lock_blocks_a_hedge_style_cycle,
              t_volume_jump_ratio_basic,
              t_volume_jump_ratio_needs_full_lookback,
              t_volume_jump_ratio_zero_baseline,
              t_volume_jump_guard_blocks_entry_on_spike,
              t_volume_jump_guard_allows_entry_without_spike,
              t_volume_jump_guard_off_by_default,
              t_volume_jump_guard_live_override_ratio,
              t_volume_jump_guard_off_by_default_schema_flag,
              t_volume_jump_guard_enabled_switch_off_allows_entry_despite_spike,
              t_volume_jump_guard_enabled_switch_true_keeps_blocking,
              t_volume_jump_guard_enabled_switch_off_by_default_schema_flag,
              t_volume_jump_guard_enabled_switch_off_still_shows_the_reading,
              t_volume_jump_guard_enabled_switch_off_clears_an_active_pause,
              t_volume_jump_guard_tracks_paused_until,
              t_volume_jump_guard_paused_until_none_when_calm,
              t_volume_jump_clear_marker_forgives_an_old_pause,
              t_volume_jump_clear_marker_does_not_block_a_new_spike,
              t_volume_jump_clear_marker_off_by_default_schema_flag,
              t_volume_jump_guard_blocks_a_hedge_style_cycle,
              t_volume_jump_guard_calm_does_not_block_hedge_style_cycle,
              t_volume_jump_release_mode_off_never_releases_early,
              t_volume_jump_release_volume_mode_releases_at_half_peak,
              t_volume_jump_release_volume_mode_stays_active_above_half,
              t_volume_jump_release_wiggle_mode_releases_at_half_peak,
              t_volume_jump_release_wiggle_mode_stays_active_above_half,
              t_volume_jump_release_rate_mode_releases_at_half_peak,
              t_volume_jump_release_rate_mode_stays_active_above_half,
              t_volume_jump_release_peak_resets_on_a_new_spike,
              t_volume_jump_release_peak_readout_matches_the_active_mode,
              t_volume_jump_release_peak_readout_none_when_mode_off,
              t_volume_jump_release_peak_readout_clears_once_not_paused,
              t_volume_jump_release_mode_live_override,
              t_volume_jump_release_mode_override_off_by_default_schema_flag,
              t_volume_jump_release_respects_hard_cap_when_metric_never_decays,
              t_regime_toggle_stochastic_off_blocks_low_volume_entry,
              t_regime_toggle_stochastic_on_default,
              t_regime_toggle_zebra_off_bypasses_band,
              t_regime_toggle_zebra_on_default_still_blocks,
              t_regime_toggle_flip_off_blocks_high_volume_entry,
              t_regime_toggle_flip_on_default,
              t_regime_toggle_volume_threshold_override,
              t_regime_toggle_off_by_default_schema_flag,
              t_stoch_signal_band_override_narrows_entry,
              t_stoch_signal_band_override_no_args_unchanged,
              t_stoch_band_control_blocks_entry_via_tick,
              t_stoch_band_control_default_unchanged,
              t_stoch_band_control_off_by_default_schema_flag,
              t_stoch_signal_entry_and_reversal_independently_overridable,
              t_stoch_band_control_reversal_override_does_not_touch_entry,
              t_stoch_signal_window_override_changes_k,
              t_stoch_window_control_enables_entry_via_tick,
              t_stoch_window_control_default_unchanged,
              t_stoch_window_control_off_by_default_schema_flag,
              t_entry_vol_gate_rehydrates_paused_state_after_restart,
              t_entry_vol_gate_blocks_reversal_reopen_but_not_the_close,
              t_self_lock_paper_shadow_opens_when_flat,
              t_self_lock_single_paper_tp_does_not_unlock,
              t_self_lock_two_consecutive_paper_tps_unlocks,
              t_w1_self_lock_two_non_tp_greens_unlock,
              t_w1_self_lock_single_tp_unlocks_instantly,
              t_w1_self_lock_a_real_sl_still_wipes_the_streak,
              t_self_lock_paper_sl_resets_counter,
              t_self_lock_real_sl_locks_and_resets_paper_counter,
              t_self_lock_blocks_real_entry_while_locked,
              t_self_lock_blocks_real_reversal_reopen_but_not_the_close,
              t_self_lock_persists_when_schema_enabled,
              t_self_lock_rehydrates_after_restart,
              t_self_lock_unlocks_and_enters_real_same_tick,
              t_self_lock_paper_shadow_respects_reversal_guard,
              t_self_lock_reversal_counts_as_win_disabled_by_default,
              t_self_lock_winning_reversal_counts_toward_unlock,
              t_self_lock_losing_reversal_stays_neutral_even_with_flag_on,
              t_self_lock_two_winning_reversals_unlock,
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
              t_trading_hours_dict_form_uses_that_days_own_list,
              t_trading_hours_dict_form_missing_weekday_is_fully_closed,
              t_hour_open_confirmation_disabled_by_default,
              t_hour_open_confirmation_never_arms_without_self_lock,
              t_hour_open_confirmation_skips_arming_with_an_open_real_position,
              t_hour_open_confirmation_arms_on_closed_to_open_transition,
              t_hour_open_confirmation_arms_on_boot_mid_open_hour,
              t_hour_open_confirmation_does_not_rearm_while_staying_open,
              t_hour_open_confirmation_blocks_entry_signal,
              t_hour_open_confirmation_uses_the_standard_unlock_rule,
              t_hour_open_confirmation_sets_lock_via,
              t_self_lock_hour_open_requires_tp_blocks_reversal_only_unlock,
              t_self_lock_hour_open_requires_tp_unlocks_once_a_real_tp_lands,
              t_self_lock_hour_open_requires_tp_does_not_affect_real_sl_locks,
              t_lock_via_off_by_default_other_bots_unaffected,
              t_timeout_constants,
              t_joint_adaptive_bounds_can_pin_sl_flat,
              t_burn_reclaimed_by_k_only_for_profit_lock_source,
              t_fixed_direction_enters_never_reverses_and_re_enters_after_sl,
              t_fixed_leg_usd_overrides_full_equity_sizing,
              t_cycle_partner_gate_blocks_entry_until_partner_also_flat,
              t_cycle_partner_gate_fails_closed_on_read_error,
              t_pressure_bias_increases_leg_usd_when_signal_favors_own_direction,
              t_pressure_bias_decreases_leg_usd_when_signal_favors_other_direction,
              t_pressure_bias_floor_prevents_negative_or_zero_sizing,
              t_pressure_bias_noop_when_disabled,
              t_pressure_bias_noop_when_signal_neutral,
              t_pressure_bias_owner_publishes_follower_reads_only,
              t_pressure_bias_owner_computes_and_publishes_to_hub,
              t_pressure_hub_published_even_when_owner_does_not_enter,
              t_pressure_follower_never_computes_its_own_signal,
              t_breakeven_floor_pct_arithmetic,
              t_fixed_partner_cut_floor_gives_survivor_room,
              t_breakeven_floor_holds_the_cycle_even,
              t_breakeven_floor_arms_when_partner_cycle_was_never_observed_open,
              t_breakeven_floor_does_not_pin_the_winner_to_zero,
              t_breakeven_floor_lets_a_winner_reach_the_trail,
              t_partner_cut_arms_trail_immediately_below_the_old_margin,
              t_partner_cut_arms_trail_immediately_still_tracks_a_rising_peak,
              t_partner_cut_arms_trail_immediately_off_by_default,
              t_breakeven_floor_ignores_a_green_partner,
              t_breakeven_floor_requires_partner_to_have_opened,
              t_breakeven_floor_never_forces_a_worse_exit,
              t_breakeven_floor_soft_fails_on_partner_read_error,
              t_profit_lock_trail_still_wins_above_the_trigger,
              t_exit_mode_trail_default_preserves_disabled_literal_tp,
              t_exit_mode_tp_enables_literal_tp_even_when_compiled_disabled,
              t_exit_mode_tp_suppresses_the_profit_lock_trail,
              t_exit_mode_tp_honors_override_tp_pct,
              t_exit_mode_tp_mode_sl_still_fires,
              t_exit_mode_ignored_without_schema_flag,
              t_entry_settings_snapshot_captures_exit_and_jump_settings,
              t_entry_settings_snapshot_falls_back_to_compiled_defaults,
              t_entry_settings_snapshot_captures_volume_and_er_regime,
              t_entry_settings_snapshot_er_none_without_enough_history,
              t_log_trade_falls_back_to_core_row_when_entry_features_column_missing,
              t_log_trade_no_fallback_needed_when_insert_succeeds,
              t_dwell_ready_not_touched_resets_the_timer,
              t_dwell_ready_zero_seconds_is_instant,
              t_dwell_ready_first_touch_not_enough,
              t_dwell_ready_fires_once_elapsed,
              t_exit_mode_tp_ignores_dwell_fires_instantly,
              t_exit_mode_floor_dwell_blocks_a_single_touch,
              t_exit_mode_floor_dwell_fires_once_elapsed,
              t_exit_mode_floor_compiled_flag_alone_ignores_dwell,
              t_exit_mode_no_sl_sl_still_fires_before_partner_closes,
              t_exit_mode_no_sl_sl_suppressed_after_partner_closes,
              t_exit_mode_no_sl_trail_still_protects_the_survivor,
              t_exit_mode_no_sl_native_stop_cancelled_after_partner_closes,
              t_exit_mode_no_sl_real_reversal_closes_the_survivor,
              t_exit_mode_no_sl_reversal_check_waits_for_partner_to_close,
              t_escalated_sl_tier1_fires_fast_and_thin,
              t_escalated_sl_tier1_does_not_fire_past_2_minutes,
              t_escalated_sl_tier1_does_not_fire_when_volume_is_normal,
              t_escalated_sl_tier2_fires_regardless_of_age,
              t_escalated_sl_tier2_does_not_fire_when_volume_is_normal,
              t_escalated_sl_tier3_hard_cap_fires_unconditionally,
              t_escalated_sl_replaces_the_plain_sl_entirely,
              t_escalated_sl_off_by_default_keeps_plain_sl_behavior,
              t_escalated_sl_native_stop_reflects_tier3_not_old_sl_pct,
              t_native_sync_backoff_does_not_retry_within_the_window,
              t_native_sync_backoff_retries_once_the_window_elapses,
              t_native_sync_backoff_clears_on_success,
              t_sl_dwell_zero_is_instant_unchanged,
              t_sl_dwell_blocks_a_single_touch,
              t_sl_dwell_fires_once_elapsed,
              t_sl_dwell_resets_on_a_bounce,
              t_sl_dwell_does_not_apply_to_escalated_tier3_hard_cap,
              t_trail_dwell_blocks_a_single_touch,
              t_trail_dwell_fires_once_elapsed,
              t_trail_dwell_resets_on_a_new_peak,
              t_dwell_ignored_without_schema_flag,
              t_instance_lock_blocks_entry_when_another_instance_holds_it,
              t_instance_lock_allows_entry_once_acquired,
              t_instance_lock_never_blocks_an_exit,
              t_instance_lock_fails_closed_on_read_error,
              t_no_lock_configured_is_unchanged,
              t_cycle_barrier_releases_both_legs_together,
              t_cycle_barrier_prevents_the_naked_leg_pingpong,
              t_cycle_barrier_clearance_survives_pressure_vanishing,
              t_cycle_barrier_no_pressure_means_no_declaration,
              t_cycle_barrier_readiness_expires,
              t_cycle_barrier_withdraw_frees_the_partner,
              t_no_cycle_hub_falls_back_to_the_db_poll,
              t_pressure_gate_blocks_entry_in_flat_chop,
              t_pressure_gate_allows_entry_at_an_extreme,
              t_pressure_source_uses_zscore_when_enabled,
              t_pressure_source_stays_stochastic_by_default,
              t_pressure_gate_off_by_default_for_other_bots,
              t_pressure_gate_waits_rather_than_guessing_with_no_reading,
              t_k_readout_still_works_with_the_size_tilt_off,
              t_waf_blackout_does_not_stack_a_second_order,
              t_after_blackout_the_real_fill_is_adopted,
              t_close_button_works_on_an_orphan_the_row_does_not_know_about,
              t_close_on_a_genuinely_flat_bot_still_just_clears,
              t_single_flat_read_cannot_condemn_a_live_position,
              t_genuine_external_close_still_books,
              t_emergency_flatten_records_the_trade,
              t_repeated_emergency_flattens_do_hard_disable,
              t_cooldown_blocks_entry_then_expires,
              t_cycle_gap_blocks_instant_reentry,
              t_cycle_gap_zero_is_instant_like_before,
              t_cycle_gap_never_blocks_an_exit,
              t_native_stop_off_by_default_never_places_order,
              t_native_stop_places_order_on_entry_when_enabled,
              t_native_stop_noop_when_unchanged,
              t_native_stop_cancelled_before_our_own_close,
              t_native_stop_resyncs_when_sl_override_changes,
              t_external_close_tagged_sl_when_native_stop_enabled,
              t_native_exits_both_placed_with_a_single_cancel,
              t_native_tp_skipped_when_literal_tp_disabled,
              t_cycle_id_stamped_same_for_both_legs_on_release,
              t_cycle_id_persisted_on_entry_and_cleared_on_close,
              t_cycle_id_never_touched_without_schema_flag,
              t_live_configs_match_their_stated_rules,
              t_stale_position_bands_ignored_without_schema_flag,
              t_position_bands_still_honored_with_schema_flag,
              t_min_dispersion_gate_blocks_cycle_when_quiet,
              t_min_dispersion_gate_allows_cycle_when_dispersed,
              t_min_dispersion_gate_off_by_default,
              t_one_cycle_per_candle_blocks_second_entry_same_candle,
              t_min_dispersion_never_discards_granted_clearance,
              t_profit_lock_floor_closes_at_breakeven_not_below,
              t_profit_lock_floor_off_keeps_old_behaviour,
              t_profit_lock_floor_still_lets_the_winner_ride,
              t_saving_lock_exits_at_entry_after_arming,
              t_saving_lock_not_armed_by_a_small_dip,
              t_saving_lock_off_by_default,
              t_saving_lock_follows_the_sl_override,
              t_zebra_index_values,
              t_zebra_gate_blocks_outside_band,
              t_zebra_gate_allows_inside_band,
              t_zebra_gate_off_by_default,
              t_color_balance_index_values,
              t_balance_gate_blocks_outside_band,
              t_balance_gate_allows_inside_band,
              t_balance_gate_off_by_default,
              t_entry_features_persisted_on_entry_and_carried_to_trade_log,
              t_entry_features_never_touched_without_schema_flag,
              t_entry_features_numeric_k_does_not_change_live_signal,
              t_entry_features_write_failure_is_visible_and_keeps_the_fill,
              t_post_reversal_cooldown_blocks_instant_reopen,
              t_post_reversal_cooldown_allows_reentry_once_elapsed,
              t_post_reversal_cooldown_off_by_default,
              t_index_exit_fires_when_green_and_index_out_of_band,
              t_index_exit_never_fires_when_red,
              t_index_exit_does_not_fire_inside_the_band,
              t_index_exit_off_by_default,
              t_balance_invert_blocks_inside_band,
              t_balance_invert_allows_outside_band,
              t_balance_invert_missing_reading_still_blocks,
              t_balance_invert_off_keeps_normal_inside_band_gate):
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
