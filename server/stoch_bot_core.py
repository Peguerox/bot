"""
Shared core for the three real-money Lighter BTC stochastic bots.

The three workers used to be three near-identical ~560-line copies, which is how a fix
landed on Worker 2 and silently missed Workers 1 and 3 more than once. Everything that is
not a setting now lives here exactly once; the per-worker files are config + entrypoint.

Hardening pass 2026-09-21 (after a 32-minute silent freeze on Workers 1 and 2):

* **Every network call has a timeout.** The Lighter SDK defaults to `_request_timeout or
  5 * 60` (lighter/rest.py) -- 300 seconds per REST call, which the bots never overrode.
  A single `confirm_fill()` (4 tries) could therefore block for 20 minutes with no log
  output at all, which is exactly what the observed freeze looked like: process alive,
  Render reporting "live", zero activity, SL never firing.
* **Order responses are never trusted.** A request that times out client-side can still
  succeed on the exchange, and the SDK's nonce manager then hard-refreshes and reports
  `invalid nonce` on the *next* call -- so an order that really filled gets recorded as a
  failure and re-sent. That is the mechanism behind the phantom 2x positions. Every order
  is now followed by an authoritative REST read of the real position, whatever the
  response said.
* **Fill confirmation is size-aware**, and an oversized position triggers an immediate
  flatten + disable rather than being quietly adopted.
* **Closes close what is really open**, read fresh from REST, not the tracked legs.
* **No blocking I/O on the event loop, and no thread pool either.** Supabase and candle
  fetches used urllib, which froze the WS task for the duration of every DB call. Moving
  them to `asyncio.to_thread` made it worse: urllib's `timeout=` does not cover DNS, so a
  wedged lookup pins a worker thread forever, and once the small default pool is exhausted
  every later call -- including the watchdog's own error log -- queues behind it and the
  process goes completely silent. Both now use aiohttp, whose ClientTimeout is enforced by
  the event loop and covers the whole request including name resolution.
* **Watchdogs**: a stale order book forces a WS reconnect, and any tick exceeding
  TICK_WATCHDOG is cancelled and logged instead of hanging forever.
* **stdout is line-buffered and every log is mirrored to it.** Python block-buffers stdout
  when it is not a TTY, so on Render every print() sat in a buffer that never flushed --
  which is why the service appeared to emit no runtime logs at all and every hang had to be
  diagnosed blind.
"""
import asyncio
import contextlib
import os
import sys
import time
import json as jsonlib
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

import aiohttp
import lighter

# ── Network safety budget ───────────────────────────────────────────────────────────────────
# Worst-case pathological tick is bounded by these: reconcile confirm (~17s) + close (~61s)
# + re-entry (~61s) ~= 139s, comfortably under TICK_WATCHDOG (see confirm_fill()'s docstring
# for how tries/delay were chosen -- there's a real tradeoff here between speed and this
# margin, not just a free win). A normal tick is ~0.5s.
REST_TIMEOUT = 8.0        # per Lighter REST read (SDK default would be 300s)
ORDER_TIMEOUT = 12.0      # per order placement / cancel-all
SB_TIMEOUT = 10.0         # per Supabase call
TICK_WATCHDOG = 180.0     # hard ceiling on one tick before it is cancelled
WS_RECONNECT_AFTER = 45.0 # order book silence that forces a WS reconnect
HEARTBEAT_EVERY = 300.0   # liveness row, so "is it stuck?" is a single query
POSITION_TTL = 3.0        # cache the REST position read this long (~0.33 req/s, vs the
                          # 6 req/s polling that caused the original rate-limit storm)
AUTH_TOKEN_LIFETIME_S = 10 * 60  # SDK's create_auth_token_with_expiry default validity
AUTH_TOKEN_REFRESH_MARGIN_S = 60.0  # regenerate this long before actual expiry
TICK_LOG_EVERY = 2.5      # seconds between price-tick log rows (candle-vs-real-trade check
                          # on 2026-09-22 showed 1-min candles are too coarse to backtest
                          # against; this records the real book for a proper replay later)
TICK_LOG_RETENTION_DAYS = 14

QTY_EPS = 1e-6
OVERSIZE_FACTOR = 1.5     # real position this much bigger than intended => emergency flatten

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]


@dataclass
class BotConfig:
    name: str
    worker_id: str  # short tag for shared-table rows, e.g. "worker1" -- must be unique per bot
    table_state: str
    table_trades: str
    table_runs: str
    stoch_window: int
    tp_pct: float
    sl_pct: float
    entry_lo: float
    entry_hi: float
    reversal_lo: float
    reversal_hi: float
    er_period: Optional[int] = None   # Efficiency Ratio regime detector; None = disabled
    er_max: Optional[float] = None    # ER above this = "trending", not chop
    # Regime-switch: while trending, trade WITH the direction instead of fading the
    # stochastic extreme, using this leg's own (usually wider) TP/SL. None = the old
    # block-only behavior (skip the entry instead of flipping to trend-follow).
    trend_tp_pct: Optional[float] = None
    trend_sl_pct: Optional[float] = None
    # A/B test (2026-09-22): trend-regime trades on Worker 1/3 have been net losers (41-42%
    # win rate) while fade-regime trades stay near breakeven -- consistent with a lagging
    # trend confirmation catching the move right as it exhausts. True flips the direction
    # computed by compute_er_and_direction() (long<->short) so this bot fades the "confirmed
    # trend" instead of following it, using the same trend-leg TP/SL. Live comparison against
    # the un-inverted version, not backtested first.
    trend_invert_direction: bool = False
    # True only for bots whose table actually has the position_tp_pct/position_sl_pct
    # columns (currently W1 and W3, migrated 2026-09-22). W2's table was never migrated --
    # writing these keys there errors (unknown column). This is independent of whether
    # trend_tp_pct is currently configured: W1 can drop regime-switch entirely while keeping
    # this True, so a leftover trend-band value from before doesn't silently linger forever.
    schema_has_position_bands: bool = False
    # Reversal guard (2026-09-23): validated against real recorded ticks + a 1.4s execution-
    # latency model -- ignoring a fresh opposite-side signal until the current position is at
    # least this many seconds old cut premature reversals (62->56 in the test window) and let
    # more positions run to a real TP (51->54), for a ~36% relative PnL improvement over the
    # same window's baseline. TP/SL still fire immediately regardless of this guard. None =
    # no guard (any opposite signal reverses immediately, the original behavior).
    reversal_guard_seconds: Optional[float] = None
    # Pure ER-fade (2026-09-23): no stochastic entries at all -- ER(er_period) is the ONLY
    # signal. When ER > er_max, enter fading the detected direction (trend_invert_direction
    # should be True to actually fade rather than follow), at the bot's plain tp_pct/sl_pct
    # (no separate trend band). Exit is TP/SL exclusively -- there is no reversal exit in
    # this mode. Tick-validated on real ticks + the 1.4s latency model, window swept 2-20:
    # windows 2-9 were consistently profitable, window 6 best (56 trades, 62.5% win,
    # +1.524% over a 14.3h window) -- much cleaner than the stochastic-blended regime switch.
    pure_trend_fade: bool = False
    # Session drawdown breaker (2026-09-23, tightened after a real -1.86% BTC crash in 18 min):
    # the day splits into 3 fixed 8h sessions (11am-7pm, 7pm-3am, 3am-11am ET). Two trip
    # conditions, checked every tick: (1) once the session has been realized-profitable at
    # least once, giving back this many percentage points of total account equity from that
    # peak; (2) if the session has NEVER been profitable yet, losing this many points from the
    # session's own start (closes the gap where an immediate bad start went unprotected).
    # Either one blocks new entries (existing positions still manage normally to TP/SL/
    # reversal-guard) until session_breaker_cooldown_min elapses, then re-arms with a fresh
    # peak/baseline *within the same session* -- does not wait for the next 8h boundary.
    # 0.25% chosen after tightening from an initial 0.4%; cooldown chosen from 4 real crash
    # events measured on our own recorded tick data (18-50 min to stabilize, median ~40 min).
    # None = disabled.
    session_drawdown_stop_pct: Optional[float] = None
    session_breaker_cooldown_min: float = 45.0
    # Smart resume (2026-09-23, built for Worker 1 after real data showed a plain ER(6)-style
    # "is this a clean trend" check stays under 0.75 at EVERY window 6-45 candles during a real
    # grinding decline -- net DIRECTION was the reliable signal there, not ER's cleanliness
    # measure). After session_breaker_cooldown_min, resuming ALSO requires: (1) net price
    # direction over this many candles no longer matches the direction the market was moving in
    # at trip time (whichever way that was -- not a downtrend-only check), and (2) recent
    # realized volatility (5-min high/low range as % of price) is back under
    # session_breaker_calm_range_pct. If either still fails, resume is deferred and re-checked
    # every session_breaker_recheck_min instead of resuming blind. None (either field) disables
    # that specific gate -- with both None, behaves exactly like Worker 3's plain fixed-cooldown
    # version. Swept threshold x cooldown x recheck against 28h of our own real tick data
    # (409 baseline trades, +$0.148): 0.15%/15min/10min recheck won clearly (179 trades, 65.9%
    # win, +$0.321) -- tighter than the fixed-cooldown-only calibration, because a false trip
    # costs little when resume is smart (it clears almost immediately) while missing a real
    # crash costs a lot, which pushes the optimal threshold tighter than before.
    session_breaker_direction_window: Optional[int] = None
    session_breaker_calm_range_pct: Optional[float] = None
    session_breaker_recheck_min: float = 10.0
    # Adaptive calm threshold (2026-09-24): instead of comparing recent volatility against a
    # fixed session_breaker_calm_range_pct, compare it against whatever volatility was actually
    # recorded AT the moment this trip happened -- "the volatility that got us kicked out
    # should be over," not an arbitrary global number. Tested against real tick data: 3 of 4
    # real trips this session had trip-moment volatility already BELOW the fixed 0.20%
    # threshold, meaning the fixed rule was demanding calmer conditions than even existed at
    # the crash -- pure wasted waiting. Adaptive beat both the fixed threshold and no breaker
    # at all on the same data (+0.86% vs +0.53% vs +0.62%). When True, session_breaker_calm_
    # range_pct is ignored in favor of the trip-moment reading.
    session_breaker_adaptive_calm: bool = False
    # True only for bots whose table has the session_breaker_* columns (migrated 2026-09-23
    # after a restart -- caused by an unrelated frontend-only deploy -- wiped an active
    # cooldown twice in production). When True, the breaker's state survives a restart by
    # reading/writing these columns instead of living in memory only. False = old in-memory-
    # only behavior (safe default for any bot that sets session_drawdown_stop_pct without the
    # migration having been run on its table).
    schema_has_session_breaker: bool = False
    # Entry volatility gate (2026-09-24, Worker 1 replacement for the PnL-drawdown session
    # breaker above -- a different mechanism entirely, gates on raw market volatility instead
    # of realized PnL). Pauses NEW entries (including the reopening leg of a reversal, but NOT
    # the closing leg -- TP/SL/signal-driven exits are never gated by this) once a completed
    # candle's true-range % hits entry_vol_pause_at_pct, resuming only once a later completed
    # candle comes in at or under entry_vol_resume_at_pct -- a lower bar on purpose, so it
    # doesn't flap right at one boundary. None (either field) disables this gate entirely.
    entry_vol_pause_at_pct: Optional[float] = None
    entry_vol_resume_at_pct: Optional[float] = None
    # Same persistence rationale as schema_has_session_breaker -- without this, a restart
    # (which happens on every push, to every service) forgets an active pause.
    schema_has_entry_vol_gate: bool = False
    # Self-lock (2026-09-24, Worker 3's second replacement -- the TR% gate above is dropped
    # for this one, too many silent no-ops). Same base strategy as Worker 2 (no reversal
    # guard, no session breaker, no volatility gate) plus one mechanism: the instant a REAL
    # position closes via SL, real order placement locks -- the bot keeps trading the exact
    # same signal on paper (no money, no real orders) until it posts two CONSECUTIVE paper
    # TPs (a paper SL resets that count to zero), then unlocks immediately -- same tick, no
    # extra delay, if a signal is live right when the 2nd paper TP closes.
    self_lock_enabled: bool = False
    schema_has_self_lock: bool = False
    # Reversal-counts-as-win (2026-09-25, Worker 3): broadens what counts toward the 2-in-a-row
    # unlock requirement -- a paper REVERSAL close with positive pnl counts the same as a
    # literal TP (a losing/breakeven reversal stays neutral, same as before; a paper SL still
    # resets the count to zero either way). Backtested on 79.9h of real tick data: literal-TP-
    # only was +1.663% (231 trades, 60.6% win); this variant was +2.327% (473 trades, 62.6%
    # win) -- more trades (unlocks faster) and a better return, at a slightly higher maxDD
    # ($1.56 vs $1.44). An earlier test on a smaller ~45h sample had found the opposite
    # (literal-TP-only won then) -- that finding didn't hold up once more data came in.
    self_lock_reversal_counts_as_win: bool = False
    # Trading-hours schedule (2026-09-24, Worker 1 -- stacked on top of its existing session
    # breaker, not a replacement). Set of UTC hours (0-23) during which NEW entries (and the
    # reopening leg of a reversal) are allowed; every other hour blocks new entries the same
    # way the session breaker and entry-vol gate do -- TP/SL/reversal-close on an existing
    # position are never gated by this, only new/reopening entries. None = disabled (every
    # other bot). Stateless by design: just checks the wall-clock UTC hour each tick, so it
    # needs no persistence/migration and can't be wiped by a restart. Built from 908 real
    # Worker 2 trades bucketed by UTC close-hour (2026-09-22 to 2026-09-24): these are every
    # hour where that real data came out net positive.
    trading_hours_utc: Optional[list] = None
    # Hour-open confirmation (2026-09-25, prepared alongside the Worker 2 combined-strategy
    # draft -- only meaningful with both trading_hours_utc and self_lock_enabled set). "Don't
    # walk into a bloodbath": the instant a scheduled hour opens (closed->open transition,
    # including right after a restart if the bot boots mid-open-hour -- a restart has no fresh
    # evidence either), real entries stay paused until the internal paper shadow posts ONE TP
    # (not the self-lock's usual two -- deliberately looser here so a real opportunity isn't
    # missed waiting for a second confirmation). That single TP only needs to happen once per
    # open-hour session; every real close after that is unaffected, including this window's own
    # self-lock cycles. In-memory only, on purpose -- it's supposed to re-arm on every restart,
    # so there is nothing to persist. None/False = disabled (every other bot).
    hour_open_requires_paper_tp: bool = False
    # RSI paper test (2026-09-26): a second, fully independent shadow strategy -- "Confirmed
    # Stochastic RSI" (Wilder RSI5, raw Stochastic RSI over the last 14 RSI values, no K/D
    # smoothing, entry/reversal requires S<20 or S>80 PLUS the latest completed candle closing
    # in the signal direction vs the previous completed candle) -- run purely on paper
    # alongside real trading. Never places a real order, never touches real_trading_locked or
    # any other real-trading gate; only logs simulated fills to lighter_btc_rsi_paper_trades so
    # weekday vs weekend performance can be compared with real forward data instead of a
    # backtest on the same historical file. Same TP 0.10%/SL 0.11% as the real bot, no
    # reversal-guard (the source report used none for this signal). Requires
    # schema_has_rsi_paper_test (the 3 rsi_paper_* columns on table_state) to persist an
    # in-flight paper position across restarts.
    rsi_paper_test_enabled: bool = False
    schema_has_rsi_paper_test: bool = False
    market_index: int = 1
    price_decimals: int = 1
    size_decimals: int = 5
    tick_seconds: float = 0.5
    # Price-tick logging failover chain: this bot writes only if every worker_id listed here
    # has gone quiet (no fresh row from them). Primary writer = empty list (always writes).
    # None = this bot does not participate in tick logging at all.
    tick_log_defers_to: Optional[list] = None
    tick_log_prune: bool = False  # only one bot should run the retention prune; keep it True
                                  # on exactly one worker (the primary) to avoid redundant deletes


# ── Pure helpers ────────────────────────────────────────────────────────────────────────────
def ms_to_iso(ms):
    if ms is None:
        return "1970-01-01T00:00:00+00:00"
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def parse_iso(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def tick_error_backoff_seconds(consecutive_errors):
    """1s, 2s, 4s, 8s, ... capped at 60s. Replaces a flat 1s retry (2026-09-23): hammering a
    WAF-blocked endpoint once a second for minutes both burns the retry budget for nothing and
    likely makes an IP-level block look more abusive, not less."""
    return min(1.0 * (2 ** min(consecutive_errors - 1, 6)), 60.0)


def round_trigger(p, up):
    step = 0.1
    return (int(p / step) + (1 if up else 0)) * step if up else (int(p / step)) * step


def _sig(k, lo, hi):
    if k is None:
        return None
    if k < lo:
        return "long"
    if k > hi:
        return "short"
    return None


def avg_entry(legs):
    total_notional = sum(l["usd_size"] for l in legs)
    total_qty_ = sum(l["usd_size"] / l["price"] for l in legs)
    return total_notional / total_qty_ if total_qty_ else None


def total_qty(legs):
    return sum(l["usd_size"] / l["price"] for l in legs)


def compute_er_and_direction(candles, period):
    """Kaufman Efficiency Ratio + the net direction of the move over the same window.
    ER = |net move| / total path length over `period` closed candles: near 1 = clean
    directional trend, near 0 = chop. Direction is "long" if price net-moved up over the
    window, "short" if down, None if perfectly flat or there isn't enough data yet."""
    closed = candles[:-1]
    if len(closed) < period + 1:
        return None, None
    window = closed[-(period + 1):]
    closes = [c["c"] for c in window]
    diff = closes[-1] - closes[0]
    net = abs(diff)
    path = sum(abs(closes[i] - closes[i - 1]) for i in range(1, len(closes)))
    er = net / path if path > 0 else 0.0
    direction = "long" if diff > 0 else ("short" if diff < 0 else None)
    return er, direction


def compute_range_pct(candles, window=5):
    """Realized volatility proxy: high/low range over the last `window` closed candles, as a
    % of the latest close. Used by the session breaker's smart resume to check the market has
    actually calmed down, not just that price stopped moving the same direction -- crypto
    rarely reverts to a pre-crash level, it just stops and consolidates at wherever it landed,
    so this is measured relative to the CURRENT price, not the pre-crash one."""
    closed = candles[:-1]
    if len(closed) < window:
        return None
    w = closed[-window:]
    hh = max(c["h"] for c in w)
    ll = min(c["l"] for c in w)
    return (hh - ll) / w[-1]["c"] * 100


def compute_true_range_pct(candles):
    """Single-candle true range as % of close, on the latest CLOSED candle only -- the entry
    volatility gate's signal. True range (not just high-low) includes the gap from the prior
    close, so a candle that opens on a jump still reads as volatile even if its own high/low
    span is narrow. Reacts to one spike immediately, unlike compute_range_pct's multi-candle
    window, which only catches a spike once it's rolled all the way through the window."""
    closed = candles[:-1]
    if len(closed) < 2:
        return None
    last = closed[-1]
    prev_close = closed[-2]["c"]
    if last["c"] <= 0:
        return None
    tr = max(last["h"] - last["l"], abs(last["h"] - prev_close), abs(last["l"] - prev_close))
    return tr / last["c"] * 100


def compute_rsi_stoch_confirmed_signal(candles, rsi_period=5, stoch_period=14):
    """"Confirmed Stochastic RSI" (2026-09-26 paper test): Wilder RSI(rsi_period) on completed
    1-min closes, then raw Stochastic RSI over the last stoch_period RSI values (no K/D
    smoothing) -- S = 100*(RSI-min)/(max-min) over that window. Long when S<20 AND the latest
    completed close is above the previous completed close; short when S>80 AND it closed
    below. Confirmation applies to both entries and reversals (same signal serves both -- there
    is no separate reversal threshold in this design, unlike the plain stochastic signal)."""
    closed = candles[:-1]
    need = rsi_period + stoch_period + 1  # +1 for the initial seed change dropped by diff()
    if len(closed) < need:
        return None, None
    closes = [c["c"] for c in closed]
    changes = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    if len(changes) < rsi_period + stoch_period:
        return None, None

    gains = [max(ch, 0.0) for ch in changes]
    losses = [max(-ch, 0.0) for ch in changes]
    avg_gain = sum(gains[:rsi_period]) / rsi_period
    avg_loss = sum(losses[:rsi_period]) / rsi_period

    def rsi_from(avg_gain, avg_loss):
        if avg_loss == 0:
            return 100.0
        return 100 - 100 / (1 + avg_gain / avg_loss)

    rsi_values = [rsi_from(avg_gain, avg_loss)]
    for i in range(rsi_period, len(changes)):
        avg_gain = (avg_gain * (rsi_period - 1) + gains[i]) / rsi_period
        avg_loss = (avg_loss * (rsi_period - 1) + losses[i]) / rsi_period
        rsi_values.append(rsi_from(avg_gain, avg_loss))

    if len(rsi_values) < stoch_period:
        return None, None
    window = rsi_values[-stoch_period:]
    lo, hi = min(window), max(window)
    if hi == lo:
        return None, None
    s = 100 * (rsi_values[-1] - lo) / (hi - lo)

    prev_close, latest_close = closes[-2], closes[-1]
    signal = None
    if s < 20 and latest_close > prev_close:
        signal = "long"
    elif s > 80 and latest_close < prev_close:
        signal = "short"
    return signal, closed[-1]["t"]


# ── Live state cache, fed by the WebSocket ──────────────────────────────────────────────────
class LiveState:
    def __init__(self, account_index, market_index):
        self.account_key = str(account_index)
        self.market_key = str(market_index)
        self.order_book = {}
        self.account = {}
        self.ob_updated_at = 0.0
        self.acct_updated_at = 0.0

    def on_order_book(self, market_id, state):
        if str(market_id) == self.market_key:
            self.order_book = state
            self.ob_updated_at = time.time()

    def on_account(self, account_id, state):
        if str(account_id) != self.account_key:
            return
        # Merge, don't replace: a message carrying a field as an explicit null must not wipe
        # out previously-known-good data (this produced a corrupted collateral read and a
        # fake ~$100 "loss" on 2026-09-21).
        for k, v in state.items():
            if v is not None:
                self.account[k] = v
        self.acct_updated_at = time.time()

    def best_bid_ask(self):
        bids = self.order_book.get("bids") or []
        asks = self.order_book.get("asks") or []
        if not bids or not asks:
            return None, None
        return max(float(b["price"]) for b in bids), min(float(a["price"]) for a in asks)

    def position_collateral(self):
        if not self.account:
            return None, None
        # `or {}` rather than .get(key, {}): these keys arrive as explicit nulls, and a dict
        # default only applies when the key is absent.
        positions = self.account.get("positions") or {}
        pos_raw = positions.get(self.market_key) or {}
        sign = 1 if str(pos_raw.get("sign", 1)) in ("1", "True", "true") else -1
        pos = sign * float(pos_raw.get("position", 0) or 0)
        collateral = None  # None, never a fabricated 0.0 -- a fake zero here previously got
        # read as "account emptied" and wiped the tracked realized PnL on the next close.
        assets = self.account.get("assets") or {}
        for asset in assets.values():
            if asset.get("symbol") == "USDC":
                collateral = float(asset.get("margin_balance", 0) or 0)
                break
        return pos, collateral

    def book_fresh(self, max_age=10.0):
        """Only the order book. Account freshness is handled separately in read_position():
        the account channel pushes on fills only, with no idle heartbeat, so demanding a
        recent account push kept every idle bot permanently on the REST fallback."""
        return time.time() - self.ob_updated_at < max_age


class StochBot:
    def __init__(self, cfg: BotConfig):
        self.cfg = cfg
        self.client = None
        self.http = None
        self.live = None
        self.account_index = None
        self.candles = []
        self.candles_updated_at = 0.0
        self.last_order_ts = 0.0
        self.ws_connected_at = 0.0
        self.last_heartbeat = 0.0
        self.last_stale_log = 0.0
        self.ticks = 0
        self._pos_cache = None      # (pos, collateral) from the last authoritative REST read
        self._pos_cache_at = 0.0
        self._auth_token = None     # cached signed auth token for get_position_rest()
        self._auth_token_expiry_at = 0.0
        self._close_retry_failures = 0    # backoff counter for the close_requested retry loop
        self._close_retry_next_at = 0.0
        self._pos_read_consecutive_failures = 0   # backoff counter for read_position()'s REST retries
        self._pos_read_next_attempt_at = 0.0
        # Session drawdown breaker state -- in-memory only (not DB-persisted), so a restart
        # re-arms it. That's an accepted tradeoff: restarts already happen every few hours in
        # this project, and re-arming on restart is a safe default direction to err in.
        self.session_index = None      # which of the 3 daily sessions we're currently in
        self.session_baseline_pnl = None
        self.session_peak_pnl = 0.0
        self.session_start_equity = None
        self.session_paused = False
        self.session_paused_at = None
        self.session_trip_direction = None   # direction the market was moving in at trip time
        self.session_next_check_at = None    # when to next evaluate whether resume is safe
        self.session_trip_range_pct = None   # volatility recorded at trip time (adaptive calm)
        # Entry volatility gate (independent of the session breaker above)
        self.entry_vol_paused = False
        self.entry_vol_last_bar_ts = None
        self._entry_vol_loaded = False
        # Self-lock (independent of the entry volatility gate above)
        self.real_trading_locked = False
        self.paper_side = None
        self.paper_entry = None
        self.paper_entry_ms = None
        self.paper_consecutive_tps = 0
        self._self_lock_loaded = False
        # Hour-open confirmation (independent of the self-lock counter above -- this one only
        # ever needs a single TP, and re-arms on every restart by design).
        self.awaiting_open_confirmation = False
        self._last_hour_open = None
        # RSI paper test (fully independent shadow -- never reads or writes anything above)
        self.rsi_paper_side = None
        self.rsi_paper_entry = None
        self.rsi_paper_entry_ms = None
        self._rsi_paper_loaded = False

    # ── Supabase (aiohttp: async, and actually cancellable) ─────────────────────────────────
    async def sb(self, method, path, body=None, extra_headers=None):
        """All Supabase I/O. Deliberately NOT urllib.

        urllib blocks, so calling it inline froze the WS task for the duration of every DB
        call. Moving it to `asyncio.to_thread` was worse: urllib's `timeout=` does not cover
        DNS resolution, so a wedged lookup pins a worker thread forever, and once the small
        default thread pool is exhausted every later call -- including the watchdog's own
        error log -- queues behind it and the whole bot goes silent with nothing written
        anywhere. aiohttp's ClientTimeout is enforced by the event loop itself and covers the
        entire request including name resolution, so a hung network never costs us the loop.
        """
        url = f"{SUPABASE_URL}/rest/v1/{path}"
        headers = {
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
        }
        if method in ("POST", "PATCH"):
            headers["Prefer"] = "return=representation"
        if extra_headers:
            headers.update(extra_headers)
        async with self.http.request(method, url, json=body, headers=headers) as resp:
            text = await resp.text()
            if resp.status >= 400:
                raise RuntimeError(f"supabase {resp.status} on {method} {path}: {text[:200]}")
            return jsonlib.loads(text) if text else None

    async def get_state(self):
        rows = await self.sb("GET", f"{self.cfg.table_state}?id=eq.1")
        return rows[0]

    async def update_state(self, patch):
        await self.sb("PATCH", f"{self.cfg.table_state}?id=eq.1", patch)

    async def log_run(self, action, detail):
        # Always mirror to stdout: if Supabase is the thing that is broken, the DB log is
        # exactly the one place the evidence will not appear.
        print(f"[{action}] {detail}", flush=True)
        try:
            await self.sb("POST", self.cfg.table_runs, {"action": action, "detail": detail})
        except Exception as e:
            print(f"  (log_run failed: {e})", flush=True)

    async def log_trade(self, side, ae, exit_price, base_amount, pnl_usd, reason, legs_used, opened_at):
        # Idempotent insert (proven necessary 2026-09-24): a Render restart can briefly leave
        # the old and new process both alive, and both independently finish closing the same
        # real position -- each computes and writes the identical realized_pnl_usd update (so
        # money was never actually double-counted), but each also INSERTs its own trade row,
        # which duplicates unlike an UPDATE. on_conflict + resolution=ignore-duplicates makes
        # a repeat insert for the same (opened_at, side, avg_entry_price) a silent no-op
        # instead of a second row. Requires a matching unique constraint on table_trades.
        await self.sb(
            "POST",
            f"{self.cfg.table_trades}?on_conflict=opened_at,side,avg_entry_price",
            {
                "side": side, "avg_entry_price": ae, "exit_price": exit_price,
                "base_amount_btc": base_amount, "pnl_usd": pnl_usd, "reason": reason,
                "legs_used": legs_used, "opened_at": opened_at,
            },
            extra_headers={"Prefer": "resolution=ignore-duplicates,return=representation"},
        )

    # ── Candles ─────────────────────────────────────────────────────────────────────────────
    async def fetch_candles(self, count=60):
        end_ms = int(time.time() * 1000)
        url = (f"https://mainnet.zklighter.elliot.ai/api/v1/candles?market_id={self.cfg.market_index}"
               f"&resolution=1m&start_timestamp=0&end_timestamp={end_ms}&count_back={count}")
        async with self.http.get(url) as resp:
            data = jsonlib.loads(await resp.text())
        return sorted(data.get("c", []), key=lambda c: c["t"])

    async def run_candle_refresh_forever(self):
        while True:
            try:
                self.candles = await self.fetch_candles()
                self.candles_updated_at = time.time()
            except Exception as e:
                await self.log_run("candle_fetch_failed", {"error": str(e)[:300]})
            now = time.time()
            next_boundary = (int(now // 60) + 1) * 60 + 1.5  # just after the minute rolls over
            await asyncio.sleep(max(1.0, next_boundary - now))

    # ── Price-tick logging (failover chain, not all-3-write) ───────────────────────────────
    async def run_tick_logger_forever(self):
        """Records real bid/ask so a future backtest can replay against actual tick-by-tick
        price instead of 1-min candle high/low -- a same-window check against real trades on
        2026-09-22 showed candles are too coarse to reproduce what really happens live.

        Only one worker writes at a time. This bot only writes once every worker_id in
        `tick_log_defers_to` has gone quiet (no fresh row from them within STALE_AFTER) --
        so Worker 2 (empty list) always writes, Worker 3 takes over the moment Worker 2 goes
        silent, Worker 1 only kicks in if both are down. Whichever bot is running always
        keeps the recording continuous; this task can never affect trading either way.
        """
        cfg = self.cfg
        if cfg.tick_log_defers_to is None:
            return
        STALE_AFTER = TICK_LOG_EVERY * 3
        last_prune = 0.0
        while True:
            try:
                should_write = len(cfg.tick_log_defers_to) == 0
                if not should_write:
                    last = await self.sb(
                        "GET", "lighter_btc_price_ticks?select=ts,source&order=ts.desc&limit=1")
                    if not last:
                        should_write = True
                    else:
                        last_ts = datetime.fromisoformat(last[0]["ts"].replace("Z", "+00:00"))
                        age = time.time() - last_ts.timestamp()
                        active_higher_priority = (
                            last[0]["source"] in cfg.tick_log_defers_to and age < STALE_AFTER)
                        should_write = not active_higher_priority
                if should_write and self.live.book_fresh():
                    bid, ask = self.live.best_bid_ask()
                    if bid and ask:
                        await self.sb("POST", "lighter_btc_price_ticks",
                                      {"best_bid": bid, "best_ask": ask, "source": cfg.worker_id})
                if cfg.tick_log_prune and time.time() - last_prune > 3600:
                    last_prune = time.time()
                    cutoff = (datetime.now(timezone.utc)
                             - timedelta(days=TICK_LOG_RETENTION_DAYS)).isoformat()
                    await self.sb("DELETE", f"lighter_btc_price_ticks?ts=lt.{cutoff}")
            except Exception:
                pass  # never let tick logging affect trading
            await asyncio.sleep(TICK_LOG_EVERY)

    def compute_stoch_signal(self):
        c = self.candles
        w = self.cfg.stoch_window
        if len(c) < w + 2:
            return None, None, None
        closed = c[:-1]
        window = closed[-w:]
        hh = max(x["h"] for x in window)
        ll = min(x["l"] for x in window)
        ts = closed[-1]["t"]
        if hh == ll:
            return None, None, ts
        k = 100 * (closed[-1]["c"] - ll) / (hh - ll)
        return (_sig(k, self.cfg.entry_lo, self.cfg.entry_hi),
                _sig(k, self.cfg.reversal_lo, self.cfg.reversal_hi), ts)

    # ── WebSocket with a staleness watchdog ─────────────────────────────────────────────────
    async def _ws_session(self):
        ws = lighter.WsClient(
            order_book_ids=[self.cfg.market_index], account_ids=[self.account_index],
            on_order_book_update=self.live.on_order_book, on_account_update=self.live.on_account,
        )
        self.ws_connected_at = time.time()
        await ws.run_async()

    async def run_ws_forever(self):
        # `async for message in ws` never raises if the socket half-dies, so exception-only
        # reconnect is not enough: watch the data itself and force a reconnect on silence.
        while True:
            task = asyncio.create_task(self._ws_session())
            try:
                while not task.done():
                    await asyncio.sleep(2.0)
                    quiet_since = max(self.live.ob_updated_at, self.ws_connected_at)
                    age = time.time() - quiet_since
                    if age > WS_RECONNECT_AFTER:
                        await self.log_run("ws_watchdog_reconnect", {"ob_age": round(age, 1)})
                        break
                if task.done() and not task.cancelled():
                    exc = task.exception()
                    if exc is not None:
                        await self.log_run("ws_disconnected", {"error": str(exc)[:300]})
            except Exception as e:
                await self.log_run("ws_supervisor_error", {"error": str(e)[:300]})
            finally:
                task.cancel()
                with contextlib.suppress(BaseException):
                    await task
            await asyncio.sleep(1.0)

    # ── Exchange reads/writes, all timeout-bounded ──────────────────────────────────────────
    def _get_auth_token(self):
        """Signed auth token for get_position_rest(), cached for ~AUTH_TOKEN_LIFETIME_S.

        account() is otherwise sent fully unauthenticated (confirmed in the SDK source --
        AccountApi._account_serialize sets auth_settings=[]), which puts every read on
        Lighter's shared per-IP anonymous quota instead of our own per-account quota. That
        anonymous quota is what three workers polling ~1/s from the same Render IP blew
        through on 2026-09-23, triggering CloudFront's WAF CAPTCHA on every read for
        minutes straight. create_auth_token_with_expiry() only signs locally with the key
        we already hold -- no network call -- so caching it costs nothing and there is no
        reason not to attach it to every read.
        """
        now = time.time()
        if self._auth_token is not None and now < self._auth_token_expiry_at - AUTH_TOKEN_REFRESH_MARGIN_S:
            return self._auth_token
        token, err = self.client.create_auth_token_with_expiry()
        if err:
            return None
        self._auth_token = token
        self._auth_token_expiry_at = now + AUTH_TOKEN_LIFETIME_S
        return self._auth_token

    async def get_position_rest(self):
        # Backs off across ALL callers (read_position, confirm_fill, close_all,
        # emergency_flatten, try_enter -- every one of them calls this directly, not just
        # read_position()), not just the first one. Proven necessary 2026-09-24: a backoff
        # added only to read_position() left every other caller free to keep hammering a
        # WAF-blocked endpoint at full tick cadence the moment a bot held an open position
        # (confirm_fill/close_all bypass read_position() entirely). Fails fast (raises
        # without making the network call) rather than returning stale data here -- callers
        # like confirm_fill depend on this always being a genuinely fresh read; the ones that
        # want a stale fallback already catch the exception and provide their own (read_position's
        # cache, for example).
        now = time.time()
        if now < self._pos_read_next_attempt_at:
            raise RuntimeError(
                f"get_position_rest: backing off until {self._pos_read_next_attempt_at - now:.1f}s "
                f"from now ({self._pos_read_consecutive_failures} consecutive failures)")
        account_api = lighter.AccountApi(self.client.api_client)
        headers = {}
        token = self._get_auth_token()
        if token:
            headers["authorization"] = token
        try:
            acct = await asyncio.wait_for(
                account_api.account(by="index", value=str(self.account_index),
                                    _headers=headers or None,
                                    _request_timeout=REST_TIMEOUT),
                timeout=REST_TIMEOUT + 2.0,
            )
        except Exception:
            self._pos_read_consecutive_failures += 1
            self._pos_read_next_attempt_at = time.time() + tick_error_backoff_seconds(
                self._pos_read_consecutive_failures)
            raise
        self._pos_read_consecutive_failures = 0
        self._pos_read_next_attempt_at = 0.0
        a = acct.accounts[0]
        pos = 0.0
        for p in a.positions:
            if p.market_id == self.cfg.market_index:
                sign = 1 if str(getattr(p, "sign", 1)) in ("1", "True", "true") else -1
                pos = sign * float(p.position)
        # Every authoritative read refreshes the cache, so a confirm_fill right after an
        # order also leaves read_position() returning the post-fill truth immediately.
        self._pos_cache = (pos, float(a.collateral))
        self._pos_cache_at = time.time()
        return self._pos_cache

    async def read_position(self):
        """Position/collateral from REST, cached for POSITION_TTL seconds.

        The WS account cache is deliberately NOT consulted here. `account_all` pushes only
        on a fill, so when the push that should follow our own entry never arrives -- or
        arrives still showing the pre-fill state -- the cache reports "flat" indefinitely
        while we are really holding a position. Every tick then concludes it was closed
        externally, re-verifies against REST, is told it is still open, and skips the rest
        of the tick, so TP and SL are never evaluated while a real position sits unmanaged.
        That is exactly what happened on 2026-09-22 at 00:24 to all three workers.

        REST is always right, and one call per POSITION_TTL is ~18x below the polling rate
        that caused the original rate-limit storm (3 calls every 0.5s). Price still comes
        from the WS order book, so TP/SL triggers stay real-time -- position size is the
        only thing moved here, and it does not change second to second.
        """
        now = time.time()
        if self._pos_cache is not None and now - self._pos_cache_at < POSITION_TTL:
            return self._pos_cache
        try:
            return await self.get_position_rest()
        except Exception as e:
            # Proven necessary in production (2026-09-23): Lighter's CloudFront WAF started
            # returning a CAPTCHA challenge (HTTP 405) to Render's IP specifically -- every
            # tick failed right here, before ever reaching the TP/SL check below, leaving two
            # real open positions (already past their TP) completely unmanaged for minutes.
            # Falling back to the last known position lets the tick continue far enough to
            # still evaluate and act on TP/SL using slightly stale size data, instead of
            # giving up entirely. If we've never successfully read a position at all, there
            # is nothing safe to fall back to, so this still raises in that case.
            #
            # get_position_rest() itself now backs off on repeated failure (2026-09-24) --
            # this is just catching whatever it raises, not managing the retry timing.
            if self._pos_cache is not None:
                await self.log_run("position_read_failed_using_cache", {
                    "error": str(e)[:300], "cache_age_s": round(now - self._pos_cache_at, 1),
                    "consecutive": self._pos_read_consecutive_failures,
                })
                return self._pos_cache
            raise

    async def confirm_fill(self, want_nonzero, expect_qty=None, tries=6, delay=0.25):
        """Authoritative REST answer to 'what is the real position right now'.

        Never reads the WS cache: account broadcasts lagging a real fill by more than one
        check is what stacked 19 real orders into a ~$1900 position on 2026-09-21. When
        `expect_qty` is given, a position far smaller than requested counts as not-yet-
        settled rather than done, so a partial fill is not mistaken for the finished size.

        tries/delay tuned from a live measurement (2026-09-22): polling the real exchange
        every 0.1s found the true fill-to-queryable delay sits at ~0.7-1.1s, tight and
        consistent. The old defaults (tries=4, delay=1.0) checked too early, then
        overshot that window by waiting a full second past it, landing real closes at
        ~1.8s instead of ~0.7-1.1s. A faster poll fixes that -- confirmed live at
        tries=8/delay=0.25 (10/10 trials, mean 1.375s -> 0.778s, max 1.86s -> 1.07s) --
        but 8 tries doubles the worst-case wait if the exchange were ever genuinely
        unresponsive (each try can cost up to REST_TIMEOUT), which left only ~8s of
        margin under TICK_WATCHDOG instead of the ~70s the design assumed. tries=6 keeps
        essentially all the measured speedup (nothing here ever needed more than 2
        tries) while keeping a real safety margin (~40s) under the watchdog.
        """
        pos, coll = 0.0, None
        for attempt in range(tries):
            try:
                pos, coll = await self.get_position_rest()
            except Exception as e:
                if attempt == tries - 1:
                    await self.log_run("confirm_fill_read_failed", {"error": str(e)[:200]})
                    return pos, coll, False
                await asyncio.sleep(delay)
                continue
            settled = (abs(pos) > QTY_EPS) == want_nonzero
            if settled and want_nonzero and expect_qty:
                if abs(pos) < expect_qty * 0.5:
                    settled = False
            if settled:
                return pos, coll, True
            if attempt < tries - 1:
                await asyncio.sleep(delay)
        return pos, coll, False

    async def place_order(self, is_ask, base_amount, reduce_only, ref_price):
        """Returns an error string, or None. A returned error means *unknown*, not 'no fill'
        -- callers must verify against the real position either way."""
        band = ref_price * (0.9995 if is_ask else 1.0005)  # tight: prefer no fill over a bad fill
        exec_price = int(round(band * (10 ** self.cfg.price_decimals)))
        base_amount_int = int(round(base_amount * (10 ** self.cfg.size_decimals)))
        co_idx = int(time.time() * 1000) % 500_000_000
        self.last_order_ts = time.time()
        try:
            order, resp, err = await asyncio.wait_for(
                self.client.create_market_order(
                    market_index=self.cfg.market_index, client_order_index=co_idx,
                    base_amount=base_amount_int, avg_execution_price=exec_price,
                    is_ask=is_ask, reduce_only=reduce_only,
                ),
                timeout=ORDER_TIMEOUT,
            )
            return err
        except asyncio.TimeoutError:
            return "TIMEOUT: order request exceeded ORDER_TIMEOUT (may still have filled)"
        except Exception as e:
            return f"EXCEPTION: {str(e)[:200]}"

    async def cancel_all(self):
        try:
            await asyncio.wait_for(
                self.client.cancel_all_orders(
                    time_in_force=self.client.CANCEL_ALL_TIF_IMMEDIATE, timestamp_ms=0,
                    cancel_all_market_index=self.cfg.market_index,
                ),
                timeout=ORDER_TIMEOUT,
            )
        except Exception as e:
            await self.log_run("cancel_all_failed", {"error": str(e)[:200]})

    async def emergency_flatten(self, reason, detail):
        """Real position is larger than anything we asked for. Get flat and stop trading --
        this is the guard against repeating the ~20x-leverage incident."""
        await self.log_run("oversize_detected", detail)
        await self.cancel_all()
        for _ in range(3):
            pos, _coll = await self.get_position_rest()
            if abs(pos) <= QTY_EPS:
                break
            bid, ask = self.live.best_bid_ask()
            ref = bid if pos > 0 else ask
            if ref is None:
                await self.log_run("emergency_flatten_no_book", {"residual": pos})
                break
            await self.place_order(is_ask=(pos > 0), base_amount=abs(pos),
                                   reduce_only=True, ref_price=ref)
            await asyncio.sleep(1.0)
        pos_after, _c, flat = await self.confirm_fill(want_nonzero=False)
        patch = {
            "enabled": False, "side": None, "legs": [], "first_entry_price": None,
            "first_entry_time": None, "dca_level": 0,
        }
        if self.cfg.schema_has_position_bands:
            patch["position_tp_pct"] = None
            patch["position_sl_pct"] = None
        await self.update_state(patch)
        await self.log_run("emergency_flatten", {"reason": reason, "flat": flat,
                                                 "residual": pos_after})

    # ── Entry / exit ────────────────────────────────────────────────────────────────────────
    async def try_enter(self, signal, price, leg_usd, via, candle_ts, state, collateral_hint,
                        is_trending=False):
        cfg = self.cfg
        fail_count = state.get("consecutive_entry_failures", 0) or 0
        intended_qty = leg_usd / price
        err = await self.place_order(is_ask=(signal == "short"), base_amount=intended_qty,
                                     reduce_only=False, ref_price=price)
        # `err` is deliberately not treated as failure. A timed-out or nonce-rejected request
        # can still have filled; only the exchange knows.
        pos, coll, confirmed = await self.confirm_fill(want_nonzero=True, expect_qty=intended_qty)
        if not confirmed:
            await self.log_run("enter_no_fill", {"signal": signal, "via": via,
                                                 "error": str(err)[:200] if err else None,
                                                 "fail_count": fail_count + 1})
            await self.update_state({"last_processed_candle_ts": candle_ts,
                                     "consecutive_entry_failures": fail_count + 1})
            return False
        if abs(pos) > intended_qty * OVERSIZE_FACTOR:
            await self.emergency_flatten("entry_oversize", {
                "signal": signal, "via": via, "intended_qty": intended_qty,
                "real_qty": abs(pos), "error": str(err)[:200] if err else None,
            })
            return False
        # Record the REAL filled size, not the size we asked for, so TP/SL and the eventual
        # close all operate on the position that actually exists.
        real_usd = price * abs(pos)
        patch = {
            "side": signal, "legs": [{"price": price, "usd_size": real_usd}],
            "consecutive_entry_failures": 0, "first_entry_price": price,
            "first_entry_time": self.now_ms(), "dca_level": 0,
            "collateral_before_entry": coll if coll is not None else collateral_hint,
            "last_processed_candle_ts": candle_ts,
        }
        regime = None
        if cfg.pure_trend_fade:
            # Every entry here only fires when is_trending was true (see tick()), so it's
            # always a faded-trend entry -- never a plain chop fade, never a trend-follow.
            regime = "trend_fade"
        elif cfg.schema_has_position_bands:
            # Only bots whose table actually has these columns write them -- plain
            # fade-only bots without the migration (Worker 2) never touch this field.
            trending_leg = is_trending and cfg.trend_tp_pct is not None
            patch["position_tp_pct"] = cfg.trend_tp_pct if trending_leg else cfg.tp_pct
            patch["position_sl_pct"] = cfg.trend_sl_pct if trending_leg else cfg.sl_pct
            regime = "trend" if trending_leg else "fade"
        await self.update_state(patch)
        await self.log_run("entered", {"signal": signal, "price": price, "via": via,
                                       "qty": abs(pos), "regime": regime})
        return True

    async def close_all(self, reason, state, side, legs, best_bid, best_ask, candle_ts,
                        known_pos=None):
        prior_collateral = state.get("collateral_before_entry")
        # Close what is really open. Closing only the tracked legs would leave a residual
        # position running whenever a phantom fill made the real size larger.
        #
        # `known_pos` lets the caller pass the position it already read this same tick
        # (read_position()/the reconcile block), instead of paying for another REST round
        # trip here -- measured ~0.35s on a live test (2026-09-22). Only trusted if it's
        # non-null and points the same direction as the side we're closing; anything else
        # falls back to a fresh authoritative read, same as before.
        if known_pos is not None and (known_pos > 0) == (side == "long") and abs(known_pos) > QTY_EPS:
            real_pos = known_pos
        else:
            try:
                real_pos, _coll = await self.get_position_rest()
            except Exception as e:
                await self.log_run("close_read_failed", {"reason": reason, "error": str(e)[:200]})
                return False
        qty = abs(real_pos)
        if qty <= QTY_EPS:
            return True  # already flat; the reconcile branch books it next tick
        is_ask = real_pos > 0
        # No cancel_all() here: these bots only ever place reduce_only market orders, never
        # a resting/limit order, so there is structurally nothing to cancel. Confirmed live
        # (zero active orders on all 3 real accounts) and measured -- it cost ~0.37s of pure
        # overhead on every close for no benefit (2026-09-22).
        err = await self.place_order(is_ask=is_ask, base_amount=qty, reduce_only=True,
                                     ref_price=(best_bid if is_ask else best_ask))
        pos_after, coll_after, confirmed = await self.confirm_fill(want_nonzero=False)
        if not confirmed and abs(pos_after) > QTY_EPS:
            # One retry for whatever is left rather than leaving a residual open.
            await self.log_run("close_residual_retry", {"reason": reason, "residual": pos_after,
                                                        "error": str(err)[:200] if err else None})
            await self.place_order(is_ask=(pos_after > 0), base_amount=abs(pos_after),
                                   reduce_only=True,
                                   ref_price=(best_bid if pos_after > 0 else best_ask))
            pos_after, coll_after, confirmed = await self.confirm_fill(want_nonzero=False)
        if not confirmed:
            await self.log_run("close_incomplete", {"reason": reason, "remaining_qty": pos_after})
            return False
        pnl = (coll_after - prior_collateral) if (prior_collateral is not None and coll_after is not None) else 0.0
        ae = avg_entry(legs) or state.get("first_entry_price")
        if ae and qty > 0:
            exit_price = ae + pnl / qty if side == "long" else ae - pnl / qty
        else:
            exit_price = ae
        new_pnl = state["realized_pnl_usd"] + pnl
        close_patch = {"side": None, "legs": [], "first_entry_price": None,
                       "first_entry_time": None, "dca_level": 0,
                       "realized_pnl_usd": new_pnl,
                       "last_processed_candle_ts": candle_ts}
        if self.cfg.schema_has_position_bands:
            close_patch["position_tp_pct"] = None
            close_patch["position_sl_pct"] = None
        await self.update_state(close_patch)
        await self.log_trade(side, ae, exit_price, qty, pnl, reason, len(legs),
                             ms_to_iso(state.get("first_entry_time")))
        await self.log_run("closed", {"reason": reason, "pnl": pnl, "side": side})
        state["realized_pnl_usd"] = new_pnl
        return True

    def now_ms(self):
        return self.candles[-1]["t"] if self.candles else int(time.time() * 1000)

    def _current_session_start(self, now_utc):
        """3 fixed 8h sessions: 11am-7pm ET, 7pm-3am ET, 3am-11am ET -- 15:00-23:00 UTC,
        23:00-07:00 UTC, 07:00-15:00 UTC during EDT. Returns this moment's session start."""
        day = now_utc.date()
        hour = now_utc.hour
        if 15 <= hour < 23:
            start_date, start_hour = day, 15
        elif hour < 7:
            prev = day - timedelta(days=1)
            start_date, start_hour = prev, 23
        elif hour < 15:
            start_date, start_hour = day, 7
        else:  # hour >= 23
            start_date, start_hour = day, 23
        return datetime(start_date.year, start_date.month, start_date.day, start_hour,
                        tzinfo=timezone.utc)

    def _persist_session_breaker_patch(self):
        return {
            "session_breaker_session_start": self.session_index.isoformat() if self.session_index else None,
            "session_breaker_baseline_pnl": self.session_baseline_pnl,
            "session_breaker_peak_pnl": self.session_peak_pnl,
            "session_breaker_paused": self.session_paused,
            "session_breaker_paused_at": self.session_paused_at.isoformat() if self.session_paused_at else None,
            "session_breaker_trip_direction": self.session_trip_direction,
            "session_breaker_next_check_at": self.session_next_check_at.isoformat() if self.session_next_check_at else None,
            "session_breaker_trip_range_pct": self.session_trip_range_pct,
        }

    def _apply_trading_hours_gate(self, entry_signal, now_utc=None):
        """Blocks new entries outside cfg.trading_hours_utc (a set of allowed UTC hours,
        0-23). Stateless -- just reads the wall-clock hour, no persistence needed. None
        (the default) disables this entirely and returns entry_signal unchanged."""
        if self.cfg.trading_hours_utc is None:
            return entry_signal
        now_utc = now_utc or datetime.now(timezone.utc)
        if now_utc.hour in self.cfg.trading_hours_utc:
            return entry_signal
        return None

    async def _check_hour_open_confirmation(self, has_open_position=False, now_utc=None):
        """Detects a closed->open transition on cfg.trading_hours_utc and arms
        awaiting_open_confirmation -- cleared by the next paper TP in _update_paper_shadow.
        self._last_hour_open starts None, so the very first tick counts as a transition too if
        it's already inside an open hour (a restart has no fresher evidence than a real
        transition would). No-op unless trading_hours_utc, hour_open_requires_paper_tp, AND
        self_lock_enabled are all set -- self_lock_enabled is required even though this isn't
        the self-lock's own counter, because _update_paper_shadow (the only place that clears
        this flag) never runs without it. Arming the flag with no paper shadow running to ever
        clear it would permanently lock out real entries after the first hour-open transition.

        has_open_position skips arming entirely (2026-09-26 fix): the whole point is "don't
        walk into a NEW real position blind" -- if a real position is already open, real
        trading was already active, there is nothing blind about it, and arming here would
        only needlessly gate the NEXT entry after this one closes. Caught live: a restart
        landed 42s after a real entry (same open hour), which armed the flag despite the open
        position being managed fine -- the position itself was never at risk, but the bot
        would have demanded a fresh paper win before its next entry for no real reason.

        Writes awaiting_open_confirmation to state on the transition -- display-only (the
        dashboard has no other way to show why real trading looks idle despite not being
        self-lock-locked), the in-memory flag stays the actual source of truth so a restart
        still re-arms per the design, this DB copy is just a mirror of it."""
        cfg = self.cfg
        if (not cfg.hour_open_requires_paper_tp or cfg.trading_hours_utc is None
                or not cfg.self_lock_enabled):
            return
        now_utc = now_utc or datetime.now(timezone.utc)
        is_open_now = now_utc.hour in cfg.trading_hours_utc
        if is_open_now and self._last_hour_open is not True and not has_open_position:
            self.awaiting_open_confirmation = True
            await self.update_state({"awaiting_open_confirmation": True})
        self._last_hour_open = is_open_now

    async def _apply_session_breaker(self, state, entry_signal, now_utc=None):
        """Two trip conditions: drawdown from an established session peak, OR a raw loss from
        session start if the session was never yet profitable (closes the gap where an
        immediate bad start went unprotected). Either blocks new entries for
        session_breaker_cooldown_min, then re-arms with a fresh peak/baseline *within the same
        session* (does not wait for the next 8h boundary) -- UNLESS
        session_breaker_direction_window is set, in which case resuming also requires net price
        direction over that window to have stopped matching the direction the market was moving
        in at trip time (whichever way that was -- this isn't a "downtrend only" check, a trip
        during a rally waits for the rally to calm/reverse the same way). If it's still moving
        the same way, resume is deferred and re-checked every session_breaker_recheck_min
        instead of resuming blind. Real data (2026-09-23): a plain ER(6)-style "is this a clean
        trend" check stayed under 0.75 at EVERY window from 6-45 candles during a real grinding
        decline that kept stopping out fade entries -- net DIRECTION was the reliable signal
        there, not ER's trend-cleanliness measure, which is why this checks direction only.

        With schema_has_session_breaker=True, state survives a restart by reading/writing the
        session_breaker_* columns -- proven necessary in production: an unrelated frontend-only
        deploy still restarts this backend (Render redeploys every service on any push to the
        watched branch), and that silently wiped an active cooldown twice before this existed.
        Without the flag, falls back to in-memory-only (resets on every restart)."""
        now_utc = now_utc or datetime.now(timezone.utc)
        session_start = self._current_session_start(now_utc)
        persist = self.cfg.schema_has_session_breaker

        if self.session_index != session_start:
            # First, try to rehydrate from a persisted row matching THIS session (recovers
            # from a restart mid-session instead of wiping an active pause/peak).
            rehydrated = False
            if persist and self.session_index is None:
                saved_start = state.get("session_breaker_session_start")
                if saved_start and parse_iso(saved_start) == session_start:
                    self.session_index = session_start
                    self.session_baseline_pnl = state.get("session_breaker_baseline_pnl")
                    self.session_peak_pnl = state.get("session_breaker_peak_pnl") or 0.0
                    self.session_paused = bool(state.get("session_breaker_paused"))
                    paused_at = state.get("session_breaker_paused_at")
                    self.session_paused_at = parse_iso(paused_at) if paused_at else None
                    self.session_trip_direction = state.get("session_breaker_trip_direction")
                    self.session_trip_range_pct = state.get("session_breaker_trip_range_pct")
                    next_check = state.get("session_breaker_next_check_at")
                    if next_check:
                        self.session_next_check_at = parse_iso(next_check)
                    elif self.session_paused_at is not None:
                        # Backward-compat: a row persisted before this field existed --
                        # reconstruct it from paused_at + the (possibly since-changed) cooldown.
                        self.session_next_check_at = self.session_paused_at + timedelta(
                            minutes=self.cfg.session_breaker_cooldown_min)
                    else:
                        self.session_next_check_at = None
                    self.session_start_equity = state["seed_usd"] + self.session_baseline_pnl
                    rehydrated = True
            if not rehydrated:
                self.session_index = session_start
                self.session_baseline_pnl = state["realized_pnl_usd"]
                self.session_peak_pnl = 0.0
                self.session_paused = False
                self.session_paused_at = None
                self.session_trip_direction = None
                self.session_next_check_at = None
                self.session_trip_range_pct = None
                if persist:
                    await self.update_state(self._persist_session_breaker_patch())
            self.session_start_equity = state["seed_usd"] + self.session_baseline_pnl

        if self.session_paused and self.session_next_check_at is not None and now_utc >= self.session_next_check_at:
            direction_window = self.cfg.session_breaker_direction_window
            can_rearm = True
            if direction_window:
                _, current_dir = compute_er_and_direction(self.candles, direction_window)
                if current_dir is not None and current_dir == self.session_trip_direction:
                    can_rearm = False
            calm_threshold = (self.session_trip_range_pct if self.cfg.session_breaker_adaptive_calm
                             else self.cfg.session_breaker_calm_range_pct)
            if can_rearm and calm_threshold:
                range_pct = compute_range_pct(self.candles)
                if range_pct is not None and range_pct > calm_threshold:
                    can_rearm = False
            if can_rearm:
                # Cleared (cooldown elapsed, and market has calmed/reversed if direction-gated)
                # -- re-arm within the same session, fresh peak/baseline so we don't instantly
                # re-trip on stale pre-cooldown drawdown.
                self.session_paused = False
                self.session_paused_at = None
                self.session_trip_direction = None
                self.session_next_check_at = None
                self.session_trip_range_pct = None
                self.session_baseline_pnl = state["realized_pnl_usd"]
                self.session_peak_pnl = 0.0
                self.session_start_equity = state["seed_usd"] + self.session_baseline_pnl
                if persist:
                    await self.update_state(self._persist_session_breaker_patch())
            else:
                # Still moving the same way it was at trip time -- defer to a shorter recheck
                # instead of resuming blind or waiting the full cooldown again.
                self.session_next_check_at = now_utc + timedelta(
                    minutes=self.cfg.session_breaker_recheck_min)
                if persist:
                    await self.update_state({
                        "session_breaker_next_check_at": self.session_next_check_at.isoformat(),
                    })

        session_pnl = state["realized_pnl_usd"] - self.session_baseline_pnl
        if session_pnl > self.session_peak_pnl:
            self.session_peak_pnl = session_pnl
            if persist:
                await self.update_state({"session_breaker_peak_pnl": self.session_peak_pnl})

        threshold = self.cfg.session_drawdown_stop_pct
        if not self.session_paused and self.session_start_equity:
            tripped, dd_pct, basis = False, None, None
            if self.session_peak_pnl > 0:
                dd_pct = (self.session_peak_pnl - session_pnl) / self.session_start_equity * 100
                basis = "drawdown_from_peak"
            else:
                dd_pct = -session_pnl / self.session_start_equity * 100
                basis = "raw_loss_from_start"
            if dd_pct >= threshold:
                tripped = True
            if tripped:
                self.session_paused = True
                self.session_paused_at = now_utc
                self.session_next_check_at = now_utc + timedelta(
                    minutes=self.cfg.session_breaker_cooldown_min)
                if self.cfg.session_breaker_direction_window:
                    _, self.session_trip_direction = compute_er_and_direction(
                        self.candles, self.cfg.session_breaker_direction_window)
                else:
                    self.session_trip_direction = None
                self.session_trip_range_pct = (compute_range_pct(self.candles)
                                               if self.cfg.session_breaker_adaptive_calm else None)
                if persist:
                    await self.update_state(self._persist_session_breaker_patch())
                await self.log_run("session_drawdown_stop", {
                    "session_start": self.session_index.isoformat(), "basis": basis,
                    "session_peak_pnl": self.session_peak_pnl, "session_pnl": session_pnl,
                    "dd_pct": dd_pct, "threshold_pct": threshold,
                    "cooldown_min": self.cfg.session_breaker_cooldown_min,
                    "trip_direction": self.session_trip_direction,
                    "trip_range_pct": self.session_trip_range_pct,
                })

        return None if self.session_paused else entry_signal

    async def _apply_entry_volatility_gate(self, state, candle_ts, entry_signal):
        """Pause new entries once a completed candle's true range spikes, resume once a later
        completed candle calms back down -- a different mechanism than the session breaker
        above (pure market volatility, no PnL tracking at all). Asymmetric thresholds
        (pause_at > resume_at) on purpose, so it doesn't flap on/off right at one boundary.

        Only gates entry_signal here; the reopening leg of a reversal (handled separately in
        tick(), via self.entry_vol_paused directly) also respects this, but the closing leg
        of a reversal and TP/SL never do -- risk management always runs regardless of pause.
        """
        cfg = self.cfg
        if cfg.entry_vol_pause_at_pct is None:
            return entry_signal
        if not self._entry_vol_loaded:
            self._entry_vol_loaded = True
            if cfg.schema_has_entry_vol_gate:
                self.entry_vol_paused = bool(state.get("entry_vol_paused"))
                self.entry_vol_last_bar_ts = state.get("entry_vol_last_bar_ts")
        if self.entry_vol_last_bar_ts != candle_ts:
            self.entry_vol_last_bar_ts = candle_ts
            tr_pct = compute_true_range_pct(self.candles)
            changed = False
            if tr_pct is not None:
                if tr_pct >= cfg.entry_vol_pause_at_pct and not self.entry_vol_paused:
                    self.entry_vol_paused = True
                    changed = True
                elif self.entry_vol_paused and tr_pct <= cfg.entry_vol_resume_at_pct:
                    self.entry_vol_paused = False
                    changed = True
            if cfg.schema_has_entry_vol_gate:
                patch = {"entry_vol_last_bar_ts": self.entry_vol_last_bar_ts}
                if changed:
                    patch["entry_vol_paused"] = self.entry_vol_paused
                await self.update_state(patch)
            if changed:
                await self.log_run("entry_vol_gate_toggled",
                                   {"paused": self.entry_vol_paused, "tr_pct": tr_pct})
        return None if self.entry_vol_paused else entry_signal

    async def _load_self_lock_state(self, state):
        if self._self_lock_loaded:
            return
        self._self_lock_loaded = True
        if self.cfg.schema_has_self_lock:
            self.real_trading_locked = bool(state.get("real_trading_locked"))
            self.paper_side = state.get("paper_side")
            self.paper_entry = state.get("paper_entry_price")
            self.paper_entry_ms = state.get("paper_entry_time")
            self.paper_consecutive_tps = state.get("paper_consecutive_tps") or 0

    async def _lock_real_trading(self):
        """A real SL just closed -- lock real order placement immediately. Resets the paper
        TP counter too: the 2-in-a-row count is always measured fresh from this moment
        forward, not carried over from whatever the shadow happened to be doing before."""
        self.real_trading_locked = True
        self.paper_consecutive_tps = 0
        if self.cfg.schema_has_self_lock:
            await self.update_state({"real_trading_locked": True, "paper_consecutive_tps": 0})
        await self.log_run("real_trading_locked", {"via": "real_sl"})

    async def _update_paper_shadow(self, state, entry_signal, reversal_signal, best_bid, best_ask, now_ms):
        """Always-on simulated shadow of the plain (no-guard) strategy -- never places a real
        order or touches realized_pnl_usd. The only thing it drives is when real_trading_locked
        clears: two CONSECUTIVE paper TPs (a paper SL resets the count to zero) unlock real
        trading again, proving the market is tradeable again by actually trading through it on
        paper, instead of guessing from a timer or a volatility reading -- which is exactly
        what the entry volatility gate this replaces kept getting wrong (detected a spike,
        then didn't actually act on it most of the time)."""
        cfg = self.cfg
        await self._load_self_lock_state(state)

        if self.paper_side is None:
            if entry_signal is not None:
                self.paper_side = entry_signal
                self.paper_entry = best_ask if entry_signal == "long" else best_bid
                self.paper_entry_ms = now_ms
                if cfg.schema_has_self_lock:
                    await self.update_state({
                        "paper_side": self.paper_side, "paper_entry_price": self.paper_entry,
                        "paper_entry_time": self.paper_entry_ms,
                    })
            return

        side = self.paper_side
        entry = self.paper_entry
        check_price = best_bid if side == "long" else best_ask
        if side == "long":
            tp = entry * (1 + cfg.tp_pct / 100); sl = entry * (1 - cfg.sl_pct / 100)
            hit_sl = check_price <= sl; hit_tp = check_price >= tp
        else:
            tp = entry * (1 - cfg.tp_pct / 100); sl = entry * (1 + cfg.sl_pct / 100)
            hit_sl = check_price >= sl; hit_tp = check_price <= tp
        reason = "SL" if hit_sl else ("TP" if hit_tp else None)
        reversal_ready = reversal_signal is not None and reversal_signal != side
        if reversal_ready and cfg.reversal_guard_seconds:
            age_s = (now_ms - self.paper_entry_ms) / 1000 if self.paper_entry_ms is not None else None
            reversal_ready = age_s is not None and age_s >= cfg.reversal_guard_seconds

        if reason is None and not reversal_ready:
            return

        unlocked_now = False
        closed_side = side
        self.paper_side = None
        self.paper_entry = None
        self.paper_entry_ms = None

        confirmation_just_cleared = False
        # A pure reversal close (reason is None here, only reached because reversal_ready was
        # True) counts as a win too when self_lock_reversal_counts_as_win is set -- but only if
        # it actually closed favorably. A losing/breakeven reversal stays neutral (does NOT
        # reset the count, unlike a real SL) -- backtested both ways, resetting on a losing
        # reversal tested worse.
        counts_as_tp = reason == "TP"
        if not counts_as_tp and reason is None and cfg.self_lock_reversal_counts_as_win:
            pnl_pct = ((check_price - entry) / entry * 100 if closed_side == "long"
                       else (entry - check_price) / entry * 100)
            counts_as_tp = pnl_pct > 0

        if counts_as_tp:
            self.paper_consecutive_tps += 1
            if self.paper_consecutive_tps >= 2:
                self.paper_consecutive_tps = 0
                if self.real_trading_locked:
                    self.real_trading_locked = False
                    unlocked_now = True
            if cfg.hour_open_requires_paper_tp and self.awaiting_open_confirmation:
                self.awaiting_open_confirmation = False
                confirmation_just_cleared = True
        elif reason == "SL":
            self.paper_consecutive_tps = 0

        # Same close+reopen shape as the real position: an opposite signal reopens
        # immediately, regardless of whether this close was TP/SL or a pure reversal.
        if reversal_signal is not None and reversal_signal != closed_side:
            self.paper_side = reversal_signal
            self.paper_entry = best_ask if reversal_signal == "long" else best_bid
            self.paper_entry_ms = now_ms

        if cfg.schema_has_self_lock:
            patch = {
                "paper_side": self.paper_side, "paper_entry_price": self.paper_entry,
                "paper_entry_time": self.paper_entry_ms,
                "paper_consecutive_tps": self.paper_consecutive_tps,
            }
            if unlocked_now:
                patch["real_trading_locked"] = False
            if confirmation_just_cleared:
                patch["awaiting_open_confirmation"] = False
            await self.update_state(patch)
        if unlocked_now:
            await self.log_run("real_trading_unlocked", {"via": "two_consecutive_paper_tps"})

    async def _load_rsi_paper_state(self, state):
        if self._rsi_paper_loaded:
            return
        self._rsi_paper_loaded = True
        if self.cfg.schema_has_rsi_paper_test:
            self.rsi_paper_side = state.get("rsi_paper_side")
            self.rsi_paper_entry = state.get("rsi_paper_entry_price")
            self.rsi_paper_entry_ms = state.get("rsi_paper_entry_time")

    async def _update_rsi_paper_shadow(self, state, best_bid, best_ask, now_ms):
        """Fully independent paper-only shadow of "Confirmed Stochastic RSI" (see
        compute_rsi_stoch_confirmed_signal) -- never places a real order, never reads or
        writes real_trading_locked/awaiting_open_confirmation/any real-trading state. Only
        purpose is to log simulated trades to lighter_btc_rsi_paper_trades so weekday vs
        weekend performance can be watched forward, on data the signal was never fit to."""
        cfg = self.cfg
        await self._load_rsi_paper_state(state)
        signal, _ts = compute_rsi_stoch_confirmed_signal(self.candles)

        if self.rsi_paper_side is None:
            if signal is not None:
                self.rsi_paper_side = signal
                self.rsi_paper_entry = best_ask if signal == "long" else best_bid
                self.rsi_paper_entry_ms = now_ms
                if cfg.schema_has_rsi_paper_test:
                    await self.update_state({
                        "rsi_paper_side": self.rsi_paper_side,
                        "rsi_paper_entry_price": self.rsi_paper_entry,
                        "rsi_paper_entry_time": self.rsi_paper_entry_ms,
                    })
            return

        side = self.rsi_paper_side
        entry = self.rsi_paper_entry
        check_price = best_bid if side == "long" else best_ask
        if side == "long":
            tp = entry * (1 + cfg.tp_pct / 100); sl = entry * (1 - cfg.sl_pct / 100)
            hit_sl = check_price <= sl; hit_tp = check_price >= tp
        else:
            tp = entry * (1 - cfg.tp_pct / 100); sl = entry * (1 + cfg.sl_pct / 100)
            hit_sl = check_price >= sl; hit_tp = check_price <= tp
        reason = "SL" if hit_sl else ("TP" if hit_tp else None)
        reversal_ready = signal is not None and signal != side

        if reason is None and not reversal_ready:
            return

        close_price = check_price
        pnl_pct = ((close_price - entry) / entry * 100 if side == "long"
                   else (entry - close_price) / entry * 100)
        opened_at = ms_to_iso(self.rsi_paper_entry_ms)
        await self.sb("POST", "lighter_btc_rsi_paper_trades", {
            "worker_id": cfg.worker_id, "side": side, "entry_price": entry,
            "exit_price": close_price, "pnl_pct": pnl_pct,
            "reason": reason or "REV", "opened_at": opened_at,
        })

        # Same close+reopen shape as the real position: a qualifying opposite signal reopens
        # immediately, regardless of whether this close was TP/SL or a pure reversal.
        if reversal_ready:
            self.rsi_paper_side = signal
            self.rsi_paper_entry = best_ask if signal == "long" else best_bid
            self.rsi_paper_entry_ms = now_ms
        else:
            self.rsi_paper_side = None
            self.rsi_paper_entry = None
            self.rsi_paper_entry_ms = None

        if cfg.schema_has_rsi_paper_test:
            await self.update_state({
                "rsi_paper_side": self.rsi_paper_side,
                "rsi_paper_entry_price": self.rsi_paper_entry,
                "rsi_paper_entry_time": self.rsi_paper_entry_ms,
            })

    # ── One decision cycle ──────────────────────────────────────────────────────────────────
    async def tick(self):
        cfg = self.cfg
        state = await self.get_state()

        if state.get("close_requested"):
            # Dashboard "Close Position" button -- a manual kill switch independent of the
            # enabled toggle (which only blocks new entries, never closes an existing one).
            # Runs before anything else, including the disabled+flat skip below, so it works
            # even on an already-disabled bot -- exactly the state a real incident leaves it
            # in. Keeps retrying next tick (does not clear the flag) until either nothing is
            # left to close or close_all actually confirms flat -- a fire-once attempt would
            # silently give up on exactly the kind of transient failure this button exists for.
            #
            # Backs off between retries (proven necessary 2026-09-24): the first version of
            # this retried every tick with no delay, which hammered a WAF-blocked read hard
            # enough to trigger the exact CAPTCHA block it was trying to work around -- the
            # same failure mode the general tick-error backoff already exists to prevent,
            # just missing here because this path returns before reaching that code.
            if state.get("side") is None:
                await self.update_state({"close_requested": False, "enabled": False})
                self._close_retry_failures = 0
                self._close_retry_next_at = 0.0
                return
            now = time.time()
            if now < self._close_retry_next_at:
                return
            best_bid, best_ask = self.live.best_bid_ask()
            if best_bid is None or best_ask is None:
                await self.log_run("close_requested_no_book", {})
                self._close_retry_failures += 1
                self._close_retry_next_at = now + tick_error_backoff_seconds(self._close_retry_failures)
                return
            closed_ok = await self.close_all("MANUAL_BUTTON", state, state["side"],
                                             state.get("legs") or [], best_bid, best_ask,
                                             self.now_ms(), known_pos=None)
            if closed_ok:
                await self.update_state({"close_requested": False, "enabled": False})
                self._close_retry_failures = 0
                self._close_retry_next_at = 0.0
            else:
                # Measured from AFTER the attempt, not before -- close_all can itself take up
                # to ~1.5s (confirm_fill's own retries), so backing off from the start time
                # would let a slow failure get LESS real delay than a fast one.
                self._close_retry_failures += 1
                self._close_retry_next_at = time.time() + tick_error_backoff_seconds(self._close_retry_failures)
            return

        if not state.get("enabled", True) and state.get("side") is None:
            # Disabled AND flat -- nothing to protect, so don't hit the REST position endpoint
            # at all. Proven necessary 2026-09-23: two disabled, already-flat workers kept
            # hammering a WAF-blocked endpoint once per tick for no reason, which both wastes
            # the retry budget and likely makes an IP-level block look more abusive, not less.
            return

        entry_signal, reversal_signal, candle_ts = self.compute_stoch_signal()
        now_open = self.candles[-1]["o"] if self.candles else None
        if candle_ts is None or now_open is None:
            return
        # Captured before any gate below touches entry_signal/reversal_signal -- the paper
        # shadow always sees the plain, ungated signal, regardless of what else is layered on.
        paper_entry_signal, paper_reversal_signal = entry_signal, reversal_signal

        if cfg.pure_trend_fade:
            # No stochastic entries at all -- ER is the only signal, and it drives entry
            # only. Exit is TP/SL exclusively (reversal_signal stays None permanently).
            entry_signal, reversal_signal = None, None

        is_trending = False
        if cfg.er_period and cfg.er_max is not None:
            er, trend_dir = compute_er_and_direction(self.candles, cfg.er_period)
            is_trending = er is not None and er > cfg.er_max
            if trend_dir is not None and cfg.trend_invert_direction:
                trend_dir = "short" if trend_dir == "long" else "long"
            if cfg.pure_trend_fade:
                if is_trending:
                    entry_signal = trend_dir
                # reversal_signal is never set here -- pure_trend_fade only exits via TP/SL.
            elif is_trending and cfg.trend_tp_pct is not None:
                # Regime switch: don't fade a real trend, ride it instead -- with the
                # trend leg's own (usually wider) TP/SL, applied below at entry time.
                entry_signal = trend_dir
                reversal_signal = trend_dir
            elif is_trending:
                entry_signal = None  # no trend-follow config -- old block-only behavior

        if cfg.session_drawdown_stop_pct is not None:
            entry_signal = await self._apply_session_breaker(state, entry_signal)

        if cfg.entry_vol_pause_at_pct is not None:
            entry_signal = await self._apply_entry_volatility_gate(state, candle_ts, entry_signal)

        if cfg.trading_hours_utc is not None:
            entry_signal = self._apply_trading_hours_gate(entry_signal)

        if cfg.hour_open_requires_paper_tp:
            await self._check_hour_open_confirmation(has_open_position=state.get("side") is not None)
            if self.awaiting_open_confirmation:
                entry_signal = None

        real_pos, collateral = await self.read_position()
        if real_pos is None:
            return

        side = state.get("side")
        legs = state.get("legs") or []

        # Reconcile: something external closed us (OCO, liquidation, manual). Re-verify
        # before trusting it -- acting on a single stale read is what corrupted PnL before.
        if side is not None and abs(real_pos) < QTY_EPS:
            real_pos, collateral, confirmed_flat = await self.confirm_fill(
                want_nonzero=False, tries=2, delay=0.8)
        else:
            confirmed_flat = False
        # Only book an external close when REST agrees we are actually flat. If it disagrees,
        # real_pos/collateral now hold the authoritative reading, so fall through and manage
        # the position normally -- returning here instead is what left three live positions
        # with no TP or SL running on 2026-09-22.
        if side is not None and confirmed_flat:
            prior = state.get("collateral_before_entry")
            pnl = (collateral - prior) if (prior is not None and collateral is not None) else 0.0
            ae = avg_entry(legs) or state.get("first_entry_price")
            qty = total_qty(legs) or 0.0001
            implied_exit = (ae + pnl / qty) if side == "long" else (ae - pnl / qty)
            ext_patch = {"side": None, "legs": [], "first_entry_price": None,
                        "first_entry_time": None, "dca_level": 0,
                        "realized_pnl_usd": state["realized_pnl_usd"] + pnl}
            if cfg.schema_has_position_bands:
                ext_patch["position_tp_pct"] = None
                ext_patch["position_sl_pct"] = None
            await self.update_state(ext_patch)
            await self.log_trade(side, ae, implied_exit, qty, pnl, "EXTERNAL", len(legs),
                                 ms_to_iso(state.get("first_entry_time")))
            await self.log_run("resolved_externally", {"side": side, "pnl": pnl})
            state["realized_pnl_usd"] += pnl
            side, legs = None, []

        # Resync: real position open but a different size than tracked.
        tracked = total_qty(legs) if legs else 0.0
        if side is not None and abs(real_pos) > QTY_EPS and tracked > 0:
            same_direction = (real_pos > 0) == (side == "long")
            mismatch = abs(abs(real_pos) - tracked) / tracked
            if same_direction and mismatch > OVERSIZE_FACTOR - 1.0:
                await self.emergency_flatten("tracked_size_mismatch", {
                    "side": side, "tracked_qty": tracked, "real_qty": abs(real_pos),
                    "mismatch_pct": mismatch,
                })
                return
            if same_direction and mismatch > 0.02:
                ae = avg_entry(legs)
                legs = [{"price": ae, "usd_size": ae * abs(real_pos)}]
                await self.update_state({"legs": legs})
                await self.log_run("qty_resynced", {"side": side, "tracked_qty_before": tracked,
                                                    "real_qty": abs(real_pos),
                                                    "mismatch_pct": mismatch})

        best_bid, best_ask = self.live.best_bid_ask()
        if best_bid is None or best_ask is None:
            return

        if cfg.rsi_paper_test_enabled:
            await self._update_rsi_paper_shadow(state, best_bid, best_ask, self.now_ms())

        if cfg.self_lock_enabled:
            await self._update_paper_shadow(state, paper_entry_signal, paper_reversal_signal,
                                            best_bid, best_ask, self.now_ms())
            # Same tick the unlock happens: if a signal is already live, real trading fires on
            # it immediately, not on a delay -- only gates when still locked right now.
            if self.real_trading_locked:
                entry_signal = None

        if side is not None:
            if cfg.trend_tp_pct is not None and reversal_signal == side:
                # Already positioned the way the current regime wants (no reversal trade
                # needed this tick) -- but the regime may have changed SINCE entry (e.g. a
                # position opened during chop is now sitting in a real trend, or vice
                # versa). Keep its TP/SL synced to the regime that's true right now rather
                # than frozen at whatever was true at entry -- otherwise a trend-aligned
                # position keeps running on the tight fade SL instead of the wider band
                # built to tolerate normal trend volatility.
                target_tp = cfg.trend_tp_pct if is_trending else cfg.tp_pct
                target_sl = cfg.trend_sl_pct if is_trending else cfg.sl_pct
                if state.get("position_tp_pct") != target_tp or state.get("position_sl_pct") != target_sl:
                    await self.update_state({"position_tp_pct": target_tp, "position_sl_pct": target_sl})
                    state["position_tp_pct"] = target_tp
                    state["position_sl_pct"] = target_sl
            ae = avg_entry(legs)
            # Each position keeps the TP/SL it was actually entered with (fade vs trend
            # can differ) -- falls back to the bot's default when nothing was recorded
            # (plain fade-only bots, or a position adopted from an unknown origin).
            pos_tp = state.get("position_tp_pct")
            pos_sl = state.get("position_sl_pct")
            pos_tp = pos_tp if pos_tp is not None else cfg.tp_pct
            pos_sl = pos_sl if pos_sl is not None else cfg.sl_pct
            tp = round_trigger(ae * (1 + pos_tp / 100 if side == "long" else 1 - pos_tp / 100),
                               up=(side == "long"))
            sl = round_trigger(state["first_entry_price"] * (1 - pos_sl / 100 if side == "long"
                                                             else 1 + pos_sl / 100),
                               up=(side != "long"))
            check_price = best_bid if side == "long" else best_ask
            gap_hit = None
            if side == "long":
                if check_price <= sl:
                    gap_hit = "SL"
                elif check_price >= tp:
                    gap_hit = "TP"
            else:
                if check_price >= sl:
                    gap_hit = "SL"
                elif check_price <= tp:
                    gap_hit = "TP"

            reversal_ready = reversal_signal is not None and reversal_signal != side
            if reversal_ready and cfg.reversal_guard_seconds:
                entry_time = state.get("first_entry_time")
                age_s = (self.now_ms() - entry_time) / 1000 if entry_time is not None else None
                reversal_ready = age_s is not None and age_s >= cfg.reversal_guard_seconds

            if gap_hit:
                closed_ok = await self.close_all(gap_hit, state, side, legs, best_bid, best_ask,
                                                 candle_ts, known_pos=real_pos)
                if closed_ok and gap_hit == "SL" and cfg.self_lock_enabled:
                    await self._lock_real_trading()
            elif reversal_ready:
                closed_ok = await self.close_all("REVERSAL", state, side, legs,
                                                 best_bid, best_ask, candle_ts,
                                                 known_pos=real_pos)
                if not closed_ok:
                    return
                fresh = await self.get_state()
                fail_count = fresh.get("consecutive_entry_failures", 0) or 0
                eq = fresh["seed_usd"] + fresh["realized_pnl_usd"]
                if not fresh.get("enabled"):
                    return
                if fail_count >= 3:
                    await self.log_run("entry_circuit_breaker",
                                       {"signal": reversal_signal, "fail_count": fail_count,
                                        "via": "reversal"})
                    await self.update_state({"enabled": False})
                    return
                if eq <= 0:
                    await self.log_run("equity_non_positive", {"eq": eq, "via": "reversal"})
                    await self.update_state({"enabled": False})
                    return
                if (self.entry_vol_paused or (cfg.self_lock_enabled and self.real_trading_locked)
                        or (cfg.trading_hours_utc is not None
                            and self._apply_trading_hours_gate(reversal_signal) is None)
                        or (cfg.hour_open_requires_paper_tp and self.awaiting_open_confirmation)):
                    # Close leg of a reversal always runs (already happened above); only the
                    # reopen leg respects the gate -- left flat until it clears instead of
                    # immediately flipping into the opposite side.
                    await self.update_state({"last_processed_candle_ts": candle_ts})
                    return
                price = best_ask if reversal_signal == "long" else best_bid
                await self.try_enter(reversal_signal, price, eq, "reversal", candle_ts,
                                     fresh, collateral, is_trending=is_trending)
            else:
                await self.update_state({"last_processed_candle_ts": candle_ts})
        else:
            if abs(real_pos) > QTY_EPS:
                adopted = "long" if real_pos > 0 else "short"
                price = best_ask if adopted == "long" else best_bid
                await self.update_state({
                    "side": adopted, "legs": [{"price": price, "usd_size": price * abs(real_pos)}],
                    "first_entry_price": price, "first_entry_time": self.now_ms(),
                    "dca_level": 0, "collateral_before_entry": collateral,
                    "last_processed_candle_ts": candle_ts})
                await self.log_run("adopted_orphan_position", {"side": adopted, "qty": abs(real_pos)})
            elif entry_signal is not None and state.get("enabled"):
                fail_count = state.get("consecutive_entry_failures", 0) or 0
                if fail_count >= 3:
                    # Hard stop rather than another retry -- unbounded retries are what
                    # stacked 19 real orders into one position on 2026-09-21.
                    await self.log_run("entry_circuit_breaker",
                                       {"signal": entry_signal, "fail_count": fail_count})
                    await self.update_state({"enabled": False,
                                             "last_processed_candle_ts": candle_ts})
                    return
                eq = state["seed_usd"] + state["realized_pnl_usd"]
                if eq <= 0:
                    await self.log_run("equity_non_positive", {"eq": eq})
                    await self.update_state({"enabled": False,
                                             "last_processed_candle_ts": candle_ts})
                    return
                price = best_ask if entry_signal == "long" else best_bid
                await self.try_enter(entry_signal, price, eq, "entry", candle_ts,
                                     state, collateral, is_trending=is_trending)
            else:
                await self.update_state({"last_processed_candle_ts": candle_ts})

    async def heartbeat(self):
        now = time.time()
        if now - self.last_heartbeat < HEARTBEAT_EVERY:
            return
        self.last_heartbeat = now
        await self.log_run("heartbeat", {
            "ob_age": round(now - self.live.ob_updated_at, 1),
            "acct_age": round(now - self.live.acct_updated_at, 1),
            "candle_age": round(now - self.candles_updated_at, 1),
            "ticks": self.ticks,
        })

    async def run(self):
        cfg = self.cfg
        # Python block-buffers stdout when it is not a TTY, so on Render every print() was
        # sitting in a buffer that never flushed -- which is why the service looked like it
        # emitted no runtime logs at all and every hang had to be diagnosed blind.
        sys.stdout.reconfigure(line_buffering=True)
        sys.stderr.reconfigure(line_buffering=True)
        print(f"Stochastic bot [{cfg.name}] starting (BTC, real money) [WebSocket-based]",
              flush=True)
        self.account_index = int(os.environ["LIGHTER_ACCOUNT_INDEX"])
        self.http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=SB_TIMEOUT))
        self.client = lighter.SignerClient(
            url="https://mainnet.zklighter.elliot.ai", account_index=self.account_index,
            api_private_keys={int(os.environ["LIGHTER_API_KEY_INDEX"]):
                              os.environ["LIGHTER_API_PRIVATE_KEY"]},
        )
        self.live = LiveState(self.account_index, cfg.market_index)

        ws_task = asyncio.create_task(self.run_ws_forever())
        candle_task = asyncio.create_task(self.run_candle_refresh_forever())
        tick_log_task = asyncio.create_task(self.run_tick_logger_forever())

        print("Waiting for initial WebSocket data...", flush=True)
        for _ in range(40):
            if self.live.book_fresh() and self.candles:
                break
            await asyncio.sleep(0.5)
        ready = self.live.book_fresh()
        print(f"WS ready: {ready}", flush=True)
        await self.log_run("started", {"ws_ready": ready, "mode": "websocket",
                                       "window": cfg.stoch_window, "tp": cfg.tp_pct,
                                       "sl": cfg.sl_pct, "er": cfg.er_period})
        self.last_heartbeat = time.time()

        consecutive_errors = 0
        try:
            while True:
                try:
                    # Hard ceiling. Without this a single hung REST call could freeze the
                    # whole bot for 20+ minutes with an open position and no SL running.
                    await asyncio.wait_for(self.tick(), timeout=TICK_WATCHDOG)
                    self.ticks += 1
                    consecutive_errors = 0
                    await self.heartbeat()
                    await asyncio.sleep(cfg.tick_seconds)
                except asyncio.TimeoutError:
                    await self.log_run("tick_watchdog_timeout", {"limit_s": TICK_WATCHDOG})
                    await asyncio.sleep(1.0)
                except Exception as e:
                    print(f"tick error: {e}", flush=True)
                    consecutive_errors += 1
                    try:
                        await self.log_run("error", {"error": str(e)[:400],
                                                      "consecutive": consecutive_errors})
                    except Exception:
                        pass
                    # Exponential backoff instead of a flat 1s retry -- proven necessary
                    # 2026-09-23: two workers hammered a WAF-blocked endpoint once a second
                    # for minutes straight, which both burns the retry budget for nothing and
                    # looks more like abusive traffic to whatever is doing the blocking, not
                    # less. Caps at 60s so a real transient blip still recovers reasonably fast.
                    backoff = tick_error_backoff_seconds(consecutive_errors)
                    await asyncio.sleep(backoff)
        finally:
            ws_task.cancel()
            candle_task.cancel()
            tick_log_task.cancel()
            with contextlib.suppress(BaseException):
                await self.client.api_client.close()
            with contextlib.suppress(BaseException):
                await self.http.close()


def run_bot(cfg: BotConfig):
    asyncio.run(StochBot(cfg).run())
