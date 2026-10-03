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
import math
import os
import sys
import time
import uuid
import json as jsonlib
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional, Union

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
# Single-instance lock (2026-09-30). Render does NOT stop the old container before starting the
# new one, so on every deploy two copies of a worker are alive together for ~30-60s and both can
# independently decide to place a real entry -- the "zombie double-entry" incident. A process only
# takes real entries while it holds the lock on its own state row.
#
# LOCK_REFRESH_EVERY is deliberately its OWN timer and not HEARTBEAT_EVERY (300s): a stale
# threshold has to sit above the refresh interval, and hanging the lock off the 5-minute heartbeat
# would mean a dead instance kept the lock for over 5 minutes -- long enough for a deploy to be
# fully unable to trade. CLAUDE.md records a real crash-loop from setting these too CLOSE together
# (every fresh instance saw the just-killed one's heartbeat as still fresh and refused to start),
# so the ratio here is deliberately wide: refresh 4x more often than the staleness limit.
LOCK_REFRESH_EVERY = 5.0
LOCK_STALE_AFTER = 20.0
# Hedge cycle barrier (2026-09-30). How long a leg's "I am ready to enter" declaration stays
# valid, and how long a granted clearance stays usable. Both are re-declared every tick (0.5s),
# so these only need to outlive a few ticks -- short enough that a leg which stops wanting to
# enter (disabled, lost the instance lock, signal gone) drops out on its own within a couple of
# seconds instead of making its partner wait on a declaration it no longer means.
CYCLE_READY_TTL = 3.0
CYCLE_CLEARED_TTL = 5.0
# Emergency-flatten response (2026-09-30). A first oversize is treated as a transient: flatten,
# then pause entries for the cooldown so both legs resume together. Only a repeat within the
# window is treated as systematic and hard-disables the leg. Permanently disabling on the first
# one halted the strategy on a self-correcting bad read, and did it asymmetrically -- one leg off,
# its partner still on and waiting forever.
EMERGENCY_COOLDOWN = 60.0
EMERGENCY_REPEAT_WINDOW = 3600.0
EMERGENCY_REPEAT_LIMIT = 3
POSITION_TTL = 3.0        # cache the REST position read this long (~0.33 req/s, vs the
                          # 6 req/s polling that caused the original rate-limit storm)
AUTH_TOKEN_LIFETIME_S = 10 * 60  # SDK's create_auth_token_with_expiry default validity
AUTH_TOKEN_REFRESH_MARGIN_S = 60.0  # regenerate this long before actual expiry
TICK_LOG_EVERY = 2.5      # seconds between price-tick log rows (candle-vs-real-trade check
                          # on 2026-09-22 showed 1-min candles are too coarse to backtest
                          # against; this records the real book for a proper replay later)
TICK_LOG_RETENTION_DAYS = 14
TRADE_FLOW_LOG_EVERY = 30.0  # seconds between recentTrades polls -- raised from 3.0 2026-09-27
                              # after that rate triggered a WAF block, then from 10.0 to 30.0
                              # 2026-09-29 after Worker 3 (using this cadence via the unified
                              # market-data logger) started getting intermittently WAF-blocked
                              # again on this + position reads + candle fetches, while Worker 1
                              # (which doesn't poll recentTrades at all) showed zero blocks in
                              # the same window -- the flow entry filter that used to need a
                              # tighter cadence here is off on all 3 bots now (flow_entry_filter_
                              # enabled=False everywhere), so nothing live depends on this being
                              # fast; it only feeds the market-data table for offline analysis.
TRADE_FLOW_LOG_RETENTION_DAYS = 14
MARKET_DATA_BOOK_EVERY = 2.0  # order-book snapshots cost nothing extra (already in memory via
                              # the websocket) -- can log much faster than the tick logger did
MARKET_DATA_RETENTION_DAYS = 14

QTY_EPS = 1e-6
OVERSIZE_FACTOR = 1.5     # real position this much bigger than intended => emergency flatten
# IOC execution band for a native stop order, past the trigger (see _sync_native_stop). Wide on
# purpose: a tight band here could let the stop trigger and then fail to fill in exactly the
# fast move it exists to protect against, which is worse than not having it at all.
NATIVE_STOP_BAND_PCT = 0.3

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
    # Intrabar dispersion gate (2026-10-01, direct request, isolated test): blocks new entries
    # (and a reversal's reopen leg, never TP/SL/exits -- same risk-management carve-out as every
    # other entry gate above) whenever compute_intrabar_dispersion() reads at or above this
    # threshold. Deliberately a single hard cutoff, no pause/resume hysteresis pair like the
    # true-range gate above -- this is a clean, isolated A/B test of ONE filter, re-evaluated
    # fresh every tick with no persisted state at all (the measure itself has no memory to lose
    # on a restart, unlike the gates above). None = disabled. See
    # compute_intrabar_dispersion's docstring for the real-data backing.
    intrabar_dispersion_pause_at: Optional[float] = None
    intrabar_dispersion_window: int = 5
    # Zebra / candle-size index gate (2026-10-01, direct request). compute_zebra_size_index():
    # zebra % (color switches between consecutive closed 1-min candles / possible switches x 100)
    # divided by the mean candle size % ((high-low)/close x 100), over zebra_index_window closed
    # candles. Low = one-directional and/or big candles (a real move the stochastic fade gets run
    # over by); very high = tiny choppy candles (too little movement to reach the profit lock).
    # New entries (and a reversal's reopen leg) are allowed only while the index is inside
    # [zebra_index_min, zebra_index_max]; exits are never gated. Backing: 604 real Worker 1
    # trades, index quintiles low->high totalled -$2.00 / +$0.22 / +$1.21 / +$0.14 / -$0.91 --
    # a hill, best in the middle; borderline significance (z +1.3 / +2.2), chosen deliberately
    # narrow by the user. None = no bound on that side.
    zebra_index_min: Optional[float] = None
    zebra_index_max: Optional[float] = None
    zebra_index_window: int = 5
    # Color-weighted balance index gate (2026-10-01, direct request -- v2 of the zebra idea after
    # backtesting showed switch-counting was fooled by a single counter-direction candle). Each of
    # the trailing color_balance_index_window CLOSED candles casts a vote of its own color
    # (+1 green, -1 red, 0 doji) weighted by its own (high-low)/close% size; balance = (1 -
    # |sum(size*color)/sum(size)|) x 100. 100 = perfectly balanced (good fade conditions), 0 = one
    # color dominates in both count AND size (a real trend). A single stray candle only partially
    # offsets the vote instead of counting as a full "switch". Same entry-only gate shape as
    # zebra_index_min/max -- out of [min, max] blocks a fresh entry and a reversal's reopen leg,
    # never an exit. Backing: 605 real Worker 1 trades replayed through today's exits, rolling
    # window: a plateau at index 65-78 (up to +$0.017/trade, 74% win), a sharp drop after 78.
    # Deliberately narrower than the plateau (65-75) to sit inside it, not right at the cliff edge.
    color_balance_index_min: Optional[float] = None
    color_balance_index_max: Optional[float] = None
    color_balance_index_window: int = 5
    # 2026-10-01, direct request: Worker 2's version of the same index, INVERTED -- enter OUTSIDE
    # [color_balance_index_min, color_balance_index_max] instead of inside it (the reverse of
    # Worker 1's 65-75 band: blocked INSIDE the band, allowed when below the floor OR above the
    # ceiling). False (default) keeps the normal inside-the-band gate everyone else uses.
    color_balance_index_invert: bool = False
    # Entry-feature snapshot (2026-10-01, direct request): on every entry, record what each
    # live index read at that exact moment -- stochastic K, the color-weighted balance index,
    # 10-min volatility, and 5-bar dispersion -- onto the state row, then carry them onto the
    # trade row when the position closes. Purely descriptive: drives no decision, just lets
    # completed trades be reviewed by hand (hover on the dashboard) for a pattern across these
    # indices, e.g. which part of the day a given exit setting stops working. Independent of
    # whether any of these indices actually gate entry for this bot.
    schema_has_entry_features: bool = False
    # Post-reversal cooldown (2026-10-01, direct request): after a position closes via REVERSAL
    # specifically (never SL/TP/PROFIT_LOCK/BREAKEVEN_LOCK), block any new entry -- fresh or
    # another reversal reopen -- for this many seconds. The reversal mechanism itself is
    # untouched (it still closes and flips immediately when the signal demands it); this only
    # pauses what happens AFTER. Direct motivation: three real flips in 16 minutes (long ->
    # short reversal -> flat 10min -> long again), the third one a plain loss -- "the reversal
    # was not the problem... the problem was going in again without resting." In-process only,
    # not persisted (a restart clears it, same tradeoff as every other in-process-only gate).
    # None = off (default, no other bot is affected).
    post_reversal_cooldown_seconds: Optional[float] = None
    # Index-exit-on-green (2026-10-01, direct request): "call a reversal" -- exit immediately --
    # the moment the color-weighted balance index goes OUTSIDE [color_balance_index_min,
    # color_balance_index_max] (the same band gating entry), but ONLY while the position is
    # currently GREEN (unrealized > 0). A red position is never touched by this -- it still
    # rides out to its own SL/saving-lock exactly as before. Reasoning: the index described the
    # conditions this entry was taken IN; if those conditions have genuinely changed while
    # sitting on a profit, bank it now rather than hope the original read still holds. A missing
    # reading (too few candles) never forces an exit -- only an actual out-of-band value does.
    # Requires color_balance_index_min and/or color_balance_index_max to be set; a no-op
    # otherwise. Reason logged as INDEX_EXIT. False = off (default).
    index_exit_on_green: bool = False
    # Volume regime switch (2026-10-02, direct request): below this traded-volume threshold
    # (compute_candle_volume_avg, BTC size -- not a vol_pct/volatility reading), run the normal
    # signal configured above (stochastic, with whatever zebra/color-balance band gates it)
    # completely unchanged. At or above it, switch ENTIRELY to compute_flip_signal() instead,
    # and skip the zebra/color-balance gates for that entry -- they were tuned for the
    # stochastic signal, not this one. Direct motivation: live and backtested evidence that the
    # stochastic+zebra combo's edge is real at low/normal volume but is statistically
    # indistinguishable from a coin flip (z<1 on 600+ trades) well before that, and provably
    # bad at the extreme top of the traded-volume range. None = off (default, no other bot
    # affected -- every other BotConfig field below is a no-op without this one set).
    volume_regime_switch_threshold: Optional[float] = None
    volume_regime_switch_window: int = 10
    flip_signal_min_trend_len: int = 3
    # Off by default -- see compute_flip_signal's docstring. Kept live, not deleted: re-enable
    # (and re-measure) if the plain flip signal stops working, rather than starting over.
    flip_signal_min_size_pct: Optional[float] = None
    # Direct request, 2026-10-02, after a real live loss flipped on a near-doji ($0.80 body on
    # an $84,314 price). Requires the INTERRUPTING candle's own body -- not the streak -- to
    # clear this floor. See compute_flip_signal's docstring for the moderate-cutoff reasoning.
    flip_signal_min_body_pct: Optional[float] = None
    # Direct request, 2026-10-02 ("give me control of the signals"): live on/off toggles for
    # the stochastic regime, the zebra/color-balance band, and the flip regime, plus a live
    # override for the volume switch threshold itself -- see _regime_controls. False (default)
    # means every other bot is unaffected; reads are always safe even before the migration
    # (state.get on a missing column just returns None), only a write would need the gate.
    schema_has_regime_overrides: bool = False
    # Volume-jump guard (2026-10-02, direct request, "this cannot happen" after a real live
    # loss traced to a single outlier candle distorting the 5-bar stochastic -- see
    # compute_volume_jump_ratio's docstring for the full incident and the data behind the
    # 3.0/120s defaults below). When the most recent closed candle's own volume is
    # >= volume_jump_ratio times its own trailing baseline, ALL new entries (both regimes) and
    # reversal reopens are paused for volume_jump_pause_seconds -- never blocks an exit,
    # same contract as every other gate in this file. None = off (default, no other bot
    # affected). Live-overridable the same way as the regime controls -- see
    # _volume_jump_controls, BotConfig.schema_has_regime_overrides (same schema flag, same
    # override-columns-are-safe-to-read-before-migration reasoning).
    volume_jump_ratio: Optional[float] = None
    volume_jump_lookback: int = 10
    volume_jump_pause_seconds: float = 120.0
    # Early-release arm (2026-10-03, direct request: "build them both... which one is
    # controlling? either volume, wiggle, or rate"). None (default) keeps pause_seconds a plain
    # fixed timer, unchanged behavior. "volume" / "wiggle" / "rate" lets the pause end EARLY --
    # never late, pause_seconds stays the hard cap either way -- once that one metric has
    # decayed to half or less of its own peak since the spike armed. See
    # _update_volume_jump_guard's docstring for the full reasoning and research/wiggle-2026-10-03
    # for the real-data comparison (wiggle and volume revert at roughly the same real-world
    # speed; neither is clearly better, which is why the user wanted all three built and
    # selectable rather than picking one blind).
    volume_jump_release_mode: Optional[str] = None
    wiggle_window: int = 5
    # Low-volatility entry gate (2026-09-29, direct request): the OPPOSITE direction from the
    # pair above -- blocks new entries (and a reversal's reopen leg, never TP/SL/exits) when
    # the market is TOO QUIET rather than too spiky. Built to test a real finding from 844 real
    # trades across Worker 1 + Worker 3: below 0.06% vol_pct, combined net was -$3.29 (597
    # trades, 61% win); at or above 0.06%, +$1.67 (247 trades, also 61% win) -- same win rate
    # either side, but the dollar edge per trade flips sign at this exact cutoff, independently
    # on both bots. Uses the SAME vol_pct measure as joint-adaptive (_measure_vol_pct, mean
    # (high-low)/close% over the trailing min_vol_pct_lookback CLOSED candles) so this is a
    # faithful live test of that exact finding, not an approximation. Stateless (no pause/resume
    # hysteresis like the high-vol gate above needs) -- just checks live vol_pct every tick, so
    # no migration or restart-survival concern. None disables this gate entirely.
    min_vol_pct_to_trade: Optional[float] = None
    min_vol_pct_lookback: int = 30
    schema_has_min_vol_gate: bool = False  # requires the min_vol_pct_last column migration
    # Entry-side book confirmation cap (2026-09-29): see _entry_overconfirmed's docstring for
    # the retrospective test. Blocks a new entry OR a reversal's reopen leg (never an exit) when
    # the near-touch book is already more than this fraction stacked in the entry's own
    # direction. None disables this gate entirely.
    entry_confirmation_max_pct: Optional[float] = None
    schema_has_entry_confirmation: bool = False  # requires the entry_confirmation_last column migration
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
    # 2026-09-28, direct request: 2 winning paper closes aren't enough to unlock on their own if
    # NEITHER of them was a literal TP -- e.g. two REVERSAL/PROFIT_LOCK/STOCH_TURN wins in a row
    # don't satisfy this alone. The streak keeps extending past 2 (doesn't reset) until a
    # literal TP appears somewhere in it; unlocks the moment both "2+ wins" and "a TP happened"
    # are true together. Only a real loss (SL) resets it.
    self_lock_require_tp_in_streak: bool = False
    # 2026-09-28, same day: escape hatch on the rule above -- direct request after watching a
    # real 7-win streak with zero SL stay locked out the whole time because none of the 7 was a
    # literal TP. If the streak reaches this many wins (any kind), unlock anyway, even with no
    # TP yet -- a long enough streak is its own evidence. None = no fallback, waits for a TP
    # indefinitely (the original 2026-09-28 behavior).
    self_lock_no_tp_fallback_wins: Optional[int] = None
    # 2026-09-29, direct request: a single literal TP unlocks real trading immediately, with
    # NO streak-count requirement -- bypasses the normal >=2-wins floor entirely. Only a
    # literal TP close triggers this (reason == "TP" specifically); PROFIT_LOCK/REVERSAL/
    # STOCH_TURN wins still need the ordinary 2-in-a-row path. An OR on top of whatever
    # self_lock_require_tp_in_streak/self_lock_no_tp_fallback_wins already allow, not a
    # replacement for them.
    self_lock_tp_unlocks_instantly: bool = False
    # 2026-10-01, direct request after the timing audit: scoped version of
    # self_lock_require_tp_in_streak -- ONLY tightens the unlock bar for a lock whose CAUSE was
    # an hour-open relock (_check_hour_open_confirmation, via="hour_open"), not an ordinary
    # real-SL lock. Real data showed exactly this gap live: 09:00 UTC force-relocks, two quick
    # REVERSAL wins (not a real TP) satisfied the ordinary "2 wins of any kind" rule 29 minutes
    # later while the market was still choppy, real money unlocked, and the very next trade lost
    # within 3 minutes. Deliberately NOT the same as self_lock_require_tp_in_streak=True
    # globally -- CLAUDE.md is explicit that making a literal TP mandatory everywhere leaves the
    # bot locked out indefinitely on a streak of non-TP greens, which is exactly what this field
    # avoids: ordinary real-SL locks keep the existing "2 wins, any kind" rule untouched, only an
    # hour-open lock demands the stronger proof. self_lock_tp_unlocks_instantly still bypasses
    # this the moment a literal TP actually lands, same as always -- a real TP already satisfies
    # "requires TP" by definition, nothing extra needed there.
    self_lock_hour_open_requires_tp: bool = False
    # 2026-09-29, direct request: whenever the bot boots (a restart, which happens on every
    # push -- or the user turning it on) it must go back in locked, requiring the normal unlock
    # proof all over again (2 wins of any kind, or a single literal TP with
    # self_lock_tp_unlocks_instantly) -- never resumes real trading on leftover unlock state
    # from before. Only forces LOCKED, never forces unlocked -- if it was already locked,
    # nothing changes. See _force_relock's docstring.
    self_lock_relocks_on_boot: bool = False
    # 2026-09-28, same day: direct request -- a losing/breakeven non-SL close (a red STOCH_TURN
    # or a losing reversal) was previously neutral, invisible to the counter. Now it cancels out
    # one prior win instead: green, red, green nets to 1, not 2. Only a literal SL still wipes
    # the whole streak to zero -- "stop loss is the worst." If the decrement brings the counter
    # to 0, paper_streak_has_tp clears too (equivalent to a fresh start).
    self_lock_loss_decrements_streak: bool = False
    # Fresh-signal requirement (2026-09-28, direct request, empirically motivated): real data
    # showed entries taken when the signal had already been active for 2+ candles won
    # noticeably less often (43% win, net losing) than entries on a genuinely fresh flip (65%
    # win). Requires the signal to have JUST appeared -- not already been true one candle
    # earlier -- for BOTH a fresh entry and a reversal's reopen leg (never blocks an exit,
    # only a new commitment). See _prior_candle_signal's docstring for how "one candle earlier"
    # is computed (reuses the real signal function, not a reimplementation).
    require_fresh_signal: bool = False
    # Trading-hours schedule (2026-09-24, Worker 1 -- stacked on top of its existing session
    # breaker, not a replacement). Set of UTC hours (0-23) during which NEW entries (and the
    # reopening leg of a reversal) are allowed; every other hour blocks new entries the same
    # way the session breaker and entry-vol gate do -- TP/SL/reversal-close on an existing
    # position are never gated by this, only new/reopening entries. None = disabled (every
    # other bot). Stateless by design: just checks the wall-clock UTC hour each tick, so it
    # needs no persistence/migration and can't be wiped by a restart. Built from 908 real
    # Worker 2 trades bucketed by UTC close-hour (2026-09-22 to 2026-09-24): these are every
    # hour where that real data came out net positive.
    #
    # Also accepts a dict instead of a list (2026-09-26), for when the open hours need to
    # differ by day -- a flat list has no concept of which day it is, so it can't express
    # "close this hour only on Saturdays" without also closing it every other day. Dict form:
    # {weekday: [utc_hours]}, weekday per Python's datetime.weekday() (Monday=0 ... Sunday=6).
    # Any weekday not present in the dict has no open hours at all that day. Watch the UTC/ET
    # day-boundary crossing when picking values: an ET evening event can land on the NEXT day
    # in UTC (e.g. Sunday 9pm ET is already Monday 01:00 UTC).
    trading_hours_utc: Optional[Union[list, dict]] = None
    # Hour-open confirmation (2026-09-25, redefined 2026-09-28). "Don't assume the hour is good
    # just because the schedule says so": the instant a scheduled hour opens (closed->open
    # transition, including right after a restart if the bot boots mid-open-hour -- a restart
    # has no fresher evidence than a real transition would), real entries re-lock behind the
    # EXACT SAME self-lock recovery gate a real SL triggers -- same counter, same
    # self_lock_require_tp_in_streak/self_lock_no_tp_fallback_wins/
    # self_lock_loss_decrements_streak rules, not a separate looser check. Direct request: "the
    # criteria to unlock after a self lock should be the same criteria as when you turn on the
    # bot" -- extended here to also cover an hour reopening, not just a manual toggle. Skips
    # arming entirely if a real position is already open at the transition (nothing "blind"
    # about a position that's already being managed). Only meaningful with both
    # trading_hours_utc and self_lock_enabled set.
    hour_open_requires_self_lock: bool = False
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
    # 2026-09-26 (Worker 1): promotes the RSI-Stoch signal (see
    # compute_rsi_stoch_confirmed_signal) from paper-only to driving REAL entries/reversals --
    # a straight swap of the top-level signal source. Every downstream gate (trading_hours_utc,
    # session breaker, etc.) is unchanged and still applies to whatever this returns. The same
    # value serves both entry and reversal (no separate reversal threshold in this signal, so
    # entry_signal == reversal_signal here, unlike the plain stochastic's separate lo/hi bands).
    use_rsi_stoch_signal: bool = False
    # 2026-10-01 (Worker 1), direct request: swap the top-level signal source from the plain
    # stochastic to a mean-reversion z-score, same straight-swap pattern as use_rsi_stoch_signal
    # above -- every downstream gate (trading_hours_utc, self-lock, session breaker, etc.) is
    # unchanged and still applies to whatever compute_zscore_signal() returns. Ported from
    # backtest/zscore-alone-1yr-tp08-btc.ts, which was long-only on 5-min candles; this is the
    # symmetric fade generalisation (fade long on an oversold extreme, fade short on an
    # overbought one) Worker 1 already uses for its stochastic signal, on 1-min candles per
    # direct request. See compute_zscore_signal's docstring.
    use_zscore_signal: bool = False
    # Rolling window (CLOSED candles) the z-score's mean/stdev are computed over. 5 matches the
    # backtest's ZSCORE_WINDOW exactly.
    zscore_window: int = 5
    # entry_signal="long" when z <= -zscore_entry, "short" when z >= +zscore_entry -- same
    # magnitude both directions and for both entry and reversal (the backtest only ever used one
    # threshold, Z_ENTRY=-2.0, for its one-directional long entry). 2.0 matches that value.
    zscore_entry: float = 2.0
    # False drops the price-confirmation half of the RSI signal (see
    # compute_rsi_stoch_confirmed_signal's docstring for the backtest numbers). Default True
    # keeps the original report's rule intact; only Worker 1's live experiment sets this False.
    rsi_paper_require_confirmation: bool = True
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
    # Trade-flow logging (2026-09-26): same single-writer-with-failover pattern as the tick
    # logger above, but records actual executed trades (size, price, aggressor side) from
    # Lighter's public recentTrades endpoint -- data the tick logger doesn't capture at all.
    # Built toward eventually detecting "the signal is about to be wrong" from real order flow
    # (e.g. a burst of aggressive one-sided taker volume right before a losing reversal) and
    # either pausing entries or flipping the signal -- but that analysis needs real data first;
    # this step only collects it. recentTrades has no historical backfill, so this can only
    # ever see trades from the moment logging starts forward. None = doesn't participate.
    trade_flow_log_defers_to: Optional[list] = None
    trade_flow_log_prune: bool = False
    # Unified market-data logger (2026-09-28, direct request): ONE table, ONE loop, replacing
    # the two loggers above -- full order-book depth (not just best bid/ask) plus executed
    # trade prints, so a future fast-reacting bot has one simple place to read a complete
    # market-data stream from. See run_market_data_logger_forever. None = doesn't participate
    # (the two separate loggers above stay in charge, as before).
    unified_market_data_table: Optional[str] = None
    unified_market_data_prune: bool = False
    # Adaptive V2 signal (2026-09-27): see compute_adaptive_stoch_signal's docstring. False =
    # use compute_stoch_signal (the plain, fixed-window signal) as before.
    use_adaptive_window: bool = False
    adaptive_vol_lookback: int = 30
    adaptive_vol_switch_pct: float = 0.04
    adaptive_quiet_window: int = 15
    adaptive_active_window: int = 5
    # Order-flow entry filter (2026-09-27): an additional veto on NEW entries (and the reopen
    # leg of a reversal) -- never blocks an exit. Requires real trade-flow data
    # (lighter_btc_trade_flow) to be actively logging; if the query returns no data in any of
    # the required windows, the filter denies (fails closed, matching the source report's
    # "otherwise skip"). See _check_flow_entry_filter.
    flow_entry_filter_enabled: bool = False
    flow_max_adverse_move_pct: float = 0.02
    schema_has_adaptive_fields: bool = False  # requires the adaptive_last_* columns migration
    # Profit-lock trail (2026-09-27): once a real position's unrealized profit reaches
    # profit_lock_trigger_pct, arm a peak tracker; the moment unrealized profit ticks down at
    # all from that peak, exit immediately (reason "PROFIT_LOCK") -- doesn't wait for it to
    # give back any specific amount, let alone retrace to the fixed TP or SL. Built after real
    # trades were repeatedly seen running well above this level, then round-tripping all the way
    # back to a real SL. Only ever fires EARLIER than (or instead of) the fixed TP/SL, never
    # blocks them -- if price gaps straight through both bands in one tick, gap_hit (TP/SL) is
    # checked first and still wins.
    profit_lock_enabled: bool = False
    profit_lock_trigger_pct: float = 0.05
    # 2026-09-29, direct request: widens the trail from zero-giveback to a real distance --
    # once armed (peak >= profit_lock_trigger_pct), exits when unrealized profit gives back this
    # much from the peak, not on any tick down at all. 0.0 (default) preserves the exact
    # original zero-giveback behavior (Worker 1's still-live config relies on this default).
    # e.g. trigger=0.02%, trail=0.01% -- arms at +0.02%, exits if it ever pulls back to
    # (peak - 0.01%), worst case a still-positive +0.01% -- "hyper trading": take a small piece
    # of a move and get back out, never turning a real winner into a loss.
    profit_lock_trail_pct: float = 0.0
    # 2026-09-29, direct request: after a PROFIT_LOCK exit, treat the signal the same way a red
    # exit does -- blocked from re-entering (new entry or reversal reopen) until it genuinely
    # changes, even within the same candle. PROFIT_LOCK is always non-negative by construction
    # (see docstring above), so this isn't about avoiding a loss -- it's "take the small win,
    # then wait for a genuinely NEW opportunity" instead of immediately re-chasing the same
    # signal instance that was just harvested. Shares the same self._burned_signal mechanism as
    # red_exit_burns_signal.
    profit_lock_burns_signal: bool = False
    schema_has_profit_lock: bool = False  # requires the profit_lock_peak_pct column migration
    # Breakeven floor (2026-09-30, direct request): for a HEDGE leg only -- once this leg's
    # cycle partner (cycle_partner_table) has closed its own position at a LOSS, this leg's
    # profit must never be allowed to slide back below the level that makes the cycle as a whole
    # break even. Exits with reason "BREAKEVEN_LOCK".
    #
    # Why it exists: the hedge enters both directions at once and cuts the loser at sl_pct, so
    # the cycle's result is (winner's gain - loser's fixed loss). With only profit_lock_trail_pct
    # protecting the winner, a winner that peaked just under profit_lock_trigger_pct had NO
    # protection at all until its own SL -- so a cycle could end with the loser stopped out and
    # the winner also stopped out, two losses from one cycle. The floor closes that gap from the
    # other direction: the moment the loser is banked, the winner has a hard "at least even"
    # exit level.
    #
    # Derived from realized DOLLARS, never a hardcoded percentage: pressure_bias_enabled can size
    # the two legs unequally ($15 vs $5), and +0.03% on a $5 winner does NOT offset -0.03% on a
    # $15 loser (that needs +0.09%). floor_pct = 100 * (-partner_cycle_pnl) / own_notional_usd.
    # With equal $10 legs this lands on ~= sl_pct, which is the intuitive version of the rule.
    #
    # Only arms after this leg has actually traded AT or above the floor -- otherwise a leg that
    # is already below breakeven when the partner closes would be exited instantly, booking a
    # worse result than just letting its own SL run. Fails safe in every other direction too: no
    # partner configured, partner never opened, or partner closed green => no floor, and the leg
    # runs on profit_lock/SL exactly as before. Requires cycle_partner_table.
    # 2026-09-30, direct request, clarifying what the 25/75 stochastic was always for: "if you
    # enter a trade and there is no pressure, how is it going to move? the 25/75 was to enter with
    # pressure." A fixed_direction leg otherwise opens a cycle EVERY time it is flat, including in
    # dead chop where neither side can travel far enough to reach the profit-lock trail and both
    # legs just grind against the spread. With this on, a cycle only opens while the shared
    # stochastic K is actually at an extreme (outside entry_lo/entry_hi) -- i.e. only when there is
    # real pressure behind the move.
    #
    # It gates WHEN, never WHICH WAY: both legs still enter together on both sides, exactly as
    # before. The signal says "there is pressure right now", not "go this way" -- so it is read
    # from the same shared hub both legs already share, which keeps them agreeing on the same
    # reading and keeps the cycle barrier's two legs in step.
    #
    # NOT a size control. An earlier reading of the same request turned it into a $15/$5 leg tilt,
    # which was never asked for -- see lighter_hedge_dual_leg.py's Sizing section.
    require_pressure_to_enter: bool = False
    # Optional environment permission for NEW paired cycles, independent of entry direction.
    # Below pause => red; at/above resume => green; middle holds the previous state.
    environment_entry_gate_enabled: bool = True  # False keeps monitoring without blocking entries.
    environment_er_pause_below: Optional[float] = None
    environment_er_resume_at: float = 0.25
    environment_er_window: int = 15
    environment_signal_owner: bool = True
    environment_vol_max_pct: Optional[float] = None
    environment_vol_window: int = 10
    breakeven_floor_enabled: bool = False
    # Optional fixed winning-leg profit floor, in percentage points from its entry.
    # None keeps the partner-loss-derived breakeven floor. A fixed level may leave
    # the combined hedge at a loss; it only activates after the partner closes red.
    fixed_partner_cut_floor_pct: Optional[float] = None
    # How far ABOVE the computed floor this leg must trade before the floor goes live. Must be
    # > 0: in a symmetric hedge the winner is already sitting at the floor the instant the loser is
    # cut, so a floor armed at 0.0 margin fires on the next tick of noise and pins every cycle to
    # exactly zero (observed live 2026-09-30). Defaults to the profit-lock trail width when left
    # at None, which reproduces the rule as stated -- "at 0.04, lock 0.03" for a 0.03% cut and a
    # 0.01% trail.
    breakeven_floor_arm_margin_pct: float = 0.01
    # requires the cycle_partner_pnl_baseline column migration -- persistence only, the
    # in-process copy is authoritative (same arrangement as profit_lock_peak_pct)
    schema_has_breakeven_floor: bool = False
    # 2026-10-01, direct request, replaces the margin-gated floor/BREAKEVEN_LOCK exit above with
    # the ordinary profit-lock trail, started the instant the partner is confirmed cut at a loss
    # instead of only once profit_lock_trigger_pct is reached. Still requires
    # breakeven_floor_enabled (reuses its partner-cut detection) -- this only changes what happens
    # once that detection fires. Real data showed a winner can reach a meaningful gain (+0.055%)
    # and give all of it back with ZERO protection, because it never cleared the floor's own
    # margin (arm_at = floor_pct + margin) -- the gap this closes is between "partner just got
    # cut" and "profit_lock_trigger_pct reached", where the old design offered nothing. Same
    # trail_pct buffer as always, so ordinary noise still can't scalp it -- this changes WHEN
    # the trail starts watching, not how tight it is. Exits here read "PROFIT_LOCK", not
    # "BREAKEVEN_LOCK" -- it genuinely is the trail now, just started earlier.
    partner_cut_arms_trail_immediately: bool = False
    # 2026-10-01, direct request ("Option B"): once the partner is cut and the breakeven floor is
    # known, the profit-lock trail may never close this leg BELOW that floor. The exit level is
    # max(peak - trail, floor) instead of just peak - trail. Live data the same day: with the
    # trail armed at the partner-cut instant (winner ~+0.05%) and a 0.04% trail, the winner exited
    # at ~+0.01% -- under breakeven, so every such cycle lost, and once (winner only +0.03% at the
    # cut) a "PROFIT_LOCK" closed at an outright loss. With this on, a cycle whose winner never
    # runs ends at ~$0 (reason BREAKEVEN_LOCK); one that runs past floor + trail is still ridden
    # by the trail (reason PROFIT_LOCK). Needs breakeven_floor_enabled. False = old behaviour.
    profit_lock_respects_breakeven_floor: bool = False
    # 2026-10-01, direct request ("saving lock"): rescue a trade that went against us but came
    # back. Once unrealized has been at or below -(saving_lock_arm_frac_of_sl x the live SL), the
    # position closes the moment unrealized recovers to saving_lock_exit_pct (0 = entry price),
    # reason SAVING_LOCK. Paired with a wide SL (0.20%, set on the dashboard the same day): the
    # wide SL gives a bad trade room to come back, this takes the exit at ~$0 when it does instead
    # of hoping for more. The arm fraction tracks the live SL (override included), so "half the
    # SL" stays half if the SL is retuned. In-memory per position: a restart mid-position forgets
    # an armed lock (the SL still protects). Burns the signal like a red exit. None = off.
    saving_lock_arm_frac_of_sl: Optional[float] = None
    saving_lock_exit_pct: float = 0.0
    # Requires the cycle_id column migration (state + trades, both hedge legs). Both legs stamp
    # the SAME id (the cycle barrier's release timestamp, see _cycle_gate_clear_to_enter) onto
    # their entry and carry it to their close, so the dashboard can pair a cycle's two trade rows
    # by id instead of guessing from opened_at proximity. Added 2026-09-30: that proximity match
    # used a fixed 5s window, which a slow confirm/retry on one leg (confirm_fill backoff can run
    # tens of seconds, see the "worst-case pathological tick" note near LOCK_STALE_AFTER) can
    # blow past, splitting one real cycle into two unpaired single-leg rows on exactly the fast,
    # ugly moves where seeing the true net result matters most.
    schema_has_cycle_id: bool = False
    # Real exchange-side stop, placed via Lighter's native ORDER_TYPE_STOP_LOSS the moment a
    # position opens (see _sync_native_stop). Added 2026-09-30 after confirming in real trade
    # data that every SL closes 0.004-0.016 points worse than the configured pct (e.g. -0.045%
    # on a 0.03% stop) -- our own stop was only ever a software check on a 0.5s poll plus a
    # reduce_only market order, so a fast move always has room to run past the configured level
    # before our own code even sees it. The exchange enforces this one itself, no polling
    # involved. Kept OFF by default -- it is new, unproven in this codebase, and every other bot
    # must keep behaving exactly as before.
    native_stop_loss_enabled: bool = False
    # Same idea as native_stop_loss_enabled, for the TP side (ORDER_TYPE_TAKE_PROFIT) -- only
    # meaningful when disable_literal_tp is False, i.e. a literal TP actually governs exits.
    # Irrelevant for the hedge legs (disable_literal_tp=True there), real for a plain fixed-TP/SL
    # bot like Worker 1: both its exits are static price levels with no trail or partner-pnl
    # dependency, so BOTH sides can be backed by a real exchange order with nothing lost.
    native_take_profit_enabled: bool = False
    # Single-instance lock (2026-09-30) -- see LOCK_REFRESH_EVERY/LOCK_STALE_AFTER and
    # _acquire_instance_lock. Requires the lock_owner/lock_heartbeat column migration. False
    # (default) leaves every bot that hasn't had that migration run behaving exactly as before.
    single_instance_lock: bool = False
    # Manual exit levers (2026-09-30). When set, override_sl_pct / override_profit_lock_trigger /
    # override_profit_lock_trail on the state row replace the compiled-in sl_pct /
    # profit_lock_trigger_pct / profit_lock_trail_pct, so the exits can be retuned from the
    # dashboard without a deploy. Volatility ranged 0.0195%-0.1945% in a single week, a 10x
    # spread, and no one fixed stop is right across that -- this exists to find the right value
    # per regime by observation before any adaptive rule is committed to.
    # Requires the lighter_hedge_manual_exit_levers migration. NULL columns mean "use the config".
    schema_has_exit_overrides: bool = False
    # 2026-09-30, direct request: a fixed pause after THIS leg goes flat, before it will declare
    # itself ready for the next cycle -- "once you finish a trade, wait N seconds, then another
    # trade." Built to test hypertrading with require_pressure_to_enter off: with nothing else
    # gating entry, a `fixed_direction` leg would otherwise re-enter on the very next 0.5s tick
    # after going flat. 0.0 (default) preserves that instant-re-entry behaviour for every other
    # bot. Purely a delay on DECLARING readiness (see _cycle_gate_clear_to_enter's `want`
    # parameter and the standalone min_cycle_gap check in tick()) -- never touches an exit, so it
    # cannot strand a position.
    min_cycle_gap_seconds: float = 0.0
    # 2026-10-01, direct request (hedge): open a new cycle only when compute_intrabar_dispersion()
    # (over intrabar_dispersion_window bars) reads AT OR ABOVE this -- the opposite direction from
    # intrabar_dispersion_pause_at, which blocks when it is too HIGH. Backtested the same day on 9
    # days of real ticks against the hedge's own exits: low-dispersion cycles (< $30) carried most
    # of the loss (-$1.18 of -$1.43 entering every candle); gating at >= $30 more than halved it.
    # $50 chosen by the user as the safer cut. Like require_pressure_to_enter it only decides
    # whether a leg DECLARES readiness for a new cycle -- a clearance already granted is honoured
    # (see _cycle_gate_clear_to_enter), and it never touches an exit. None = disabled.
    min_intrabar_dispersion_to_enter: Optional[float] = None
    # 2026-10-01, direct request ("enter every clean candle"): at most ONE new cycle per 1-min
    # candle. Without it a fixed_direction leg re-declares the instant it goes flat, so a fast
    # cycle could be followed by another inside the same candle on the same reading. False keeps
    # the original behaviour.
    one_cycle_per_candle: bool = False
    # Mirror-paper fallback (2026-09-27): if real is flat, unlocked, and enabled, but has no
    # live entry_signal this tick while the paper shadow already holds a position, real enters
    # to match paper's side directly instead of waiting for its own fresh signal. See the
    # mirror_signal block in tick() for why this gap exists at all (level-triggered signal,
    # not edge-triggered -- a late/reopened real bot can otherwise miss an entry paper already
    # caught and never catch back up until the next full signal transition).
    mirror_paper_position: bool = False
    # 2026-09-29, direct request: "hedge bot" -- one leg of a two-account long+short straddle
    # (see compute_fixed_direction_signal's docstring). "long" or "short", or None (default) for
    # every other bot's normal signal-driven behavior. Takes priority over use_joint_adaptive/
    # use_adaptive_window/use_rsi_stoch_signal when set -- bypasses all of them, no stochastic
    # calculation at all. MUST be paired with require_fresh_signal=False,
    # red_exit_burns_signal=False, profit_lock_burns_signal=False -- see test_core.py's
    # t_fixed_direction_config_sanity for why combining any of those deadlocks re-entry.
    fixed_direction: Optional[str] = None
    # 2026-09-29, direct request (hedge bot): trade a fixed dollar amount per entry instead of
    # the account's full equity -- e.g. two legs sharing one $20 account, $10 committed per
    # leg per entry, not the whole balance every time. None (default) preserves every other
    # bot's existing behavior (full seed_usd + realized_pnl_usd each entry).
    fixed_leg_usd: Optional[float] = None
    # 2026-09-30, direct request, correcting a real bug: hedge legs must move in CYCLES, not
    # independently. Without this, the leg that gets cut by its SL immediately tries to
    # re-enter on its own next tick, potentially several times, while the OTHER leg is still
    # riding its original trade -- repeatedly losing on one side against a single win on the
    # other, exactly backwards from what was backtested (both enter together, whichever gets
    # cut WAITS, both re-enter together only once the winning leg also finishes). When set to
    # the partner's own table_state, a fresh entry is blocked unless the partner's own `side`
    # is also currently null (flat) -- see _partner_is_flat's docstring. None (default): no
    # effect on any other bot.
    cycle_partner_table: Optional[str] = None
    # 2026-09-29, direct request: "we need some signal so there is pressure some where, the
    # stochastic 25/75 is good enough" -- a fixed_direction leg otherwise sizes every entry at a
    # flat fixed_leg_usd regardless of market conditions, a pure coin flip between the two legs.
    # This computes the ordinary stochastic K (same entry_lo/entry_hi bands every other bot
    # uses -- fixed_direction's own entry logic ignores it, but self.candles is populated the
    # same way regardless) at entry time and tilts THIS leg's own size: bigger when the raw
    # signal agrees with this leg's fixed_direction, smaller when it favors the other leg,
    # unchanged when K is in the neutral 25-75 zone. Sizing tilt only -- entry/exit timing and
    # cycle_partner_table's synchronization are both untouched. No effect unless fixed_direction
    # is also set. See _pressure_biased_leg_usd's docstring.
    pressure_bias_enabled: bool = False
    pressure_bias_usd: float = 0.0
    pressure_bias_min_usd: float = 1.0
    # 2026-09-29, direct correction: exactly one leg of a hedge computes the shared signal
    # (see pressure_signal_hub on StochBot / _pressure_biased_leg_usd) -- every other leg just
    # reads it. False (default) for every other bot, including a hedge's non-owner leg(s).
    pressure_signal_owner: bool = False
    # 2026-09-29/30, temporary diagnostic: prints a checkpoint at each major step of tick()/
    # try_enter()/confirm_fill(), gated so it never fires for any other bot. Added specifically
    # to pinpoint where the hedge dual-leg process hangs (every individual piece -- reads,
    # local signing, WS, real concurrent orders -- tested clean in isolation, yet the full bot
    # freezes immediately after "started" every time; this narrows down which exact line).
    # Remove once the hang is found and fixed.
    debug_verbose_tick: bool = False
    # Joint adaptive formula (2026-09-28): see JOINT_ADAPTIVE_* constants and
    # compute_joint_adaptive_signal's docstring. False = use whichever other signal mode is
    # configured (plain / RSI / the binary-window Adaptive V2) as before.
    use_joint_adaptive: bool = False
    schema_has_joint_adaptive: bool = False  # requires the joint_adaptive migration
    # Per-bot formula knobs (2026-09-28, split out same day Worker 2 got its own separately-
    # derived formula): defaults reproduce Worker 3's original, unchanged formula exactly. Order
    # for base/coefficients/bounds is (window, lower_k, tp_pct, sl_pct, blank_seconds), matching
    # joint_adaptive_parameters/PARAMETER_NAMES. See that function's docstring for the math.
    joint_adaptive_reference_vol_pct: float = 0.0712
    joint_adaptive_lookback: int = 30
    joint_adaptive_base: tuple = (5.0, 25.0, 0.10, 0.11, 120.0)
    joint_adaptive_coefficients: tuple = (-1.0, 0.5, 0.5, 1.0, -1.0)
    joint_adaptive_bounds: tuple = ((3.0, 40.0), (15.0, 40.0), (0.025, 0.30), (0.05, 0.30), (15.0, 600.0))
    # Live raw signal readout (2026-09-28): persists the current stochastic K value and its
    # direction (long/short/neutral) regardless of which signal mode is active -- "what is the
    # paper bot looking at right now," on all 3 bots. See self.live_k/live_signal.
    schema_has_live_signal: bool = False  # requires the live_signal/live_k column migration
    # Stochastic-turn protection (2026-09-28, external research): once a position's unrealized
    # profit reaches 0.75x its (frozen, joint-adaptive) TP, arms a trail on the live stochastic
    # K value instead of price -- closes if K retreats by stoch_turn_retreat_points from its
    # best reading since arming. See _check_stoch_turn_exit's docstring. Only meaningful with
    # use_joint_adaptive=True (needs a frozen per-position TP and an entry-time volatility
    # ratio to compute the retreat threshold).
    stoch_turn_exit_enabled: bool = False
    # Restart-survival checkpoint (2026-09-28, added after external review): the armed/extreme-K
    # protection state and paper's frozen joint-adaptive TP/SL/blanking were originally
    # in-process only ("not worth a migration for") -- a real risk given Render restarts every
    # service on every push, this session's own frequent-deploy pattern. Bound to entry-time
    # identity so a stale checkpoint from an already-closed position never gets misapplied to a
    # new one. See position_stoch_checkpoint/paper_joint_checkpoint.
    schema_has_joint_checkpoint: bool = False  # requires the joint checkpoint column migration
    # Book-opposition early exit (2026-09-28, direct request, tested first as a retrospective
    # on Worker 3's real trades before going live): once a position is at least
    # book_opposition_min_age_seconds old AND losing at least book_opposition_loss_pct, check
    # the near-touch order book -- if the side opposing this position (asks for a long, bids for
    # a short) holds more than book_opposition_ratio_threshold of the resting size within
    # book_opposition_band_pct of the CURRENT best bid/ask (not entry price, all positive-size
    # levels in that band, not a fixed level count), exit immediately rather than waiting for the
    # full SL. On the retrospective test (36 real Worker 3 trades since order-book recording
    # started that day) this fired on 7 trades, all of which were already heading to a real SL,
    # and cut each one shorter -- net PnL over that window improved from -$0.0838 to -$0.0063,
    # zero real winners clipped in that sample. Independent of use_joint_adaptive -- works off
    # live order-book state, not the signal formula, so it's meant to layer onto EITHER Worker 2
    # or Worker 3's formula (each bot may use different TP/SL/window math but the same book-based
    # early exit). Treated as an SL-equivalent for self-lock purposes (full lock/reset), since by
    # construction it only ever fires on a position that is already losing -- never a win.
    book_opposition_exit_enabled: bool = False
    book_opposition_min_age_seconds: float = 10.0
    book_opposition_loss_pct: float = 0.05
    book_opposition_ratio_threshold: float = 0.60
    book_opposition_band_pct: float = 0.05
    # 2026-09-29, direct request, broadened same day from book-opposition-only to ANY red real
    # exit: the signal/direction that just closed at a loss is "trashed" -- blocked from
    # re-entering (new entry OR a reversal's reopen leg) until it genuinely goes away and comes
    # back, even within the same candle. Different from require_fresh_signal (which only
    # compares against the PRIOR CLOSED candle) -- this is event-driven off the live signal
    # itself, catching the case require_fresh_signal can't: a red close happens, and the exact
    # same still-active intra-candle signal immediately re-fires a real entry seconds later,
    # sometimes several times in a row. SL and BOOK_OPPOSITION are always red by construction
    # (their trigger conditions require it); REVERSAL and STOCH_TURN can go either way, so those
    # are checked against actual realized pnl at close time. TP and PROFIT_LOCK never burn --
    # structurally can't be red. In-process only, not persisted -- a restart clears it (same
    # tradeoff as the gates above that also don't survive a restart, e.g. entry_vol_pause
    # without schema_has_entry_vol_gate).
    red_exit_burns_signal: bool = False
    # 2026-09-29, direct request: skip the literal TP hard-exit entirely -- the position can
    # only close via SL, PROFIT_LOCK, STOCH_TURN, BOOK_OPPOSITION, or a signal reversal. Built
    # alongside profit_lock_enabled/profit_lock_trail_pct for bots meant to run as pure
    # "hyper trading": take whatever the trail gives back at, never wait for one specific fixed
    # target price. tp_pct is still computed and frozen per position as before (stoch-turn's
    # activation threshold is 0.75x it) -- this only skips the literal price check, not the
    # rest of the formula.
    disable_literal_tp: bool = False
    # 2026-09-29, direct request: lets a profit-lock-sourced signal burn (see
    # profit_lock_burns_signal above) clear EARLY -- before the raw signal fully leaves the
    # entry zone and comes back -- once live %K reclaims (or exceeds) the %K reading the
    # burned position originally entered at. Rationale: profit_lock_burns_signal alone treats
    # "still the same signal" as "nothing new," but during a sustained one-directional grind %K
    # can stay pinned inside the entry zone the whole time (e.g. 75-95) without ever technically
    # resetting -- this lets the bot pyramid into a continuing move instead of sitting out until
    # the signal fully reverses. Side-specific: a burned SHORT (entered on a high %K, overbought)
    # reclaims once live %K is >= that entry %K again (still at least as overbought); a burned
    # LONG reclaims once live %K is <= its entry %K (still at least as oversold) -- extremity in
    # the position's own direction, not raw magnitude. Only ever applies to PROFIT_LOCK-sourced
    # burns (self._burned_signal_via == "profit_lock") -- a burn from an actual loss (SL/
    # BOOK_OPPOSITION/red REVERSAL/red STOCH_TURN) always requires the ordinary full signal
    # reset, never this shortcut. In-process only, same tradeoff as red_exit_burns_signal above.
    profit_lock_burn_k_gate: bool = False


# ── Pure helpers ────────────────────────────────────────────────────────────────────────────
def compute_fixed_direction_signal(candles, direction):
    """2026-09-29, direct request: a hedge-leg bot that always wants to be in position on ONE
    fixed side (never flips) -- entry_signal and reversal_signal are always `direction`, no
    stochastic calculation at all. Since reversal_signal always equals the position's own side
    once entered, reversal_ready (reversal_signal != side) can never be True -- reversal exits
    never fire, only SL/PROFIT_LOCK. Returns (direction, direction, candle_ts) matching the
    shape of every other compute_*_signal function so it slots into the same dispatch.

    MUST be paired with require_fresh_signal=False and red_exit_burns_signal=/
    profit_lock_burns_signal=False -- since the raw signal never changes, any of those would
    permanently deadlock re-entry after the very first close (see BotConfig.fixed_direction's
    docstring)."""
    if len(candles) < 2:
        return None, None, None
    return direction, direction, candles[-2]["t"]


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


# Joint adaptive formula (2026-09-28, external research -- BTC_Joint_Adaptive_25_75.py /
# BTC_Joint_Adaptive_Results.md): all five parameters scale continuously off one volatility
# ratio R = vol_pct / reference_vol_pct, as parameter = clip(base * R**coef, bounds). Order
# matches PARAMETER_NAMES: window, lower_k, tp_pct, sl_pct, blank_seconds.
# Simulated result on the source report's primary replay: +$5.13/$100 vs the fixed 25/75
# baseline's +$0.15 over Sep22-27 (drawdown 1.00% vs 2.71%), both weekend days independently
# positive when started flat/unlocked -- but selected AFTER seeing Sunday data, so per the
# report's own words "Sunday is now fitting data, not an independent success."
#
# 2026-09-28, later same day: moved reference_vol_pct/lookback/base/coefficients/bounds from
# hardcoded module constants to BotConfig fields (joint_adaptive_* below) -- Worker 2 got its
# own separately-derived formula (different reference vol, exponents, and an asymmetric SL
# bound capped at its own base value) the same day, so a single shared global no longer holds
# for both bots. The constants below are now only the DEFAULT values (== Worker 3's exact
# existing formula, unchanged) that BotConfig.joint_adaptive_* fall back to.
JOINT_ADAPTIVE_REFERENCE_VOL_PCT = 0.0712
JOINT_ADAPTIVE_LOOKBACK = 30
JOINT_ADAPTIVE_BASE = (5.0, 25.0, 0.10, 0.11, 120.0)
JOINT_ADAPTIVE_COEFFICIENTS = (-1.0, 0.5, 0.5, 1.0, -1.0)
JOINT_ADAPTIVE_BOUNDS = ((3.0, 40.0), (15.0, 40.0), (0.025, 0.30), (0.05, 0.30), (15.0, 600.0))


def joint_adaptive_parameters(vol_pct, reference_vol_pct=JOINT_ADAPTIVE_REFERENCE_VOL_PCT,
                              base=JOINT_ADAPTIVE_BASE, coefficients=JOINT_ADAPTIVE_COEFFICIENTS,
                              bounds=JOINT_ADAPTIVE_BOUNDS):
    """Returns (window, lower_k, tp_pct, sl_pct, blank_seconds) at this vol_pct, each
    independently clipped to its own bound. upper_k is always 100-lower_k (not a separate
    coefficient), computed by the caller. base/coefficients/bounds/reference_vol_pct default to
    Worker 3's original formula but are per-bot (BotConfig.joint_adaptive_*) -- see
    compute_joint_adaptive_signal."""
    ratio = max(vol_pct, 1e-9) / reference_vol_pct
    out = []
    for b, coef, (lo, hi) in zip(base, coefficients, bounds):
        val = b * (ratio ** coef)
        out.append(min(max(val, lo), hi))
    return tuple(out)


def joint_adaptive_stoch_turn_params(vol_pct, tp_pct, reference_vol_pct=JOINT_ADAPTIVE_REFERENCE_VOL_PCT):
    """Stochastic-turn protection's own two frozen-at-entry values (external research,
    2026-09-28): activation_profit_percent = 0.75 * tp_pct (the position's own frozen TP, from
    joint_adaptive_parameters); stochastic_retreat_points = clip(10/sqrt(R), 2, 30), same R as
    the other five parameters. Verified against the source report's worked example: at the
    quiet anchor (vol_pct=0.0289%, tp_pct=0.06371%) this returns activation=0.04778,
    retreat=15.696 -- exact match. reference_vol_pct defaults to Worker 3's original anchor but
    is per-bot (BotConfig.joint_adaptive_reference_vol_pct)."""
    ratio = max(vol_pct, 1e-9) / reference_vol_pct
    activation_pct = 0.75 * tp_pct
    retreat_points = min(max(10.0 / math.sqrt(ratio), 2.0), 30.0)
    return activation_pct, retreat_points


def _stoch_k_interpolated(closed, window_float):
    """Interpolated stochastic %K for a possibly-fractional window: (1-f)*K(n) + f*K(n+1)
    where n=floor(window) clamped to [3,40], f=window-n. At n>=40, uses K(40) exactly (no
    extrapolation past the bound) -- an oscillator, not a rounded-period stochastic."""
    n = int(window_float)
    n = max(3, min(n, 40))
    f = 0.0 if n >= 40 else window_float - n

    def k_for_n(w):
        if len(closed) < w:
            return None
        win = closed[-w:]
        hh = max(x["h"] for x in win); ll = min(x["l"] for x in win)
        if hh == ll:
            return None
        return 100 * (closed[-1]["c"] - ll) / (hh - ll)

    k_n = k_for_n(n)
    if k_n is None:
        return None
    if f == 0.0:
        return k_n
    k_n2 = k_for_n(min(n + 1, 40))
    if k_n2 is None:
        return k_n
    return (1 - f) * k_n + f * k_n2


def _stoch_k_live(closed, live_h, live_l, live_c, window_float):
    """Same fractional-window interpolation as _stoch_k_interpolated, but the most recent bar
    is the LIVE, still-forming partial minute (live_h/live_l/live_c, continuously updated from
    real-time quote-mid -- see StochBot._update_partial_minute) instead of the last CLOSED
    candle. Used only by the stochastic-turn protection, which needs sub-minute resolution;
    the underlying joint-adaptive entry/exit signal itself still uses closed candles only.
    `closed` must NOT include any partial/forming bar -- pass self.candles[:-1], same as
    everywhere else that reads closed candles."""
    n = int(window_float)
    n = max(3, min(n, 40))
    f = 0.0 if n >= 40 else window_float - n

    def k_for_n(w):
        needed_closed = w - 1
        if needed_closed > 0 and len(closed) < needed_closed:
            return None
        win = closed[-needed_closed:] if needed_closed > 0 else []
        hh = live_h; ll = live_l
        for x in win:
            hh = max(hh, x["h"]); ll = min(ll, x["l"])
        if hh == ll:
            return None
        return 100 * (live_c - ll) / (hh - ll)

    k_n = k_for_n(n)
    if k_n is None:
        return None
    if f == 0.0:
        return k_n
    k_n2 = k_for_n(min(n + 1, 40))
    if k_n2 is None:
        return k_n
    return (1 - f) * k_n + f * k_n2


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


def compute_entry_stoch_k(candles, window=5):
    """Numeric entry diagnostic, using the same closed-candle formula as compute_stoch_signal.

    Pure: never updates the live signal/K or changes the trading decision. The signal method's
    first return value is a direction string, NOT K; persisting it rejects the whole snapshot.
    """
    if len(candles) < window + 2:
        return None
    closed = candles[:-1]
    bars = closed[-window:]
    hh = max(c["h"] for c in bars)
    ll = min(c["l"] for c in bars)
    if hh == ll:
        return None
    return 100 * (closed[-1]["c"] - ll) / (hh - ll)


def compute_intrabar_dispersion(candles, window=5):
    """Standard deviation of each closed candle's (high+low)/2 midpoint, over the trailing
    `window` closed candles -- raw dollars, not a %. Direct request, 2026-10-01: distinct from
    every range-based volatility measure above (which measure how big each bar's OWN swing
    is) -- this measures how much the price LEVEL itself is dispersing bar-to-bar. Tested
    against 575 real Worker 1 trades the same day: trades whose reading here was above
    roughly $40-55 lost on average (-$0.02 to -$0.04/trade); trades below made money (+$0.002
    to +$0.009/trade), and that split held up -- stayed significant, z -1.7 to -2.7 -- across
    that entire threshold band, unlike every range-based measure tried the same way (none of
    which held together outside one lucky cutoff). Window swept at 3/5/10/15 bars; 5 was the
    clear best, both strongest AND most stable across nearby thresholds."""
    closed = candles[:-1]
    if len(closed) < window:
        return None
    bars = closed[-window:]
    mids = [(c["h"] + c["l"]) / 2 for c in bars]
    mean = sum(mids) / len(mids)
    variance = sum((m - mean) ** 2 for m in mids) / len(mids)
    return variance ** 0.5


def compute_zebra_size_index(candles, window=5):
    """See BotConfig.zebra_index_min. Reads the trailing `window` CLOSED candles (candles[:-1]).
    A doji (close == open) has no color and is skipped when counting switches. None if there
    are not enough candles or fewer than two colored ones."""
    closed = candles[:-1]
    if len(closed) < window:
        return None
    bars = closed[-window:]
    colors = [1 if c["c"] > c["o"] else -1 if c["c"] < c["o"] else 0 for c in bars]
    colors = [x for x in colors if x != 0]
    if len(colors) < 2:
        return None
    zebra_pct = 100.0 * sum(colors[i] != colors[i - 1] for i in range(1, len(colors))) / (len(colors) - 1)
    size_pct = sum((c["h"] - c["l"]) / c["c"] * 100 for c in bars) / len(bars)
    if size_pct <= 0:
        return None
    return zebra_pct / size_pct


def compute_color_weighted_balance_index(candles, window=5):
    """See BotConfig.color_balance_index_min. Reads the trailing `window` CLOSED candles
    (candles[:-1]). Each candle's color vote is weighted by its own size, so one stray
    counter-direction candle can't swing the score the way a plain switch count can -- a big red
    candle still dominates a small green one in between. None if too few candles, or if every
    candle in the window has zero range (den <= 0)."""
    closed = candles[:-1]
    if len(closed) < window:
        return None
    bars = closed[-window:]
    num = 0.0
    den = 0.0
    for c in bars:
        color = 1 if c["c"] > c["o"] else -1 if c["c"] < c["o"] else 0
        size = (c["h"] - c["l"]) / c["c"] * 100
        num += size * color
        den += size
    if den <= 0:
        return None
    return (1 - abs(num / den)) * 100


def compute_volume_jump_ratio(candles, lookback=10):
    """Ratio of the most recently CLOSED candle's own traded volume to the mean of the
    `lookback` closed candles immediately before it (not including itself) -- a single-candle
    volume SPIKE detector. Distinct from compute_candle_volume_avg (a rolling mean LEVEL, not a
    spike ratio): a market can sit at an elevated-but-stable volume level for a while (no
    spike, ratio ~1) or spike hard for one candle without ever crossing an absolute level
    (ratio huge even if the absolute volume stays modest). See
    BotConfig.volume_jump_ratio. None if too few candles or the baseline is 0.

    Direct motivation, 2026-10-02: a real live loss (trade 1697) was entered on a stochastic K
    reading distorted by one outlier candle (volume 5.64 BTC against a ~1-1.5 BTC baseline,
    ratio ~4-5x) sitting inside the 5-bar K window -- K swung 11->89->53->97->87->83->80 across
    seven minutes of real whipsaw. Checked against 14,773 historical candles: ratio >=3x is the
    95th percentile (happens on ~5% of candles); the actual incident candle was comfortably
    above that (~4.7-5.6x against its own baseline). 3.0 was picked with margin below the real
    incident, not at the point of rarest significance."""
    closed = candles[:-1]
    if len(closed) < lookback + 1:
        return None
    latest = closed[-1]
    baseline_bars = closed[-(lookback + 1):-1]
    # .get, not [] -- candle data from every real source used in this file always carries "v",
    # but this must never be the thing that turns a missing field into a crashed tick.
    baseline = sum(b.get("v", 0) for b in baseline_bars) / lookback
    if baseline <= 0:
        return None
    return latest.get("v", 0) / baseline


def compute_candle_volume_avg(candles, window=10):
    """Mean TRADED volume (candle "v", BTC size, not price range) over the trailing `window`
    CLOSED candles. Distinct from every vol_pct/volatility measure elsewhere in this file --
    those measure how big a candle's own swing is, this measures how much actually traded.
    See BotConfig.volume_regime_switch_threshold. None if too few candles."""
    closed = candles[:-1]
    if len(closed) < window:
        return None
    bars = closed[-window:]
    return sum(c.get("v", 0) for c in bars) / len(bars)


def compute_candle_volume_rate(candles, window=10):
    """Change in compute_candle_volume_avg() between this closed candle and the one before it --
    signed BTC/min. Readout only (Worker 2, 2026-10-02): the research finding was that a high
    but STABLE volume level traded fine while a violently CHANGING level (even mid-level) is
    where real losses happened, so the rate matters independently of the level. None if either
    average is unavailable (too few candles)."""
    now = compute_candle_volume_avg(candles, window)
    if now is None:
        return None
    prior = compute_candle_volume_avg(candles[:-1], window)
    if prior is None:
        return None
    return now - prior


def compute_live_flip_streak(candles, lookback=20):
    """Live readout (2026-10-02, direct request: "a candle counter so i can see we are doing
    it correctly... 1 2 3 waiting for flip") -- how many consecutive same-color CLOSED candles
    are running right now, and which direction compute_flip_signal would enter if the VERY
    NEXT candle broke that streak (the streak's own color -- see compute_flip_signal's
    docstring for why direction follows the streak, not the interrupting candle).

    Purely a display helper, drives no decision: counts the SAME streak compute_flip_signal
    itself counts (one candle short of it -- this reads the latest closed candle as the
    streak's own tail; compute_flip_signal only measures that streak's length AFTER a
    different-colored candle has already interrupted it), so the two can never silently drift
    out of sync. Returns (None, 0) if there are no closed candles or the latest one is a doji."""
    closed = candles[:-1]
    if not closed:
        return None, 0

    def _color(c):
        if c["c"] > c["o"]:
            return 1
        if c["c"] < c["o"]:
            return -1
        return 0

    last_color = _color(closed[-1])
    if last_color == 0:
        return None, 0

    length = 1
    for k in range(1, lookback):
        idx = len(closed) - 1 - k
        if idx < 0:
            break
        if _color(closed[idx]) != last_color:
            break
        length += 1

    return ("long" if last_color == 1 else "short"), length


def compute_flip_signal(candles, min_trend_len=3, min_size_pct=None, min_body_pct=None, trend_lookback=20):
    """"Flip" entry -- REVISED 2026-10-02, direct request, after this bot's own first 5 live
    trades under the original version went 1-4: trade in the direction of the TREND that was
    running BEFORE the last closed candle interrupted it, betting that one opposite-color
    candle was a blip, not a genuine reversal -- the next bar resumes the original direction.
    Fires only the instant that interrupting candle closes (one bar, opposite color to what
    came before, versus a same-color streak at least `min_trend_len` bars long underneath it).

    The FIRST version of this signal (live for ~5 trades, 2026-10-02) instead entered in the
    direction of that interrupting candle itself -- i.e. the opposite of what this version
    does. Checked against real tick data for all 5 of those live trades: the reversed
    direction would have gone 4-1 instead of 1-4, consistently, not by one lucky trade --
    strong enough that the user asked for this entry to flip rather than wait for more live
    trades. Still only 5 trades; this is a live hypothesis, not a proven edge.

    Built as the high-volume counterpart to compute_stoch_signal() -- see
    BotConfig.volume_regime_switch_threshold; the stochastic signal's edge collapses
    (empirically, not just a coin flip at the extreme top of the traded-volume range) once
    volume gets high enough, and this is what the live bot switches to instead.

    `min_size_pct`, if set, additionally requires the streak's average (high-low)/close% to
    clear that floor. Off by default -- the pre-revision research that floor was based on
    does not necessarily still apply now that the entry direction itself has flipped; in fact
    the one real live WIN under the old direction had a SMALL pre-flip streak (this floor
    would have blocked it) while all 4 real losses had LARGE streaks (this floor would have
    let them through) -- the exact opposite of what the floor assumed. Kept available, not
    deleted, but do not re-enable it on the strength of the old research alone.

    `min_body_pct`, if set, requires the INTERRUPTING candle's own body -- |close-open|/close%,
    NOT the streak's size -- to clear that floor too. Direct motivation, 2026-10-02: a real
    live loss (trade 1679) flipped on a candle whose body was $0.80 on an $84,314 price
    (0.00095%), barely distinguishable from a doji. Checked against 1,768 historical flip
    signals under the revised (trend-direction) rule: unfiltered win rate is 58%
    (avg +$0.0150); requiring >=0.01% body keeps 75% of signals and raises that to 62%
    (avg +$0.0207) -- a deliberately moderate cutoff, not the point of maximum edge (median
    body, ~0.02%, reaches 67%/+$0.0286 but only keeps 56% of signals), picked specifically to
    not give up too much signal frequency.

    Same (entry_signal, reversal_signal, candle_ts) contract as the other compute_*_signal
    methods. reversal_signal is always None -- unlike the stochastic signal, there is no
    natural "reversal" threshold for a flip; every backtest of this signal used SL/TP/profit-lock
    as the only exits, so that's what live trading gets too."""
    closed = candles[:-1]
    if len(closed) < 2:
        return None, None, None
    cur, prev = closed[-1], closed[-2]
    ts = cur["t"]

    def _color(c):
        if c["c"] > c["o"]:
            return 1
        if c["c"] < c["o"]:
            return -1
        return 0

    cur_color, prev_color = _color(cur), _color(prev)
    if cur_color == 0 or prev_color == 0 or cur_color == prev_color:
        return None, None, ts  # no flip this candle

    if min_body_pct is not None:
        body_pct = abs(cur["c"] - cur["o"]) / cur["c"] * 100
        if body_pct < min_body_pct:
            return None, None, ts  # the "flip" is noise-sized, not a real interruption

    trend_len = 1
    for k in range(1, trend_lookback):
        idx = len(closed) - 2 - k
        if idx < 0:
            break
        if _color(closed[idx]) != prev_color:
            break
        trend_len += 1

    if trend_len < min_trend_len:
        return None, None, ts

    if min_size_pct is not None:
        n = min(trend_len, 10)
        size_bars = closed[-(n + 1):-1]
        avg_size = sum((b["h"] - b["l"]) / b["c"] * 100 for b in size_bars) / len(size_bars)
        if avg_size < min_size_pct:
            return None, None, ts

    # Direction follows the ORIGINAL trend (prev_color), not the interrupting candle
    # (cur_color) that just broke it -- see this function's docstring for why this flipped.
    direction = "long" if prev_color == 1 else "short"
    return direction, None, ts


def compute_rsi_stoch_confirmed_signal(candles, rsi_period=5, stoch_period=14, require_confirmation=True, lo=20, hi=80):
    """"Confirmed Stochastic RSI" (2026-09-26 paper test): Wilder RSI(rsi_period) on completed
    1-min closes, then raw Stochastic RSI over the last stoch_period RSI values (no K/D
    smoothing) -- S = 100*(RSI-min)/(max-min) over that window. Long when S<20 AND the latest
    completed close is above the previous completed close; short when S>80 AND it closed
    below. Confirmation applies to both entries and reversals (same signal serves both -- there
    is no separate reversal threshold in this design, unlike the plain stochastic signal).

    require_confirmation=False drops the price-confirmation half of the rule (long on S<20
    alone, short on S>80 alone) -- backtested 2026-09-26 on real data: roughly 3x more trades
    but WORSE pnl in every period tested (full file -1.09%->-4.48%, Friday -0.86%->-2.24%,
    even Saturday itself +1.02%->+0.29%). Deployed anyway at the user's explicit request, to
    get a live comparison against the other bots rather than only a backtest."""
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
    if s < lo and (not require_confirmation or latest_close > prev_close):
        signal = "long"
    elif s > hi and (not require_confirmation or latest_close < prev_close):
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
        # Tracks whether a literal TP has occurred within the current winning streak -- see
        # cfg.self_lock_require_tp_in_streak. In-memory only (not persisted): a restart just
        # means it's forgotten even if a real TP happened before the restart, which only ever
        # makes unlock MORE conservative (may ask for one extra TP win), never less safe.
        self.paper_streak_has_tp = False
        # What caused the CURRENT lock -- "real_sl", "hour_open", "boot", "enabled_toggle". See
        # cfg.self_lock_hour_open_requires_tp, the only thing that reads this. Persisted (unlike
        # paper_streak_has_tp above): losing this on restart would make unlock LESS
        # conservative, the opposite direction of safe to forget.
        self._lock_via = None
        self._self_lock_loaded = False
        self._last_enabled_seen = None  # see self_lock_relocks_on_boot's tick()-level check
        # Hour-open confirmation (2026-09-28: redefined to reuse the self-lock's own
        # real_trading_locked/paper_consecutive_tps directly, no separate state of its own
        # anymore -- see hour_open_requires_self_lock's docstring). Re-arms on every restart by
        # design (re-checked from cfg.trading_hours_utc directly, nothing to persist).
        self._last_hour_open = None
        # RSI paper test (fully independent shadow -- never reads or writes anything above)
        self.rsi_paper_side = None
        self.rsi_paper_entry = None
        self.rsi_paper_entry_ms = None
        self._rsi_paper_loaded = False
        # Adaptive V2 signal -- live formula output, for dashboard display (see
        # compute_adaptive_stoch_signal)
        self.adaptive_last_vol_pct = None
        self.adaptive_last_window = None
        self.adaptive_last_k = None
        self._adaptive_last_persisted_window = None
        # Profit-lock trail -- lives here (not just in the DB row) so it works correctly this
        # session even before the profit_lock_peak_pct migration has been run; DB persistence
        # (best-effort, only if schema_has_profit_lock) is a bonus for surviving a restart, not
        # a requirement for correctness within one continuous run.
        self.profit_lock_peak_pct = None
        self._profit_lock_restored = False
        self._saving_trough_pct = None  # see BotConfig.saving_lock_arm_frac_of_sl
        self._last_reversal_close_at = None  # see BotConfig.post_reversal_cooldown_seconds
        # Breakeven floor (see BotConfig.breakeven_floor_enabled). Same arrangement as the
        # profit-lock trail: in-process state is authoritative, the DB column only exists so a
        # Render restart mid-position doesn't lose the baseline.
        #   _breakeven_baseline      partner's CUMULATIVE realized pnl as of our own entry, so
        #                            (partner_realized_now - baseline) is its pnl for THIS cycle
        #   _breakeven_partner_seen  the partner was observed holding a position at some point
        #                            during our position's life -- stops a partner that simply
        #                            hasn't entered yet from reading as "already closed flat"
        #   _breakeven_floor_pct     the computed floor, cached once the partner is flat (its
        #                            realized pnl is final at that point, so this cannot move)
        #   _breakeven_reached       we have actually traded at or above the floor, so exiting at
        #                            it is genuinely locking in breakeven rather than forcing a
        #                            worse-than-SL exit on a leg that was never that far ahead
        self._breakeven_baseline = None
        self._breakeven_partner_seen = False
        self._breakeven_floor_pct = None
        self._breakeven_reached = False
        self._breakeven_restored = False
        self._breakeven_partner_read_at = 0.0
        # Single-instance lock. The id is per-LEG, not per-process: the hedge bot runs two legs in
        # one process and they lock two DIFFERENT rows, so sharing one id would make "who holds
        # this?" ambiguous in the logs for no benefit.
        self._lock_id = f"{uuid.uuid4().hex[:12]}:{cfg.worker_id}"
        self._lock_held = False
        self._lock_refreshed_at = 0.0   # last SUCCESSFUL claim/refresh
        self._lock_checked_at = 0.0     # last attempt of any kind (throttle)
        self._lock_blocked_logged = False
        # Set when an entry order was placed but the exchange could not be read afterwards, so
        # whether it filled is genuinely UNKNOWN. Blocks any further entry until a position read
        # succeeds again. Proven necessary 2026-09-30 with real money: Lighter's CloudFront WAF
        # returned CAPTCHA (HTTP 405) to Render's IP, every confirm_fill read failed, and each
        # failure was counted as "no fill" -- so the bot re-entered twice more, all three orders
        # actually filled, and 3x the intended size sat unmanaged on both sub-accounts for hours.
        # Never guess at a fill: if we cannot see the position, we do not send another order.
        self._entry_outcome_unknown = False
        self._confirm_read_ok = True
        # Emergency-flatten bookkeeping -- see emergency_flatten / EMERGENCY_COOLDOWN.
        self._emergency_flattens = []
        self._entry_cooldown_until = 0.0
        # min_cycle_gap_seconds bookkeeping. _was_in_position lets tick() detect the exact tick
        # this leg transitions to flat (side: not-None -> None) without needing a separate
        # "closed just now" signal -- side is already read fresh every tick regardless.
        self._was_in_position = False
        self._went_flat_at = 0.0
        self._last_cycle_candle_t = None  # see BotConfig.one_cycle_per_candle
        # Paper shadow's own copy of the same trail -- without this, real could exit early via
        # PROFIT_LOCK while paper (running the identical signal) kept holding, making the two
        # visibly diverge even while real is unlocked and trading the exact same thing paper is.
        self.paper_profit_lock_peak_pct = None
        # Joint adaptive formula (2026-09-28): all five params (window, K thresholds, TP, SL,
        # reversal blanking) computed continuously from one volatility ratio -- see
        # compute_joint_adaptive_signal. joint_adaptive_last is the LIVE reading (updates every
        # tick, for dashboard display); position_blank_seconds/paper_joint_* are FROZEN at
        # entry, same idea as position_tp_pct/position_sl_pct -- an open position's exits don't
        # move just because volatility changed after entry.
        self.joint_adaptive_last = None
        self._joint_adaptive_last_persist_ts = 0.0
        self.position_blank_seconds = None
        self._position_blank_restored = False
        self.paper_joint_tp_pct = None
        self.paper_joint_sl_pct = None
        self.paper_joint_blank_s = None
        # Live raw signal readout (2026-09-28): what the current stochastic K value actually is
        # right now and which way it points -- the same thing the paper shadow is looking at,
        # since paper and real (when unlocked) trade off the identical signal. Set by whichever
        # compute_*_signal function is actually active this tick; persisted best-effort on a
        # cadence for the dashboard, same pattern as the adaptive-formula displays.
        self.live_k = None
        self.live_signal = None
        self._live_signal_persist_ts = 0.0
        self._min_vol_persist_ts = 0.0
        self._entry_confirmation_persist_ts = 0.0
        # Optional shared dict, set externally (never by this class itself) when this bot is
        # one leg of a multi-leg hedge -- see _pressure_biased_leg_usd's docstring and
        # lighter_hedge_dual_leg.py's main(). None (default): pressure bias, if enabled, uses
        # this bot's own compute_stoch_signal() reading in isolation, same as any standalone bot.
        self.pressure_signal_hub = None
        self.environment_hub = None
        self._environment_reading = {"allowed": False}
        self._environment_restored = False
        self._environment_logged_key = None
        # Shared in-process barrier for hedge cycle entries -- see _cycle_gate_clear_to_enter.
        # Wired by lighter_hedge_dual_leg.py's main(); None for every standalone bot.
        self.cycle_hub = None
        # Set the tick the barrier clears this leg to enter, consumed by try_enter -- see
        # schema_has_cycle_id. Not restored across a restart because it is only needed for the
        # brief window between a clearance and the entry it was granted for.
        self._pending_cycle_id = None
        # Trigger price (float, pre-rounding) of whatever native stop order we believe is
        # currently resting on the exchange for this leg's open position -- see
        # BotConfig.native_stop_loss_enabled / _sync_native_stop. None whenever we are flat, or
        # believe nothing is resting (just closed, just restarted).
        self._native_stop_synced = None  # (trigger_price, qty) last confirmed resting, or None
        self._native_tp_synced = None    # same, for native_take_profit_enabled
        self._burned_signal = None  # see BotConfig.red_exit_burns_signal
        # See _regime_controls -- defaults match that method's own defaults, in case
        # _prior_candle_signal is ever read before the first tick has run.
        self._regime_flip_enabled = True
        self._regime_vol_threshold = self.cfg.volume_regime_switch_threshold
        # See _stoch_band_controls -- same reasoning as the regime defaults just above.
        self._stoch_band_entry_lo = self.cfg.entry_lo
        self._stoch_band_entry_hi = self.cfg.entry_hi
        self._stoch_band_reversal_lo = self.cfg.reversal_lo
        self._stoch_band_reversal_hi = self.cfg.reversal_hi
        # See BotConfig.volume_jump_ratio / _update_volume_jump_guard.
        self._last_volume_jump_at = None
        self._volume_jump_paused_until = None
        # See BotConfig.volume_jump_release_mode / _update_volume_jump_guard. Peaks track the
        # crest of each metric since the current spike armed; the _last_* trio are always-fresh
        # readouts for the dashboard regardless of mode.
        self._volume_jump_peak_volume = None
        self._volume_jump_peak_wiggle = None
        self._volume_jump_peak_rate = None
        self._last_wiggle = None
        self._last_volume_jump_volume = None
        self._last_volume_jump_rate = None
        # Whichever peak the ACTIVE release_mode is tracking, for the dashboard -- direct
        # report: "I only see the timer" with no way to tell whether a wiggle/volume/rate
        # release is close or far. None when release_mode is off/unset. See
        # _update_volume_jump_guard.
        self._last_release_peak = None
        # See BotConfig.profit_lock_burn_k_gate's docstring. _burned_signal_via distinguishes a
        # profit-lock-sourced burn (eligible for the K-reclaim early-clear) from a loss-sourced
        # one (always needs the ordinary full signal reset). _position_entry_k is the real
        # position's own entry-time %K (set in try_enter), copied into _burned_signal_k at the
        # moment a PROFIT_LOCK close burns the signal.
        self._burned_signal_via = None
        self._burned_signal_k = None
        self._position_entry_k = None
        # Stochastic-turn protection (2026-09-28, external research -- BTC_Stochastic_Turn_
        # Exit.py / BTC_Stochastic_Turn_Exit_Results.md): a profit-armed trail on the LIVE
        # (sub-minute) stochastic K, layered on the joint adaptive formula. See
        # _stoch_k_live/_check_stoch_turn_exit's docstrings. partial_minute_* tracks the
        # current, still-forming minute's quote-mid high/low continuously (self.candles only
        # refreshes once a minute via REST poll, too coarse for this). position_stoch_* is the
        # REAL position's frozen-at-entry activation/retreat plus live armed/extreme-K state;
        # paper_stoch_* is the paper shadow's own independent copy of the same thing.
        self.partial_minute_ts = None
        self.partial_minute_h = None
        self.partial_minute_l = None
        self.partial_minute_last_mid = None
        self.position_stoch_activation_pct = None
        self.position_stoch_retreat_points = None
        self.position_stoch_armed = False
        self.position_stoch_extreme_k = None
        self._position_stoch_restored = False
        self.paper_stoch_activation_pct = None
        self.paper_stoch_retreat_points = None
        self.paper_stoch_armed = False
        self.paper_stoch_extreme_k = None
        self._joint_checkpoint_persist_ts = 0.0

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

    async def log_trade(self, side, ae, exit_price, base_amount, pnl_usd, reason, legs_used,
                        opened_at, cycle_id=None, entry_features=None):
        # Idempotent insert (proven necessary 2026-09-24): a Render restart can briefly leave
        # the old and new process both alive, and both independently finish closing the same
        # real position -- each computes and writes the identical realized_pnl_usd update (so
        # money was never actually double-counted), but each also INSERTs its own trade row,
        # which duplicates unlike an UPDATE. on_conflict + resolution=ignore-duplicates makes
        # a repeat insert for the same (opened_at, side, avg_entry_price) a silent no-op
        # instead of a second row. Requires a matching unique constraint on table_trades.
        row = {
            "side": side, "avg_entry_price": ae, "exit_price": exit_price,
            "base_amount_btc": base_amount, "pnl_usd": pnl_usd, "reason": reason,
            "legs_used": legs_used, "opened_at": opened_at,
        }
        if cycle_id is not None:
            # Omitted entirely rather than sent as null -- schema_has_cycle_id bots only pass a
            # value once the migration exists; a bot/table without that column must never see
            # this key at all, or PostgREST rejects the whole insert.
            row["cycle_id"] = cycle_id
        if entry_features is not None:
            # Same reasoning as cycle_id above -- only passed at all once schema_has_entry_
            # features is on and the migration has added these columns.
            row.update(entry_features)
        await self.sb(
            "POST",
            f"{self.cfg.table_trades}?on_conflict=opened_at,side,avg_entry_price",
            row,
            extra_headers={"Prefer": "resolution=ignore-duplicates,return=representation"},
        )

    # ── Candles ─────────────────────────────────────────────────────────────────────────────
    async def fetch_candles(self, count=60):
        end_ms = int(time.time() * 1000)
        url = (f"https://mainnet.zklighter.elliot.ai/api/v1/candles?market_id={self.cfg.market_index}"
               f"&resolution=1m&start_timestamp=0&end_timestamp={end_ms}&count_back={count}")
        async with self.http.get(url) as resp:
            text = await resp.text()
            content_type = resp.headers.get("Content-Type", "")
            if resp.status >= 400 or "json" not in content_type:
                # Same WAF/CAPTCHA tell as recentTrades polling (2026-09-29): a blocked
                # response is HTML with a 2xx-or-40x status, not reliably >=400 -- content-type
                # is the more robust check. Previously this just hit jsonlib.loads() on an
                # empty/HTML body and surfaced as an opaque "Expecting value" JSONDecodeError.
                raise RuntimeError(f"fetch_candles {resp.status} ct={content_type}: {text[:150]}")
            data = jsonlib.loads(text)
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
                    # "+" must be percent-encoded -- the raw ISO offset (+00:00) otherwise gets
                    # read as a literal space by the time it reaches Postgres (found 2026-09-26
                    # debugging the trade-flow logger's identical DELETE call below).
                    cutoff = (datetime.now(timezone.utc)
                             - timedelta(days=TICK_LOG_RETENTION_DAYS)).isoformat().replace("+", "%2B")
                    await self.sb("DELETE", f"lighter_btc_price_ticks?ts=lt.{cutoff}")
            except Exception:
                pass  # never let tick logging affect trading
            await asyncio.sleep(TICK_LOG_EVERY)

    async def run_trade_flow_logger_forever(self):
        """Records actual executed trades (size, price, aggressor side) from Lighter's public
        recentTrades endpoint -- lighter_btc_price_ticks only has best bid/ask, never real
        order flow. Same single-writer-with-failover pattern as run_tick_logger_forever above.
        recentTrades has no historical backfill (confirmed 2026-09-26: timestamp/cursor params
        are silently ignored, it always returns only the current live trades), so this can only
        ever see trades from the moment logging starts forward.

        2026-09-27: polling every TRADE_FLOW_LOG_EVERY (3s originally) triggered a WAF/CAPTCHA
        block on the shared outbound IP that also degraded real position reads on other
        workers -- a real incident, not a hypothetical. Fixed two ways: (1) interval raised to
        a much safer cadence, (2) real exponential backoff on ANY error now, capped at
        MAX_BACKOFF_S, with an even longer forced pause specifically on a WAF-shaped response
        (HTML body instead of JSON -- the earlier incident's exact symptom) so a block can
        never be hammered into a worse one."""
        cfg = self.cfg
        if cfg.trade_flow_log_defers_to is None:
            return
        STALE_AFTER = TRADE_FLOW_LOG_EVERY * 3
        MAX_BACKOFF_S = 300.0
        WAF_BACKOFF_S = 600.0
        last_prune = 0.0
        last_trade_id = None
        consecutive_errors = 0
        while True:
            sleep_s = TRADE_FLOW_LOG_EVERY
            try:
                should_write = len(cfg.trade_flow_log_defers_to) == 0
                if not should_write:
                    last = await self.sb(
                        "GET", "lighter_btc_trade_flow?select=ts,source&order=ts.desc&limit=1")
                    if not last:
                        should_write = True
                    else:
                        last_ts = datetime.fromisoformat(last[0]["ts"].replace("Z", "+00:00"))
                        age = time.time() - last_ts.timestamp()
                        active_higher_priority = (
                            last[0]["source"] in cfg.trade_flow_log_defers_to and age < STALE_AFTER)
                        should_write = not active_higher_priority
                if should_write:
                    if last_trade_id is None:
                        rows = await self.sb(
                            "GET", "lighter_btc_trade_flow?select=trade_id&order=trade_id.desc&limit=1")
                        last_trade_id = rows[0]["trade_id"] if rows else 0
                    # limit=100 is this endpoint's actual max -- 200 silently returned zero
                    # trades for hours before this call checked resp.status (found 2026-09-27).
                    url = (f"https://mainnet.zklighter.elliot.ai/api/v1/recentTrades"
                           f"?market_id={cfg.market_index}&limit=100")
                    async with self.http.get(url) as resp:
                        text = await resp.text()
                        content_type = resp.headers.get("Content-Type", "")
                        if resp.status >= 400 or "json" not in content_type:
                            # WAF/CAPTCHA responses are HTML with a 2xx-or-40x status, not
                            # reliably >=400 -- content-type is the more robust tell.
                            consecutive_errors += 1
                            sleep_s = WAF_BACKOFF_S
                            raise RuntimeError(f"recentTrades {resp.status} ct={content_type}: {text[:150]}")
                        data = jsonlib.loads(text)
                    new_trades = sorted(
                        (t for t in data.get("trades", []) if t["trade_id"] > last_trade_id),
                        key=lambda t: t["trade_id"])
                    for t in new_trades:
                        await self.sb("POST", "lighter_btc_trade_flow", {
                            "trade_id": t["trade_id"], "ts": ms_to_iso(t["timestamp"]),
                            "price": float(t["price"]), "size": float(t["size"]),
                            "usd_amount": float(t["usd_amount"]),
                            "is_maker_ask": t["is_maker_ask"], "source": cfg.worker_id,
                        })
                        last_trade_id = t["trade_id"]
                if cfg.trade_flow_log_prune and time.time() - last_prune > 3600:
                    last_prune = time.time()
                    cutoff = (datetime.now(timezone.utc)
                             - timedelta(days=TRADE_FLOW_LOG_RETENTION_DAYS)).isoformat().replace("+", "%2B")
                    await self.sb("DELETE", f"lighter_btc_trade_flow?ts=lt.{cutoff}")
                consecutive_errors = 0
            except Exception as e:
                consecutive_errors += 1
                if sleep_s == TRADE_FLOW_LOG_EVERY:  # not already forced to WAF_BACKOFF_S above
                    sleep_s = min(TRADE_FLOW_LOG_EVERY * (2 ** consecutive_errors), MAX_BACKOFF_S)
                try:
                    await self.log_run("trade_flow_log_error",
                                       {"error": str(e)[:300], "consecutive": consecutive_errors,
                                        "backoff_s": sleep_s})
                except Exception:
                    pass  # never let trade-flow logging affect trading
            await asyncio.sleep(sleep_s)

    async def run_market_data_logger_forever(self):
        """Single consolidated logger (2026-09-28, direct request): one table, one loop,
        replacing the two separate loggers above for whichever bot sets
        cfg.unified_market_data_table. Two row kinds, discriminated by `kind`:

        - "book": FULL order-book depth (every bid/ask price level currently known, each with
          its own price and size), not just best bid/ask. Costs nothing extra to log -- the
          book already lives in memory via the websocket subscription (self.live.order_book),
          updated continuously as diffs stream in, so this is a pure local read, no REST call,
          no WAF exposure. Logged on MARKET_DATA_BOOK_EVERY, much faster than the old tick
          logger's cadence, precisely because it's free.
        - "trade": executed trade prints (price, size, aggressor side via is_maker_ask), from
          Lighter's public recentTrades REST endpoint. This is the one part that still costs a
          network call and carries WAF risk (see TRADE_FLOW_LOG_EVERY's own history), so it's
          polled on its own slower, already-hardened cadence within the same loop, with the
          same exponential backoff (and a longer forced pause on a WAF-shaped response) this
          session learned the hard way is necessary.

        No multi-writer failover here (unlike the two loggers this replaces) -- only ever
        wired up on one bot at a time, so there's nothing to defer to."""
        cfg = self.cfg
        table = cfg.unified_market_data_table
        if table is None:
            return
        MAX_BACKOFF_S = 300.0
        WAF_BACKOFF_S = 600.0
        last_prune = 0.0
        last_trade_id = None
        last_trade_poll = 0.0
        consecutive_errors = 0
        while True:
            sleep_s = MARKET_DATA_BOOK_EVERY
            try:
                if self.live.book_fresh():
                    bids = self.live.order_book.get("bids") or []
                    asks = self.live.order_book.get("asks") or []
                    if bids and asks:
                        best_bid = max(float(b["price"]) for b in bids)
                        best_ask = min(float(a["price"]) for a in asks)
                        await self.sb("POST", table, {
                            "kind": "book",
                            "bids": [{"price": float(b["price"]), "size": float(b["size"])}
                                    for b in bids],
                            "asks": [{"price": float(a["price"]), "size": float(a["size"])}
                                    for a in asks],
                            "best_bid": best_bid, "best_ask": best_ask, "source": cfg.worker_id,
                        })
                now = time.time()
                if now - last_trade_poll >= TRADE_FLOW_LOG_EVERY:
                    last_trade_poll = now
                    if last_trade_id is None:
                        rows = await self.sb(
                            "GET", f"{table}?select=trade_id&kind=eq.trade&order=trade_id.desc&limit=1")
                        last_trade_id = rows[0]["trade_id"] if rows else 0
                    url = (f"https://mainnet.zklighter.elliot.ai/api/v1/recentTrades"
                           f"?market_id={cfg.market_index}&limit=100")
                    async with self.http.get(url) as resp:
                        text = await resp.text()
                        content_type = resp.headers.get("Content-Type", "")
                        if resp.status >= 400 or "json" not in content_type:
                            consecutive_errors += 1
                            sleep_s = WAF_BACKOFF_S
                            raise RuntimeError(
                                f"recentTrades {resp.status} ct={content_type}: {text[:150]}")
                        data = jsonlib.loads(text)
                    new_trades = sorted(
                        (t for t in data.get("trades", []) if t["trade_id"] > last_trade_id),
                        key=lambda t: t["trade_id"])
                    for t in new_trades:
                        await self.sb("POST", table, {
                            "kind": "trade", "trade_id": t["trade_id"],
                            "ts": ms_to_iso(t["timestamp"]),
                            "price": float(t["price"]), "size": float(t["size"]),
                            "usd_amount": float(t["usd_amount"]),
                            "is_maker_ask": t["is_maker_ask"], "source": cfg.worker_id,
                        })
                        last_trade_id = t["trade_id"]
                if cfg.unified_market_data_prune and time.time() - last_prune > 3600:
                    last_prune = time.time()
                    cutoff = (datetime.now(timezone.utc)
                             - timedelta(days=MARKET_DATA_RETENTION_DAYS)).isoformat().replace("+", "%2B")
                    await self.sb("DELETE", f"{table}?ts=lt.{cutoff}")
                consecutive_errors = 0
            except Exception as e:
                consecutive_errors += 1
                if sleep_s == MARKET_DATA_BOOK_EVERY:
                    sleep_s = min(MARKET_DATA_BOOK_EVERY * (2 ** consecutive_errors), MAX_BACKOFF_S)
                try:
                    await self.log_run("market_data_log_error",
                                       {"error": str(e)[:300], "consecutive": consecutive_errors,
                                        "backoff_s": sleep_s})
                except Exception:
                    pass  # never let market-data logging affect trading
            await asyncio.sleep(sleep_s)

    def compute_stoch_signal(self, entry_lo=None, entry_hi=None, reversal_lo=None, reversal_hi=None):
        """entry_lo/entry_hi/reversal_lo/reversal_hi, if given, override the compiled
        cfg.entry_lo/entry_hi/reversal_lo/reversal_hi for this call only -- see
        _stoch_band_controls. Every existing caller passes none of these (all four stay None),
        so behaviour is identical to before unless a caller explicitly opts in."""
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
        entry_lo = entry_lo if entry_lo is not None else self.cfg.entry_lo
        entry_hi = entry_hi if entry_hi is not None else self.cfg.entry_hi
        reversal_lo = reversal_lo if reversal_lo is not None else self.cfg.reversal_lo
        reversal_hi = reversal_hi if reversal_hi is not None else self.cfg.reversal_hi
        entry_signal = _sig(k, entry_lo, entry_hi)
        self.live_k = k
        self.live_signal = entry_signal
        return entry_signal, _sig(k, reversal_lo, reversal_hi), ts

    def compute_zscore_signal(self):
        """Mean-reversion z-score signal -- see BotConfig.use_zscore_signal. Ported from
        backtest/zscore-alone-1yr-tp08-btc.ts: z = (last CLOSED candle's close - mean of the
        PRECEDING cfg.zscore_window closed candles) / their POPULATION stdev. "long" when
        z <= -zscore_entry (the latest close sitting zscore_entry std devs below the mean of the
        candles before it -- an oversold snap, betting on reversion up), "short" when
        z >= +zscore_entry. Same contract as compute_stoch_signal(): (entry_signal,
        reversal_signal, candle_ts); same live_k/live_signal publish for the dashboard, except
        live_k here holds the z-score itself, not a 0-100 stochastic K.

        The window deliberately EXCLUDES the candle being scored (matching the backtest's
        `closes.slice(i - ZSCORE_WINDOW, i)`, which stops one short of i) -- caught before this
        ever ran live: including it, as a first pass here briefly did, bounds |z| at
        sqrt(zscore_window - 1) (a population std always includes its own point, which caps how
        far any single point can sit from a mean it contributed to). At the backtest's window=5
        that bound is exactly 2.0 -- equal to the default zscore_entry threshold itself, so the
        signal could MATHEMATICALLY never fire, approached in the limit but never reached by any
        real data. Scoring against the PRECEDING window removes that ceiling entirely.
        """
        c = self.candles
        w = self.cfg.zscore_window
        if len(c) < w + 2:
            return None, None, None
        closed = c[:-1]
        window = [x["c"] for x in closed[-(w + 1):-1]]
        ts = closed[-1]["t"]
        mean = sum(window) / len(window)
        variance = sum((x - mean) ** 2 for x in window) / len(window)
        std = variance ** 0.5
        if std == 0:
            return None, None, ts
        z = (closed[-1]["c"] - mean) / std
        thr = self.cfg.zscore_entry
        entry_signal = _sig(z, -thr, thr)
        self.live_k = z
        self.live_signal = entry_signal
        return entry_signal, entry_signal, ts

    def compute_adaptive_stoch_signal(self):
        """"Adaptive V2" (2026-09-27): binary window switch instead of a continuous formula --
        an earlier continuous version changed window on nearly every candle (1,311 times over
        ~98h), which is itself a source of instability (the indicator's meaning shifts even
        when price hasn't really changed regime). This switches between exactly two windows,
        rarely (55 times over the same period in back-testing).

        vol_pct = mean 1-min (high-low)/close %, trailing cfg.adaptive_vol_lookback CLOSED
        candles. window = cfg.adaptive_quiet_window if vol_pct < cfg.adaptive_vol_switch_pct
        else cfg.adaptive_active_window. Same K/threshold (cfg.entry_lo/hi) serves both entry
        and reversal, same as the plain signal. Stores the live vol_pct/window on
        self.adaptive_last_vol_pct/self.adaptive_last_window so the dashboard can show exactly
        what the bot is doing right now."""
        c = self.candles
        cfg = self.cfg
        closed = c[:-1]
        if len(closed) < cfg.adaptive_vol_lookback + 1:
            self.adaptive_last_vol_pct = None
            self.adaptive_last_window = None
            return None, None, None
        vol_window = closed[-cfg.adaptive_vol_lookback:]
        ranges = [(x["h"] - x["l"]) / x["c"] * 100 for x in vol_window if x["c"] > 0]
        vol_pct = sum(ranges) / len(ranges) if ranges else None
        window = (cfg.adaptive_quiet_window if vol_pct is not None and vol_pct < cfg.adaptive_vol_switch_pct
                  else cfg.adaptive_active_window)
        self.adaptive_last_vol_pct = vol_pct
        self.adaptive_last_window = window
        ts = closed[-1]["t"]
        if len(closed) < window:
            return None, None, ts
        w = closed[-window:]
        hh = max(x["h"] for x in w); ll = min(x["l"] for x in w)
        if hh == ll:
            return None, None, ts
        k = 100 * (closed[-1]["c"] - ll) / (hh - ll)
        signal = _sig(k, cfg.entry_lo, cfg.entry_hi)
        self.adaptive_last_k = k
        self.live_k = k
        self.live_signal = signal
        return signal, signal, ts

    def _regime_controls(self, state):
        """(stochastic_enabled, zebra_enabled, flip_enabled, volume_switch_threshold) for this
        tick -- direct request, 2026-10-02 ("give me control of the signals"). Same override
        shape as _exit_params just below: a non-NULL value on the state row wins over the
        compiled-in default, read live every tick. stochastic_enabled/flip_enabled gate the
        low/high-volume regimes respectively (False = that regime places no new entries and
        attempts no reversal -- existing exits on an already-open position are untouched,
        same contract as the master ON/OFF toggle). zebra_enabled gates the color-balance band
        on top of the stochastic signal specifically; False lets the raw stochastic signal
        trade unfiltered. volume_switch_threshold overrides
        BotConfig.volume_regime_switch_threshold itself. See
        BotConfig.schema_has_regime_overrides."""
        cfg = self.cfg
        stochastic_enabled, zebra_enabled, flip_enabled = True, True, True
        vol_threshold = cfg.volume_regime_switch_threshold
        if cfg.schema_has_regime_overrides:
            o = state.get("override_stochastic_enabled")
            if o is not None: stochastic_enabled = bool(o)
            o = state.get("override_zebra_enabled")
            if o is not None: zebra_enabled = bool(o)
            o = state.get("override_flip_enabled")
            if o is not None: flip_enabled = bool(o)
            o = state.get("override_volume_switch_threshold")
            if o is not None: vol_threshold = float(o)
        return stochastic_enabled, zebra_enabled, flip_enabled, vol_threshold

    def _stoch_band_controls(self, state):
        """(entry_lo, entry_hi, reversal_lo, reversal_hi) for this tick -- direct request,
        2026-10-02. FIRST version tied entry and reversal to one shared band; REVISED same day
        ("i wanted to be able to put a number for the reversal and a number for the entry
        signal") -- independently overridable now. override_stoch_band_lo/hi control the ENTRY
        band only (kept under their original column names); override_stoch_reversal_lo/hi are
        new, for the reversal band specifically. NULL on either means 'use the compiled
        default' for that one, independently. Same override shape and schema flag as
        _regime_controls (BotConfig.schema_has_regime_overrides)."""
        cfg = self.cfg
        entry_lo, entry_hi = cfg.entry_lo, cfg.entry_hi
        reversal_lo, reversal_hi = cfg.reversal_lo, cfg.reversal_hi
        if cfg.schema_has_regime_overrides:
            o = state.get("override_stoch_band_lo")
            if o is not None: entry_lo = float(o)
            o = state.get("override_stoch_band_hi")
            if o is not None: entry_hi = float(o)
            o = state.get("override_stoch_reversal_lo")
            if o is not None: reversal_lo = float(o)
            o = state.get("override_stoch_reversal_hi")
            if o is not None: reversal_hi = float(o)
        return entry_lo, entry_hi, reversal_lo, reversal_hi

    def _exit_params(self, state):
        """(sl_pct, profit_lock_trigger, profit_lock_trail, tp_pct, exit_mode) for this tick.

        A non-NULL override on the state row wins over the compiled-in value; NULL means "use the
        config". Read live every tick rather than frozen at entry, so a change takes effect at
        once -- the intended workflow is stop, retune, restart, but reading live also means a
        value nudged mid-cycle is honoured immediately instead of silently waiting a cycle.

        Both legs MUST carry identical values. Unequal exits between the legs break the breakeven
        floor (a leg cut at a different level cannot be offset by its partner), which is why the
        API route always writes both rows together and never one alone.

        exit_mode (2026-10-03, direct request: "a panel where i can change between trail and TP
        so i can test multiple strategies") -- "trail" is the default and reproduces whatever
        disable_literal_tp/profit_lock_enabled were already compiled to, bit for bit, so setting
        up this override changes no live behavior until the panel is actually used. "tp" is the
        other state: a literal TP (at tp_pct, itself overridable via override_tp_pct) becomes the
        winner's only exit and the profit-lock trail is suppressed -- this directly matches the
        WORKER_2_HANDOFF.md research recommendation (SL .05 / fixed TP .10 / trailing OFF) rather
        than letting the two winner-exit styles run partially mixed. SL is untouched by this
        either way -- the one protection that always stays active regardless of exit_mode."""
        cfg = self.cfg
        sl, trig, trail, tp = cfg.sl_pct, cfg.profit_lock_trigger_pct, cfg.profit_lock_trail_pct, cfg.tp_pct
        exit_mode = "trail"
        if cfg.schema_has_exit_overrides:
            o = state.get("override_sl_pct")
            if o is not None: sl = float(o)
            o = state.get("override_profit_lock_trigger")
            if o is not None: trig = float(o)
            o = state.get("override_profit_lock_trail")
            if o is not None: trail = float(o)
            o = state.get("override_tp_pct")
            if o is not None: tp = float(o)
            o = state.get("override_exit_mode")
            if o in ("trail", "tp"): exit_mode = o
        return sl, trig, trail, tp, exit_mode

    def _measure_vol_pct(self, lookback):
        """Mean 1-min (high-low)/close%, trailing `lookback` CLOSED candles -- the same
        volatility measure joint-adaptive's formula uses, factored out (2026-09-29) so a plain
        (non-adaptive) bot can gate entries on it too, without depending on use_joint_adaptive.
        Returns None if there isn't enough candle history yet."""
        closed = self.candles[:-1]
        if len(closed) < lookback + 1:  # matches joint-adaptive's original threshold exactly
            return None
        window = closed[-lookback:]
        ranges = [(x["h"] - x["l"]) / x["c"] * 100 for x in window if x["c"] > 0]
        return sum(ranges) / len(ranges) if ranges else None

    def compute_joint_adaptive_signal(self):
        """"Joint adaptive" (2026-09-28, external research): unlike compute_adaptive_stoch_
        signal (a binary window switch only), ALL FIVE parameters -- window, K thresholds,
        TP, SL, reversal blanking -- move continuously with volatility, via
        joint_adaptive_parameters(). Same vol_pct measure as the V2 formula (mean 1-min
        (high-low)/close %, trailing cfg.joint_adaptive_lookback CLOSED candles).

        The window can be fractional (e.g. 12.32 candles) -- _stoch_k_interpolated blends the
        two nearest integer-window K values rather than rounding.

        TP/SL/blanking computed HERE are just this tick's live reading, stored on
        self.joint_adaptive_last for the dashboard AND so tick()/try_enter/_update_paper_shadow
        can freeze them onto a position at the moment it actually opens -- an open position's
        exit bands don't move just because volatility changed after entry, same principle as
        the existing position_tp_pct/position_sl_pct trend-band freeze.

        reference_vol_pct/lookback/base/coefficients/bounds all come from cfg.joint_adaptive_*
        (2026-09-28, later same day: split per-bot when Worker 2 got its own distinct formula)
        -- this method itself is shared, unchanged code."""
        cfg = self.cfg
        closed = self.candles[:-1]
        if len(closed) < cfg.joint_adaptive_lookback + 1:
            self.joint_adaptive_last = None
            return None, None, None
        ts = closed[-1]["t"]
        vol_pct = self._measure_vol_pct(cfg.joint_adaptive_lookback)
        if vol_pct is None:
            self.joint_adaptive_last = None
            return None, None, ts
        window, lower_k, tp_pct, sl_pct, blank_s = joint_adaptive_parameters(
            vol_pct, cfg.joint_adaptive_reference_vol_pct, cfg.joint_adaptive_base,
            cfg.joint_adaptive_coefficients, cfg.joint_adaptive_bounds)
        self.joint_adaptive_last = {
            "vol_pct": vol_pct, "window": window, "lower_k": lower_k,
            "upper_k": 100 - lower_k, "tp_pct": tp_pct, "sl_pct": sl_pct,
            "blank_seconds": blank_s,
        }
        k = _stoch_k_interpolated(closed, window)
        if k is None:
            self.live_k = None
            self.live_signal = None
            return None, None, ts
        signal = _sig(k, lower_k, 100 - lower_k)
        self.live_k = k
        self.live_signal = signal
        return signal, signal, ts

    def _prior_candle_signal(self):
        """Fresh-signal check (2026-09-28, direct request): what would the active signal
        function have returned one candle earlier? Reuses the EXACT same compute_*_signal
        method currently in use, called against self.candles shifted back by one, instead of a
        separate reimplementation -- guarantees this can never quietly drift out of sync with
        whatever the real signal logic actually is. Read-only from the caller's perspective:
        saves and restores every field these functions set as a side effect (joint_adaptive_last,
        adaptive_last_window, live_k, etc.) so this check never corrupts the CURRENT tick's real
        values, which the dashboard and entry-freezing logic both depend on being accurate."""
        cfg = self.cfg
        if len(self.candles) < 2:
            return None
        saved_candles = self.candles
        saved_joint = self.joint_adaptive_last
        saved_adapt_vol = self.adaptive_last_vol_pct
        saved_adapt_win = self.adaptive_last_window
        saved_adapt_k = self.adaptive_last_k
        saved_live_k = self.live_k
        saved_live_sig = self.live_signal
        self.candles = saved_candles[:-1]
        try:
            if cfg.use_joint_adaptive:
                sig, _, _ = self.compute_joint_adaptive_signal()
            elif cfg.use_adaptive_window:
                sig, _, _ = self.compute_adaptive_stoch_signal()
            elif cfg.use_rsi_stoch_signal:
                sig, _ = compute_rsi_stoch_confirmed_signal(
                    self.candles, stoch_period=cfg.stoch_window,
                    require_confirmation=cfg.rsi_paper_require_confirmation,
                    lo=cfg.entry_lo, hi=cfg.entry_hi)
            elif (self._regime_flip_enabled and self._regime_vol_threshold is not None
                  and (compute_candle_volume_avg(self.candles, cfg.volume_regime_switch_window) or -1)
                  >= self._regime_vol_threshold):
                # Mirrors the regime switch in tick() -- what would have fired one candle
                # earlier is judged by whichever signal WOULD have been active then, not
                # always the stochastic one. Reads the SAME cached toggle state tick() just
                # resolved this tick (self._regime_flip_enabled/_regime_vol_threshold), not a
                # second DB read -- see _regime_controls.
                sig, _, _ = compute_flip_signal(
                    self.candles, cfg.flip_signal_min_trend_len, cfg.flip_signal_min_size_pct,
                    cfg.flip_signal_min_body_pct)
            else:
                sig, _, _ = self.compute_stoch_signal(
                    self._stoch_band_entry_lo, self._stoch_band_entry_hi,
                    self._stoch_band_reversal_lo, self._stoch_band_reversal_hi)
        finally:
            self.candles = saved_candles
            self.joint_adaptive_last = saved_joint
            self.adaptive_last_vol_pct = saved_adapt_vol
            self.adaptive_last_window = saved_adapt_win
            self.adaptive_last_k = saved_adapt_k
            self.live_k = saved_live_k
            self.live_signal = saved_live_sig
        return sig

    def _update_partial_minute(self, best_bid, best_ask, now_ms):
        """Tracks the current, still-forming minute's quote-mid high/low continuously, for the
        stochastic-turn protection's live-K calculation (see _stoch_k_live). self.candles only
        refreshes once a minute via a REST poll (~1.5s after each boundary) -- far too coarse
        for a check meant to react within a minute. Resets on every minute rollover; harmless
        to call every tick regardless of position state, since accurate high/low needs every
        tick observed, not just the ticks while a position happens to be open."""
        mid = (best_bid + best_ask) / 2
        minute_ts = (now_ms // 60000) * 60000
        if self.partial_minute_ts != minute_ts:
            self.partial_minute_ts = minute_ts
            self.partial_minute_h = mid
            self.partial_minute_l = mid
        else:
            self.partial_minute_h = max(self.partial_minute_h, mid)
            self.partial_minute_l = min(self.partial_minute_l, mid)
        self.partial_minute_last_mid = mid

    def _live_stoch_k(self):
        """Current live stochastic K using the partial-minute buffer + closed candles, at
        whatever window the joint-adaptive formula is reading RIGHT NOW (not frozen at entry --
        per the source report, "window changes can also change K; this behavior is included in
        the replay"). None if any required input isn't ready yet.

        BUG FIX (2026-09-28, caught by external review): the numerator must be the LATEST
        observed quote-mid (self.partial_minute_last_mid), not (h+l)/2 -- the midpoint of the
        range stays frozen while price genuinely reverses inside an already-established
        high/low, which would hide exactly the kind of turn this protection exists to catch.
        Also guards against the brief window right after a minute boundary where self.candles
        hasn't caught up yet (REST refresh lags ~1.5s behind the wall clock) -- using a stale
        `closed` array there would misalign the window by one bar; fails closed (no reading)
        instead of risking that."""
        if (self.partial_minute_h is None or self.partial_minute_last_mid is None
                or self.joint_adaptive_last is None or not self.candles):
            return None
        if self.candles[-1]["t"] < self.partial_minute_ts:
            return None
        window = self.joint_adaptive_last["window"]
        closed = self.candles[:-1]
        return _stoch_k_live(closed, self.partial_minute_h, self.partial_minute_l,
                             self.partial_minute_last_mid, window)

    @staticmethod
    def _stoch_turn_check(side, unrealized_pct, live_k, activation_pct, retreat_points,
                          armed, extreme_k):
        """Shared arm/track/trigger logic (external research, 2026-09-28) -- used identically
        by the real position and the paper shadow so they stay in lockstep, same principle as
        the profit-lock trail. Once armed, STAYS armed even if unrealized profit later drops
        back below the activation level ("activation is remembered"); only the position closing
        clears it. Returns (new_armed, new_extreme_k, triggered)."""
        if live_k is None:
            return armed, extreme_k, False
        if not armed:
            if unrealized_pct >= activation_pct:
                return True, live_k, False
            return armed, extreme_k, False
        if side == "long":
            extreme_k = live_k if extreme_k is None else max(extreme_k, live_k)
            triggered = (extreme_k - live_k) >= retreat_points
        else:
            extreme_k = live_k if extreme_k is None else min(extreme_k, live_k)
            triggered = (live_k - extreme_k) >= retreat_points
        return armed, extreme_k, triggered

    def _burn_reclaimed_by_k(self):
        """See BotConfig.profit_lock_burn_k_gate's docstring. True if the current burn should
        clear early because live %K has reclaimed (or exceeded) the entry %K of the position
        that triggered it -- only ever true for a profit-lock-sourced burn."""
        cfg = self.cfg
        if not (cfg.profit_lock_burn_k_gate and self._burned_signal_via == "profit_lock"
                and self._burned_signal_k is not None and self.live_k is not None):
            return False
        if self._burned_signal == "short":
            return self.live_k >= self._burned_signal_k
        if self._burned_signal == "long":
            return self.live_k <= self._burned_signal_k
        return False

    def _clear_burn(self):
        self._burned_signal = None
        self._burned_signal_via = None
        self._burned_signal_k = None

    async def _partner_is_flat(self):
        """See BotConfig.cycle_partner_table's docstring -- hedge-cycle synchronization.
        True if there's no partner configured (nothing to gate against) or the partner's own
        state currently shows flat (side is null). Fails CLOSED on any read error or missing
        row -- entering without actually knowing the partner's real state defeats the entire
        point of this gate (better to miss a cycle than double up on entries)."""
        cfg = self.cfg
        if cfg.cycle_partner_table is None:
            return True
        try:
            rows = await self.sb("GET", f"{cfg.cycle_partner_table}?select=side&id=eq.1")
            if not rows:
                return False
            return rows[0].get("side") is None
        except Exception:
            return False

    @staticmethod
    def new_cycle_hub(worker_ids):
        """Shared state for the hedge cycle barrier. Built once in the dual-leg process's main()
        and handed to every leg -- see _cycle_gate_clear_to_enter."""
        return {"members": set(worker_ids), "ready": {}, "cleared": {}}

    def _cycle_gate_clear_to_enter(self, want=True, now=None):
        """True if this leg may open a position RIGHT NOW as part of a synchronised cycle.

        Replaces the old cycle_partner_table DB poll for any bot wired into a shared hub, and this
        is why. That poll only ever enforced half the rule -- "a leg that got cut waits" -- and
        never the other half, "both legs enter together". It was a plain read: whichever leg
        happened to poll first entered, and the other then saw a partner holding a position and
        refused. One beat of skew was all it took, and from there the two legs ping-ponged
        permanently, each entering ALONE while the other sat blocked. Observed live 2026-09-30 at
        05:06:24: the long closed and the short entered in the same second, and from then on the
        "hedge" was a single naked $10 directional leg at a time. No amount of retrying fixes a
        non-atomic check; the decision has to be made in one place for both legs at once.

        Both legs run in ONE process under a single asyncio event loop, so this method is the
        natural place for that: it contains no `await`, which means the whole read-decide-commit
        below is atomic with respect to the other leg by construction -- the loop cannot switch
        tasks in the middle of it.

        Protocol: a leg declares readiness each tick it wants in. Once EVERY member is
        simultaneously ready, all of them are granted a clearance and the ready set is emptied;
        each leg then consumes its own clearance on the tick it actually enters. Declarations and
        clearances both expire (CYCLE_READY_TTL / CYCLE_CLEARED_TTL) so a leg that stops wanting to
        enter -- disabled, lost the instance lock, closed unexpectedly -- stops holding its partner
        hostage within a couple of seconds, without anyone ever entering unhedged to compensate.

        Deliberately has no "give up and enter alone" timeout: for a hedge, a lone leg is not a
        degraded cycle, it is a different (directional) strategy. Waiting forever is the safe
        failure, and it cannot strand anything permanently in practice, because both legs live or
        die with the same process.

        `want` is whether this leg wants a NEW cycle right now (i.e. its own
        preconditions, such as the pressure gate, currently hold). It only affects
        whether readiness is DECLARED. A clearance already granted is honoured
        regardless -- proven necessary 2026-09-30 with real money: the barrier released
        both legs, the long entered, and 0.3s later the short re-evaluated the shared
        pressure reading, found K had drifted back inside the band, and discarded a
        clearance it had ALREADY been given. The long then ran alone for 96 seconds.
        Once the barrier says a cycle is go, both legs go; re-litigating the entry
        condition per-leg after the fact is exactly how one leg ends up naked."""
        hub = self.cycle_hub
        if hub is None:
            return None  # no barrier wired -- caller falls back to the DB partner check
        now = time.time() if now is None else now
        wid = self.cfg.worker_id
        # Drop anything stale before deciding, so expiry is evaluated at decision time rather
        # than whenever some other leg last happened to tick.
        hub["ready"] = {k: t for k, t in hub["ready"].items() if now - t < CYCLE_READY_TTL}
        hub["cleared"] = {k: t for k, t in hub["cleared"].items() if now - t < CYCLE_CLEARED_TTL}
        # A clearance already granted for this cycle -- consume it and go.
        if wid in hub["cleared"]:
            del hub["cleared"][wid]
            return True
        if not want:
            # Not asking for a cycle this tick -- drop any stale readiness so the partner is not
            # left waiting on a declaration we no longer mean.
            hub["ready"].pop(wid, None)
            return False
        hub["ready"][wid] = now
        if hub["members"].issubset(hub["ready"].keys()):
            # Everyone is ready at the same instant: release them all together, then consume our
            # own clearance immediately so this tick's caller enters too. Stamp one shared id for
            # this cycle (see schema_has_cycle_id) -- every member reads the SAME value here,
            # before any of them has placed an order or can drift from retries.
            hub["cycle_id"] = f"{int(now * 1000)}"
            hub["cleared"] = {m: now for m in hub["members"]}
            hub["ready"] = {}
            del hub["cleared"][wid]
            return True
        return False

    def _cycle_gate_withdraw(self):
        """Drop this leg's readiness/clearance -- called whenever it turns out not to be entering
        after all (already in a position, disabled, or the entry failed). Without this a leg could
        sit "ready" on a declaration it no longer means, and its partner would keep waiting on it
        until the TTL expired."""
        hub = self.cycle_hub
        if hub is None:
            return
        wid = self.cfg.worker_id
        hub["ready"].pop(wid, None)
        hub["cleared"].pop(wid, None)

    async def _acquire_instance_lock(self):
        """Take (or renew) this leg's single-instance lock. Returns True if we hold it.

        The lock is won only when the row shows one of: no owner, us already, or an owner whose
        heartbeat is older than LOCK_STALE_AFTER. Otherwise another live instance is trading this
        sub-account and we must not.

        Fails CLOSED (returns False) on a read/write error. This gates only new ENTRIES -- see the
        call site -- so a bad Supabase read costs at most a missed entry, never an unmanaged
        position. Erring the other way would reintroduce exactly the double-entry this prevents.

        Not a true atomic compare-and-swap: PostgREST can express the guard as part of the PATCH
        filter, which is what the `or=` below does -- the UPDATE only matches the row if it is
        still claimable at write time, and `return=representation` tells us whether it matched.
        Two instances racing therefore cannot both succeed, because only one PATCH can find the
        row in a claimable state."""
        cfg = self.cfg
        if not cfg.single_instance_lock:
            return True
        now = time.time()
        # Throttle EVERY attempt, not just successful refreshes. Gating this on _lock_held would
        # leave the not-holding path retrying on every 0.5s tick -- 2 writes/s per leg, both while
        # locked out by a live zombie and (worse) forever if the lock_heartbeat migration hasn't
        # been run yet. Returning the last known answer costs at most LOCK_REFRESH_EVERY of delay
        # before this instance picks the lock up.
        if now - self._lock_checked_at < LOCK_REFRESH_EVERY:
            return self._lock_held
        self._lock_checked_at = now
        stale_before = datetime.now(timezone.utc) - timedelta(seconds=LOCK_STALE_AFTER)
        # `Z` rather than isoformat()'s "+00:00": this goes into a URL QUERY STRING, where a literal
        # `+` decodes to a space and would corrupt the timestamp PostgREST parses.
        stale_iso = stale_before.isoformat().replace("+00:00", "Z")
        # Claimable if: unowned, already ours, or the current owner has gone quiet. The
        # heartbeat.is.null arm matters -- `lt` never matches NULL, so an owner row with no
        # heartbeat (a partially-applied release, or a hand edit) would otherwise be unclaimable
        # forever and permanently stop this leg from trading.
        guard = (f"or=(lock_owner.is.null,"
                 f"lock_heartbeat.is.null,"
                 f"lock_owner.eq.{self._lock_id},"
                 f"lock_heartbeat.lt.{stale_iso})")
        try:
            rows = await self.sb(
                "PATCH", f"{cfg.table_state}?id=eq.1&{guard}",
                {"lock_owner": self._lock_id,
                 "lock_heartbeat": datetime.now(timezone.utc).isoformat()})  # body: JSON, + is fine
        except Exception as e:
            was_held = self._lock_held
            self._lock_held = False
            if was_held:
                await self.log_run("instance_lock_refresh_failed", {"error": str(e)[:200]})
            return False
        if rows:
            if not self._lock_held:
                await self.log_run("instance_lock_acquired", {"lock_id": self._lock_id})
            self._lock_held = True
            self._lock_refreshed_at = now
            self._lock_blocked_logged = False
            return True
        # No row matched -- somebody else holds a fresh lock.
        self._lock_held = False
        if not self._lock_blocked_logged:
            self._lock_blocked_logged = True
            try:
                cur = await self.sb("GET", f"{cfg.table_state}?select=lock_owner&id=eq.1")
                holder = cur[0].get("lock_owner") if cur else None
            except Exception:
                holder = None
            await self.log_run("instance_lock_busy",
                               {"lock_id": self._lock_id, "held_by": holder})
        return False

    async def _release_instance_lock(self):
        """Best-effort release on a clean shutdown, so a redeploy's new instance can start trading
        immediately instead of waiting out LOCK_STALE_AFTER. Never raises: if this fails the lock
        just goes stale on its own, which is the whole point of having a staleness timeout."""
        if not self.cfg.single_instance_lock or not self._lock_held:
            return
        self._lock_held = False
        with contextlib.suppress(BaseException):
            await self.sb(
                "PATCH", f"{self.cfg.table_state}?id=eq.1&lock_owner=eq.{self._lock_id}",
                {"lock_owner": None, "lock_heartbeat": None})

    async def _read_partner_cycle_pnl(self):
        """(partner_side, partner_cycle_pnl) for the breakeven floor, or (None, None) on any
        failure. partner_cycle_pnl is the partner's realized pnl for THIS cycle only -- its
        cumulative realized_pnl_usd now, minus the baseline snapshotted at our own entry.

        Fails SOFT (returns Nones), the opposite of _partner_is_flat's fail-closed: this only ever
        ADDS an exit, so not knowing the partner's state must leave the position running on its
        ordinary profit-lock/SL protection rather than forcing a close on a bad read.

        Throttled to at most one read per second. The caller polls this from inside an open
        position, i.e. potentially every 0.5s tick -- unthrottled that would double this leg's
        Supabase read rate for the whole life of every position."""
        cfg = self.cfg
        if cfg.cycle_partner_table is None or self._breakeven_baseline is None:
            return None, None
        now = time.time()
        if now - self._breakeven_partner_read_at < 1.0:
            return None, None
        self._breakeven_partner_read_at = now
        try:
            rows = await self.sb(
                "GET", f"{cfg.cycle_partner_table}?select=side,realized_pnl_usd&id=eq.1")
            if not rows:
                return None, None
            side = rows[0].get("side")
            realized = rows[0].get("realized_pnl_usd")
            if realized is None:
                return side, None
            return side, float(realized) - self._breakeven_baseline
        except Exception:
            return None, None

    def _reset_breakeven_floor(self):
        """Clear all per-cycle breakeven state. Called everywhere a position goes flat -- the
        baseline, the floor and the 'partner was seen open' observation are all meaningful only
        for the position that was open when they were recorded."""
        self._breakeven_baseline = None
        self._breakeven_partner_seen = False
        self._breakeven_floor_pct = None
        self._breakeven_reached = False
        self._breakeven_partner_read_at = 0.0

    @staticmethod
    def breakeven_floor_pct(partner_cycle_pnl, own_notional_usd, fixed_floor_pct=None):
        """The unrealized % at which this leg exactly cancels the partner's realized loss for the
        cycle, unless a fixed winning-leg floor is configured. None when there is nothing to
        offset (partner flat/green) or no notional to divide
        by. Pure function, so the unequal-sizing arithmetic is directly testable:
        a $5 leg offsetting a $15 leg's -0.03% ($0.0045) needs +0.09%."""
        if partner_cycle_pnl is None or partner_cycle_pnl >= 0:
            return None
        if not own_notional_usd or own_notional_usd <= 0:
            return None
        if fixed_floor_pct is not None:
            return fixed_floor_pct
        return 100.0 * (-partner_cycle_pnl) / own_notional_usd

    def _compute_pressure_source_signal(self):
        """Whatever reading drives the entry-pressure gate and the dashboard's "Pressure Signal"
        readout for a fixed_direction bot (the hedge) -- see _has_entry_pressure and the owner
        publish site in tick(). NOT the same selection as the main tick() elif-chain: that chain
        checks fixed_direction FIRST and would never reach the stochastic/z-score branches at
        all for these bots, but a fixed_direction leg still needs ONE of them to gate WHEN it
        may enter. 2026-10-01, direct request: z-score instead of the stochastic for the hedge
        specifically (Worker 1 keeps the plain stochastic) -- see BotConfig.use_zscore_signal."""
        return self.compute_zscore_signal() if self.cfg.use_zscore_signal else self.compute_stoch_signal()

    def _has_entry_pressure(self):
        """True if there is enough pressure right now to justify opening a cycle -- see
        BotConfig.require_pressure_to_enter. Reads the ONE shared reading both legs already use
        (published every tick by the owner leg) so the two legs can never disagree about whether
        this moment qualifies; falls back to its own reading for a standalone bot with no hub.
        No hub and no candles yet -> no pressure, so a freshly-booted bot waits for a real reading
        rather than entering on nothing."""
        cfg = self.cfg
        if not cfg.require_pressure_to_enter:
            return True
        hub = self.pressure_signal_hub
        if hub is not None:
            return hub.get("signal") is not None
        return self._compute_pressure_source_signal()[0] is not None

    def _has_entry_dispersion(self):
        """True unless min_intrabar_dispersion_to_enter is set and the current reading is below
        it. No reading yet (too few candles) -> False, so a freshly-booted leg waits for a real
        reading rather than entering on nothing -- same stance as _has_entry_pressure."""
        floor = self.cfg.min_intrabar_dispersion_to_enter
        if floor is None:
            return True
        d = compute_intrabar_dispersion(self.candles, self.cfg.intrabar_dispersion_window)
        return d is not None and d >= floor

    def _current_candle_t(self):
        return self.candles[-1]["t"] if self.candles else None

    def _candle_unused(self):
        """See BotConfig.one_cycle_per_candle."""
        if not self.cfg.one_cycle_per_candle:
            return True
        return self._current_candle_t() != self._last_cycle_candle_t

    def _environment_allows_cycle(self):
        if not self.cfg.environment_entry_gate_enabled or self.cfg.environment_er_pause_below is None:
            return True
        reading = self.environment_hub if self.environment_hub is not None else self._environment_reading
        return bool(reading.get("allowed") and time.time() - reading.get("checked_at", 0) <= 90)

    async def _refresh_environment(self, holds_lock):
        """One shared, direction-independent ER15 monitor; never gates position management.

        Store minute checkpoints in the existing runs JSON, avoiding schema changes. Only the
        lock owner publishes; a recent checkpoint preserves hysteresis across a restart.
        Missing, stale or discontinuous candles fail paused, even if the last reading was green.
        """
        cfg = self.cfg
        if cfg.environment_er_pause_below is None or not cfg.environment_signal_owner or not holds_lock:
            return
        now = time.time()
        reading = self.environment_hub if self.environment_hub is not None else self._environment_reading
        if not self._environment_restored:
            self._environment_restored = True
            try:
                rows = await self.sb("GET", f"{cfg.table_runs}?select=detail&action=eq.environment_er&order=id.desc&limit=1")
                d = rows[0]["detail"] if rows else {}
                if (d.get("window") == cfg.environment_er_window
                        and d.get("pause_below") == cfg.environment_er_pause_below
                        and d.get("resume_at") == cfg.environment_er_resume_at
                        and d.get("vol_max_pct") == cfg.environment_vol_max_pct
                        and 0 <= now - d.get("checked_at", 0) <= 90):
                    reading.update(d)
            except Exception:
                pass  # Start paused if the checkpoint cannot be read.
        bars = self.candles[:-1][-(cfg.environment_er_window + 1):]
        valid = (len(bars) == cfg.environment_er_window + 1
                 and 0 <= now - self.candles_updated_at <= 90)
        if valid:
            valid = (all(b["t"] - a["t"] == 60000 for a, b in zip(bars, bars[1:]))
                     and 0 <= now - (bars[-1]["t"] / 1000 + 60) <= 90
                     and all(math.isfinite(b["c"]) and b["c"] > 0 for b in bars))
        er = compute_er_and_direction(self.candles, cfg.environment_er_window)[0] if valid else None
        er_allowed = bool(reading.get("er_allowed", reading.get("allowed", False)))
        if er is None or er < cfg.environment_er_pause_below:
            er_allowed = False
        elif er >= cfg.environment_er_resume_at:
            er_allowed = True
        vol_pct = None
        vol_allowed = True
        if cfg.environment_vol_max_pct is not None:
            vol_bars = self.candles[:-1][-cfg.environment_vol_window:]
            vol_valid = (valid and len(vol_bars) == cfg.environment_vol_window
                         and all(math.isfinite(b["h"]) and math.isfinite(b["l"])
                                 and b["h"] >= b["l"] for b in vol_bars))
            if vol_valid:
                vol_pct = sum(100 * (b["h"] - b["l"]) / b["c"] for b in vol_bars) / len(vol_bars)
            vol_allowed = vol_pct is not None and vol_pct <= cfg.environment_vol_max_pct
        allowed = er_allowed and vol_allowed
        candle_t = bars[-1]["t"] if bars else None
        # Traded-volume readout (2026-10-02, "same guard for worker 2" -- step 1 of 2, display
        # only, no gating yet). Distinct from vol_pct above, which is a volatility (high-low)
        # measure; this is actual BTC size traded, same function as Worker 1's volume-jump guard.
        traded_volume = compute_candle_volume_avg(self.candles, 10)
        traded_volume_rate = compute_candle_volume_rate(self.candles, 10)
        snapshot = {"allowed": allowed, "er": er, "candle_t": candle_t,
                    "checked_at": now, "window": cfg.environment_er_window,
                    "pause_below": cfg.environment_er_pause_below,
                    "resume_at": cfg.environment_er_resume_at,
                    "er_allowed": er_allowed, "vol_pct": vol_pct,
                    "vol_allowed": vol_allowed, "vol_max_pct": cfg.environment_vol_max_pct,
                    "vol_window": cfg.environment_vol_window,
                    "volume": traded_volume, "volume_rate": traded_volume_rate}
        reading.update(snapshot)
        key = (candle_t, allowed, er_allowed, vol_allowed, er is not None)
        if key != self._environment_logged_key:
            try:
                await self.log_run("environment_er", snapshot)
                self._environment_logged_key = key
            except Exception:
                pass  # Dashboard logging cannot interrupt stops/exits.

    def _volume_jump_allows_cycle(self):
        """2026-10-03, "build the same guard for worker 2": a fixed_direction bot (the hedge)
        never looks at entry_signal, so the ordinary entry_signal=None block in tick() that
        blocks Worker 1 has nothing to act on for these legs -- _wants_new_cycle is the actual
        entry decision point for them. self._volume_jump_paused_until is set by
        _update_volume_jump_guard earlier in the SAME tick (unconditional, every bot), so this
        just reads that already-fresh result; inert (always True) for any bot that never
        configures volume_jump_ratio, exactly like _update_volume_jump_guard's own early-out."""
        return self._volume_jump_paused_until is None or time.time() >= self._volume_jump_paused_until

    def _wants_new_cycle(self):
        """Every condition for DECLARING readiness for a new cycle (or, standalone, entering)."""
        return (self._environment_allows_cycle() and self._has_entry_pressure() and self._cycle_gap_elapsed()
                and self._has_entry_dispersion() and self._candle_unused()
                and self._volume_jump_allows_cycle())

    def _reversal_cooldown_active(self):
        """See BotConfig.post_reversal_cooldown_seconds."""
        cd = self.cfg.post_reversal_cooldown_seconds
        if cd is None or self._last_reversal_close_at is None:
            return False
        return (time.time() - self._last_reversal_close_at) < cd

    def _update_volume_jump_guard(self, state):
        """Arms/extends the guard's cooldown timer when the volume-jump ratio is at or above
        threshold, and returns whether a pause is currently active. See
        BotConfig.volume_jump_ratio for the full reasoning. The live_volume_jump_ratio dashboard
        readout is a SEPARATE write elsewhere (near live_candle_volume) -- this method only
        gates entries, it does not persist anything itself, but DOES set
        self._volume_jump_paused_until (epoch seconds, or None) as a side effect so that write
        can show WHEN the pause actually clears, not just the instant ratio reading -- a user
        watching the dashboard otherwise sees a calm current ratio and no way to tell the gate
        is still active from an earlier spike within its pause window.

        override_volume_jump_cleared_at (2026-10-03, direct request: "give me a button to
        unpause"): a manual-clear timestamp -- if the last-armed spike is AT OR BEFORE this
        marker, the pause reads inactive, regardless of pause_seconds. Deliberately NOT
        implemented as a temporary tiny pause_seconds override (tried first, live, and found
        broken): shrinking the window only LOOKS cleared -- self._last_volume_jump_at never
        actually moves, so restoring the real pause_seconds afterward recomputes the exact
        same future paused_until and silently re-arms. The cleared_at marker is compared
        against the spike timestamp directly, so a GENUINELY NEW spike after the clear (which
        sets a fresh self._last_volume_jump_at, necessarily later than cleared_at) still arms
        normally -- clearing only forgives the past, it never disables the guard going forward.

        Resolves the threshold/pause/cleared-at overrides and bails out BEFORE computing the
        ratio when the guard isn't configured at all -- not just for efficiency, but so a bot
        that never enabled this feature never calls compute_volume_jump_ratio on candle data
        that might not even carry a "v" field.

        volume_jump_release_mode (2026-10-03, direct request: "build them both... which one is
        controlling? either volume, wiggle, or rate"): an EARLY release on top of the fixed
        pause_seconds cap, not a replacement for it -- pause_seconds always stays the hard
        ceiling, matching the earlier rejected open-ended volume-recovery design's lesson (real
        data: elevated windows can run up to ~78 minutes in the extreme, see
        research/wiggle-2026-10-03). Exactly one of three metrics can drive the release, chosen
        live, never more than one at a time:
          - "volume": compute_candle_volume_avg -- the same traded-size reading the ratio itself
            is built from.
          - "wiggle": compute_intrabar_dispersion -- price-LEVEL dispersion over wiggle_window
            closed candles, raw dollars (same metric already proven on 575 real Worker 1 trades
            for a different purpose, the entry-side dispersion gate).
          - "rate": abs(compute_candle_volume_rate) -- magnitude of volume's own candle-to-candle
            change, matching the earlier session finding that a violently CHANGING volume level
            is the dangerous case, not a high-but-stable one; sign is dropped because a crash
            back down is exactly as disruptive as the spike up.
        All three are computed and cached on self (_last_wiggle / _last_volume_jump_volume /
        _last_volume_jump_rate, signed) every call regardless of mode, purely for the dashboard
        readout -- so a user can watch all three side by side before picking one to drive
        release, or with the guard off entirely.

        Release rule (direct request, keep it simple first): track each metric's PEAK since the
        spike last armed (a real crest can land a candle or two after the candle that tripped
        the ratio, so peak-tracking continues every tick the pause stays active, not just at the
        arming instant), then release once the SELECTED metric has fallen to half or less of
        its own peak. A genuinely new spike (ratio re-crosses threshold) resets all three peaks,
        same "forgive the past, not the future" philosophy as the clear marker."""
        cfg = self.cfg
        ratio_threshold = cfg.volume_jump_ratio
        pause_seconds = cfg.volume_jump_pause_seconds
        cleared_at = None
        release_mode = cfg.volume_jump_release_mode
        if cfg.schema_has_regime_overrides:
            o = state.get("override_volume_jump_ratio")
            if o is not None: ratio_threshold = float(o)
            o = state.get("override_volume_jump_pause_seconds")
            if o is not None: pause_seconds = float(o)
            o = state.get("override_volume_jump_cleared_at")
            if o is not None:
                try:
                    cleared_at = parse_iso(o).timestamp()
                except (ValueError, TypeError):
                    cleared_at = None
            o = state.get("override_volume_jump_release_mode")
            if o is not None:
                release_mode = o or None  # "" clears back to the fixed-timer-only default

        # Always compute and cache the three comparison readings -- even with the guard
        # unconfigured or release_mode off -- so the dashboard can show all three for the user
        # to compare before choosing one. volume_jump_lookback doubles as the rate's window
        # (same candle-average the rate is a delta of); wiggle gets its own window since it is a
        # different metric (price dispersion, not volume) with no reason to share one.
        wiggle = compute_intrabar_dispersion(self.candles, cfg.wiggle_window)
        volume_now = compute_candle_volume_avg(self.candles, cfg.volume_jump_lookback)
        rate_now = compute_candle_volume_rate(self.candles, cfg.volume_jump_lookback)
        rate_mag = abs(rate_now) if rate_now is not None else None
        self._last_wiggle = wiggle
        self._last_volume_jump_volume = volume_now
        self._last_volume_jump_rate = rate_now

        if ratio_threshold is None:
            self._volume_jump_paused_until = None
            self._last_release_peak = None
            return False
        ratio = compute_volume_jump_ratio(self.candles, cfg.volume_jump_lookback)
        now_s = time.time()
        is_new_spike = ratio is not None and ratio >= ratio_threshold
        if is_new_spike:
            self._last_volume_jump_at = now_s
            self._volume_jump_peak_volume = volume_now
            self._volume_jump_peak_wiggle = wiggle
            self._volume_jump_peak_rate = rate_mag
        elif self._last_volume_jump_at is not None:
            # Still inside an armed window even though THIS tick didn't itself cross the ratio
            # -- keep tracking each peak, since the real crest can land a candle or two after
            # the one that first tripped it.
            if volume_now is not None:
                self._volume_jump_peak_volume = max(self._volume_jump_peak_volume or 0.0, volume_now)
            if wiggle is not None:
                self._volume_jump_peak_wiggle = max(self._volume_jump_peak_wiggle or 0.0, wiggle)
            if rate_mag is not None:
                self._volume_jump_peak_rate = max(self._volume_jump_peak_rate or 0.0, rate_mag)
        if self._last_volume_jump_at is None:
            self._volume_jump_paused_until = None
            self._last_release_peak = None
            return False
        if cleared_at is not None and self._last_volume_jump_at <= cleared_at:
            self._volume_jump_paused_until = None
            self._last_release_peak = None
            return False
        paused_until = self._last_volume_jump_at + pause_seconds  # hard cap regardless of mode
        released_early = False
        # The peak for whichever metric is ACTIVE, cached for the dashboard (2026-10-03, direct
        # report: "I only see the timer... you need to put the volume at which it was paused" --
        # otherwise there's no way to tell a wiggle/volume/rate release is making progress versus
        # just silently riding out the fixed cap). None whenever no arm is selected.
        self._last_release_peak = {"volume": self._volume_jump_peak_volume,
                                    "wiggle": self._volume_jump_peak_wiggle,
                                    "rate": self._volume_jump_peak_rate}.get(release_mode)
        if release_mode == "volume" and self._volume_jump_peak_volume and volume_now is not None:
            released_early = volume_now <= 0.5 * self._volume_jump_peak_volume
        elif release_mode == "wiggle" and self._volume_jump_peak_wiggle and wiggle is not None:
            released_early = wiggle <= 0.5 * self._volume_jump_peak_wiggle
        elif release_mode == "rate" and self._volume_jump_peak_rate and rate_mag is not None:
            released_early = rate_mag <= 0.5 * self._volume_jump_peak_rate
        active = (now_s < paused_until) and not released_early
        self._volume_jump_paused_until = paused_until if active else None
        return active

    def _cycle_gap_elapsed(self):
        """True if enough time has passed since THIS leg went flat -- see
        BotConfig.min_cycle_gap_seconds. 0.0 (default) always returns True, i.e. no gap, the
        original instant-re-entry behaviour. _went_flat_at starts at 0.0, which is always
        "long enough ago" -- a bot that has never held a position is never gated by this."""
        gap = self.cfg.min_cycle_gap_seconds
        return gap <= 0 or (time.time() - self._went_flat_at) >= gap

    def _pressure_biased_leg_usd(self, base_usd):
        """See BotConfig.pressure_bias_enabled's docstring. No-op (returns base_usd unchanged)
        unless both pressure_bias_enabled and fixed_direction are set, or there isn't yet enough
        candle history for compute_stoch_signal to return a K at all (None, None, None) --
        fails toward the flat baseline size, never toward a guess. pressure_bias_min_usd is a
        floor, not a target -- it only ever prevents the DOWN tilt from reaching zero/negative;
        it never limits the UP tilt.

        2026-09-29, simplified per direct correction ("only one signal is read by one of the
        legs... automatically both [go in]" -- an earlier version had EACH leg compute its own
        reading off its own independently-fetched candles and merge by timestamp, needless
        complexity for what's conceptually one strategy, one signal. Now: when
        pressure_signal_hub is set (both legs of a hedge share ONE dict, wired in
        lighter_hedge_dual_leg.py's main()), only the designated owner leg
        (cfg.pressure_signal_owner=True) calls compute_stoch_signal() at all and publishes it;
        every other leg just reads whatever's in the hub, full stop -- no local computation, no
        merging, one signal for both legs."""
        cfg = self.cfg
        if not cfg.pressure_bias_enabled or cfg.fixed_direction is None:
            return base_usd
        hub = self.pressure_signal_hub
        if hub is not None:
            # Pure read for BOTH legs now. The owner leg publishes into the hub every tick from
            # tick() itself (see the pressure_signal_owner block there), so by the time either leg
            # reaches an entry the hub already holds the current reading -- no leg needs to compute
            # anything here, and there is no ordering dependency between the two legs left.
            entry_signal = hub.get("signal")
        else:
            # No hub wired: a standalone bot with pressure_bias_enabled sizes off its own reading,
            # exactly as before.
            entry_signal, _, _ = self.compute_stoch_signal()
        if entry_signal == cfg.fixed_direction:
            return base_usd + cfg.pressure_bias_usd
        if entry_signal is not None:
            return max(cfg.pressure_bias_min_usd, base_usd - cfg.pressure_bias_usd)
        return base_usd

    def _book_opposition_ratio(self, side):
        """Book-opposition early exit (2026-09-28, direct request): fraction of near-touch
        resting size opposing `side`, within cfg.book_opposition_band_pct of the CURRENT best
        bid/ask (self.live.order_book -- already streaming via the websocket subscription, no
        REST call). Long: opposition = ask size / (ask+bid) in the band; short: opposition = bid
        size / (ask+bid). All positive-size levels within the band count, not a fixed level
        count -- matches the retrospective test this was validated against exactly. Returns None
        if the book or either side is empty (fails closed -- caller treats None as no signal)."""
        ob = self.live.order_book
        bids = ob.get("bids") or []
        asks = ob.get("asks") or []
        if not bids or not asks:
            return None
        best_bid = max(float(b["price"]) for b in bids)
        best_ask = min(float(a["price"]) for a in asks)
        band = self.cfg.book_opposition_band_pct / 100
        bid_floor = best_bid * (1 - band)
        ask_ceil = best_ask * (1 + band)
        bid_size = sum(float(b["size"]) for b in bids
                       if float(b["price"]) >= bid_floor and float(b["size"]) > 0)
        ask_size = sum(float(a["size"]) for a in asks
                       if float(a["price"]) <= ask_ceil and float(a["size"]) > 0)
        total = bid_size + ask_size
        if total <= 0:
            return None
        return (ask_size / total) if side == "long" else (bid_size / total)

    def _check_book_opposition_exit(self, side, unrealized_pct, age_s):
        """True if the book-opposition early exit should fire right now. Independent of
        use_joint_adaptive -- works off live order-book state, not the signal formula, so it
        layers onto any bot's TP/SL/window math the same way. By construction only ever
        evaluates true when the position is already losing -- see BotConfig.
        book_opposition_exit_enabled's docstring for the retrospective test this was validated
        against."""
        cfg = self.cfg
        if not cfg.book_opposition_exit_enabled:
            return False
        if age_s is None or age_s < cfg.book_opposition_min_age_seconds:
            return False
        if unrealized_pct > -cfg.book_opposition_loss_pct:
            return False
        opposition = self._book_opposition_ratio(side)
        if opposition is None:
            return False
        return opposition > cfg.book_opposition_ratio_threshold

    def _entry_overconfirmed(self, side):
        """Entry-side book filter (2026-09-29, direct request): blocks a candidate entry when
        the near-touch book is ALREADY too heavily stacked in that direction. Retrospective
        test on 52 real Worker 3 entries (same 0.05% band as book-opposition, just inverted --
        confirmation = 1 - opposition): unfiltered baseline was -$0.0153 net; excluding just the
        8 trades where confirmation was >60% flipped it to +$0.0725 net (6 of those 8 were
        losses, including the two biggest losses in the set). Read: a mean-reversion signal
        firing when the book is already heavily one-sided in that direction looks more like
        arriving late to a crowded move than confirmation of a fresh one -- the OPPOSITE of the
        original hypothesis (that book support would predict a GOOD entry, which this same test
        disproved first). Small sample (8 trades) -- treat as a real, not fully proven,
        direction. Only blocks entries/reopens, never exits."""
        cfg = self.cfg
        if cfg.entry_confirmation_max_pct is None or side is None:
            return False
        opposition = self._book_opposition_ratio(side)
        if opposition is None:
            return False
        confirmation = 1 - opposition
        return confirmation > cfg.entry_confirmation_max_pct

    async def _check_flow_entry_filter(self, side, now_ms):
        """Order-flow entry veto (2026-09-27): requires BOTH (1) price hasn't already moved
        more than cfg.flow_max_adverse_move_pct against `side` over the trailing 120s, and (2)
        average aggressive trade size over the trailing 30s favors `side`. Fails CLOSED -- any
        missing data in a required window denies the entry rather than allowing it. Only gates
        a NEW entry or the reopening leg of a reversal (see call site in tick()); never affects
        an exit. is_maker_ask=True means the resting order was an ask -> the taker/aggressor
        bought."""
        cfg = self.cfg
        if not cfg.flow_entry_filter_enabled:
            return True
        now = datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc)
        cutoff = now - timedelta(seconds=1)
        start = cutoff - timedelta(seconds=125)
        try:
            rows = await self.sb(
                "GET",
                f"lighter_btc_trade_flow?select=ts,size,usd_amount,is_maker_ask"
                f"&ts=gte.{start.isoformat().replace('+', '%2B')}"
                f"&ts=lt.{cutoff.isoformat().replace('+', '%2B')}&order=ts.asc")
        except Exception:
            return False
        if not rows:
            return False
        direction = 1 if side == "long" else -1
        now_start = cutoff - timedelta(seconds=5)
        old_start = cutoff - timedelta(seconds=125)
        old_end = cutoff - timedelta(seconds=120)
        recent_start = cutoff - timedelta(seconds=30)

        def parse(r):
            return datetime.fromisoformat(r["ts"].replace("Z", "+00:00"))

        now_rows = [r for r in rows if now_start <= parse(r) < cutoff]
        old_rows = [r for r in rows if old_start <= parse(r) < old_end]
        recent_rows = [r for r in rows if recent_start <= parse(r) < cutoff]
        if not now_rows or not old_rows:
            return False
        p_now = sum(r["usd_amount"] for r in now_rows) / sum(r["size"] for r in now_rows)
        p_old = sum(r["usd_amount"] for r in old_rows) / sum(r["size"] for r in old_rows)
        price_ok = direction * 100 * (p_now / p_old - 1) >= -cfg.flow_max_adverse_move_pct

        buy_rows = [r for r in recent_rows if r["is_maker_ask"]]
        sell_rows = [r for r in recent_rows if not r["is_maker_ask"]]
        if not buy_rows or not sell_rows:
            return False
        avg_buy = sum(r["usd_amount"] for r in buy_rows) / len(buy_rows)
        avg_sell = sum(r["usd_amount"] for r in sell_rows) / len(sell_rows)
        size_ok = direction * (avg_buy - avg_sell) >= 0

        return price_ok and size_ok

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
        # The exchange is visible again, so a previously-unknown entry outcome is resolved: the
        # reconcile/adopt path in tick() now deals with whatever is actually there.
        self._entry_outcome_unknown = False
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

    async def confirm_fill(self, want_nonzero, expect_qty=None, tries=6, delay=0.25,
                           require_consecutive=1):
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
        # Distinguishes "read fine, nothing there" from "could not read at all" -- see
        # self._entry_outcome_unknown. A caller that has just placed an order MUST NOT treat the
        # second as a no-fill, because retrying then puts a second real order on the book.
        self._confirm_read_ok = True
        agreed = 0
        for attempt in range(tries):
            try:
                pos, coll = await self.get_position_rest()
            except Exception as e:
                if attempt == tries - 1:
                    await self.log_run("confirm_fill_read_failed", {"error": str(e)[:200]})
                    self._confirm_read_ok = False
                    return pos, coll, False
                await asyncio.sleep(delay)
                continue
            settled = (abs(pos) > QTY_EPS) == want_nonzero
            if settled and want_nonzero and expect_qty:
                if abs(pos) < expect_qty * 0.5:
                    settled = False
            if settled:
                agreed += 1
                # require_consecutive > 1 demands that many reads IN A ROW agree before this is
                # believed. Proven necessary 2026-09-30 with real money: the default returns on
                # the FIRST read that matches, so `tries` was only ever "how many chances to SEE
                # flat", never "how many times it must AGREE". One bad read therefore condemned a
                # live position -- both legs booked a close that had not happened, re-entered on
                # top of the position that was still there, and ended up at 2x size (the long was
                # adopted at 0.00024, the short tripped the oversize guard). The tell was the
                # long's two external closes reporting +0.00323 then -0.00323, exactly equal and
                # opposite: collateral noise, not two real closes.
                if agreed >= require_consecutive:
                    return pos, coll, True
            else:
                agreed = 0
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
        if self.cfg.debug_verbose_tick:
            print(f"[{self.cfg.worker_id}] place_order: about to call create_market_order co_idx={co_idx}", flush=True)
        try:
            order, resp, err = await asyncio.wait_for(
                self.client.create_market_order(
                    market_index=self.cfg.market_index, client_order_index=co_idx,
                    base_amount=base_amount_int, avg_execution_price=exec_price,
                    is_ask=is_ask, reduce_only=reduce_only,
                ),
                timeout=ORDER_TIMEOUT,
            )
            if self.cfg.debug_verbose_tick:
                print(f"[{self.cfg.worker_id}] place_order: create_market_order returned", flush=True)
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

    async def _place_native_stop(self, side, qty, trigger_price):
        """Place one native stop order, unconditionally -- see _sync_native_exits, which is the
        only caller and owns the cancel-first + no-op-unless-changed logic. Never call this
        directly from tick(): placing an SL and a TP separately would each cancel_all() the
        OTHER one, since Lighter has no selective cancel-by-order-id in this codebase (these
        bots never place any other resting order, so a blanket cancel is normally safe -- except
        between two native orders of our own on the same position)."""
        desired = (trigger_price, round(qty, 8))
        is_ask = (side == "long")  # closing a long = selling; closing a short = buying
        band = trigger_price * (1 - NATIVE_STOP_BAND_PCT / 100 if is_ask
                                else 1 + NATIVE_STOP_BAND_PCT / 100)
        trig_int = int(round(trigger_price * (10 ** self.cfg.price_decimals)))
        price_int = int(round(band * (10 ** self.cfg.price_decimals)))
        qty_int = int(round(qty * (10 ** self.cfg.size_decimals)))
        co_idx = int(time.time() * 1000) % 500_000_000
        try:
            _order, _resp, err = await asyncio.wait_for(
                self.client.create_sl_order(
                    market_index=self.cfg.market_index, client_order_index=co_idx,
                    base_amount=qty_int, trigger_price=trig_int, price=price_int,
                    is_ask=is_ask, reduce_only=True,
                ),
                timeout=ORDER_TIMEOUT,
            )
            if err:
                await self.log_run("native_stop_place_failed", {"error": str(err)[:200]})
                return
        except Exception as e:
            await self.log_run("native_stop_place_failed", {"error": str(e)[:200]})
            return
        self._native_stop_synced = desired
        await self.log_run("native_stop_synced", {"side": side, "trigger": trigger_price})

    async def _place_native_tp(self, side, qty, trigger_price):
        """TP sibling of _place_native_stop -- see _sync_native_exits for the only caller."""
        desired = (trigger_price, round(qty, 8))
        is_ask = (side == "long")
        band = trigger_price * (1 - NATIVE_STOP_BAND_PCT / 100 if is_ask
                                else 1 + NATIVE_STOP_BAND_PCT / 100)
        trig_int = int(round(trigger_price * (10 ** self.cfg.price_decimals)))
        price_int = int(round(band * (10 ** self.cfg.price_decimals)))
        qty_int = int(round(qty * (10 ** self.cfg.size_decimals)))
        co_idx = int(time.time() * 1000) % 500_000_000
        try:
            _order, _resp, err = await asyncio.wait_for(
                self.client.create_tp_order(
                    market_index=self.cfg.market_index, client_order_index=co_idx,
                    base_amount=qty_int, trigger_price=trig_int, price=price_int,
                    is_ask=is_ask, reduce_only=True,
                ),
                timeout=ORDER_TIMEOUT,
            )
            if err:
                await self.log_run("native_tp_place_failed", {"error": str(err)[:200]})
                return
        except Exception as e:
            await self.log_run("native_tp_place_failed", {"error": str(e)[:200]})
            return
        self._native_tp_synced = desired
        await self.log_run("native_tp_synced", {"side": side, "trigger": trigger_price})

    async def _sync_native_exits(self, side, qty, sl_trigger, tp_trigger):
        """Keep whichever native orders are enabled resting at the current trigger levels, sized
        to `qty` -- see BotConfig.native_stop_loss_enabled / native_take_profit_enabled. No-ops
        unless at least one desired (trigger, qty) pair actually changed (a fresh entry, a live
        override applied mid-position, or -- for a DCA bot -- a new leg added), so this costs
        nothing on the other ~99% of ticks.

        Always cancels and re-places BOTH enabled sides together, even if only one changed:
        Lighter has no selective cancel-by-order-id here, so a cancel_all() for just the stale
        side would also wipe out the still-valid other side, leaving the position with only one
        of its two native exits resting until the next change happened to notice. Re-placing an
        unchanged side is cheap; silently losing a side's protection is not.
        """
        cfg = self.cfg
        want_sl = cfg.native_stop_loss_enabled
        want_tp = cfg.native_take_profit_enabled and not cfg.disable_literal_tp
        if not (want_sl or want_tp):
            return
        q = round(qty, 8)
        desired_sl = (sl_trigger, q) if want_sl else None
        desired_tp = (tp_trigger, q) if want_tp else None
        if desired_sl == self._native_stop_synced and desired_tp == self._native_tp_synced:
            return
        await self.cancel_all()
        self._native_stop_synced = None
        self._native_tp_synced = None
        if want_sl:
            await self._place_native_stop(side, qty, sl_trigger)
        if want_tp:
            await self._place_native_tp(side, qty, tp_trigger)

    async def emergency_flatten(self, reason, detail):
        """Real position is larger than anything we asked for. Get flat immediately -- this is the
        guard against repeating the ~20x-leverage incident.

        Flattening is unconditional. DISABLING is not, as of 2026-09-30: a single oversize caused
        by a transient bad read used to set enabled=False permanently, which halted the strategy on
        a self-correcting glitch -- and asymmetrically, since only the leg that tripped was
        disabled while its partner stayed on, leaving the hedge stuck half-enabled waiting for a
        partner that could never come. A first occurrence now flattens and pauses entries for
        EMERGENCY_COOLDOWN, so both legs resume together through the cycle barrier. Repeat
        occurrences still hard-disable: something systematically wrong must not be retried."""
        state_before = None
        try:
            state_before = await self.get_state()
        except Exception:
            pass
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
        pos_after, coll_after, flat = await self.confirm_fill(want_nonzero=False)
        # Record the closed position like any other exit. Without this the trade table silently
        # loses a leg -- which is exactly how a properly-hedged cycle came to be displayed as
        # UNHEDGED on 2026-09-30: the partner leg existed and was flattened here, but never got a
        # row, so the dashboard could not find it.
        if state_before and state_before.get("side"):
            try:
                legs = state_before.get("legs") or []
                ae = avg_entry(legs) or state_before.get("first_entry_price")
                qty = total_qty(legs) or 0.0
                prior = state_before.get("collateral_before_entry")
                pnl = (coll_after - prior) if (prior is not None and coll_after is not None) else 0.0
                implied = ae if not qty else (
                    ae + pnl / qty if state_before["side"] == "long" else ae - pnl / qty)
                ef = None
                if self.cfg.schema_has_entry_features:
                    ef = {"entry_k": state_before.get("entry_k"),
                          "entry_balance_index": state_before.get("entry_balance_index"),
                          "entry_vol_pct": state_before.get("entry_vol_pct"),
                          "entry_dispersion": state_before.get("entry_dispersion")}
                await self.log_trade(state_before["side"], ae, implied, qty, pnl,
                                     "EMERGENCY_FLATTEN", len(legs),
                                     ms_to_iso(state_before.get("first_entry_time")),
                                     entry_features=ef)
                await self.update_state({
                    "realized_pnl_usd": (state_before.get("realized_pnl_usd") or 0.0) + pnl})
            except Exception as e:
                await self.log_run("emergency_flatten_log_failed", {"error": str(e)[:200]})
        now = time.time()
        self._emergency_flattens = [t for t in self._emergency_flattens
                                    if now - t < EMERGENCY_REPEAT_WINDOW]
        self._emergency_flattens.append(now)
        repeat = len(self._emergency_flattens) >= EMERGENCY_REPEAT_LIMIT
        self._entry_cooldown_until = now + EMERGENCY_COOLDOWN
        await self.log_run("emergency_flatten_outcome", {
            "reason": reason, "repeats_in_window": len(self._emergency_flattens),
            "disabled": repeat,
            "cooldown_s": None if repeat else EMERGENCY_COOLDOWN})
        patch = {
            "side": None, "legs": [], "first_entry_price": None,
            "first_entry_time": None, "dca_level": 0,
        }
        if repeat:
            patch["enabled"] = False
        if self.cfg.schema_has_position_bands:
            patch["position_tp_pct"] = None
            patch["position_sl_pct"] = None
        await self.update_state(patch)
        self.profit_lock_peak_pct = None
        self._saving_trough_pct = None
        if self.cfg.schema_has_profit_lock:
            try:
                await self.update_state({"profit_lock_peak_pct": None})
            except Exception:
                pass
        self._reset_breakeven_floor()
        if self.cfg.schema_has_breakeven_floor:
            try:
                await self.update_state({"cycle_partner_pnl_baseline": None})
            except Exception:
                pass
        self.position_blank_seconds = None
        if self.cfg.schema_has_joint_adaptive:
            try:
                await self.update_state({"position_blank_seconds": None})
            except Exception:
                pass
        # Stoch-turn state is in-memory only (not persisted) -- a restart mid-position just
        # means this protection doesn't resume for that position until it closes and a fresh
        # one opens, not a correctness issue worth a migration for.
        self.position_stoch_armed = False
        self.position_stoch_extreme_k = None
        self.position_stoch_activation_pct = None
        self.position_stoch_retreat_points = None
        await self.log_run("emergency_flatten", {"reason": reason, "flat": flat,
                                                 "residual": pos_after})

    # ── Entry / exit ────────────────────────────────────────────────────────────────────────
    async def try_enter(self, signal, price, leg_usd, via, candle_ts, state, collateral_hint,
                        is_trending=False):
        cfg = self.cfg
        fail_count = state.get("consecutive_entry_failures", 0) or 0
        intended_qty = leg_usd / price
        if cfg.debug_verbose_tick:
            print(f"[{cfg.worker_id}] try_enter: about to call place_order qty={intended_qty}", flush=True)
        entry_attempt_ms = self._entry_clock_ms()
        if cfg.schema_has_cycle_id and self._pending_cycle_id is not None:
            # Persist identity BEFORE sending a real order: confirmation may be unreadable,
            # or the process may restart after the fill. Side stays flat until confirmed.
            await self.update_state({"cycle_id": self._pending_cycle_id,
                                     "first_entry_time": entry_attempt_ms})
        err = await self.place_order(is_ask=(signal == "short"), base_amount=intended_qty,
                                     reduce_only=False, ref_price=price)
        if cfg.debug_verbose_tick:
            print(f"[{cfg.worker_id}] try_enter: place_order returned err={err}", flush=True)
        # `err` is deliberately not treated as failure. A timed-out or nonce-rejected request
        # can still have filled; only the exchange knows.
        if cfg.debug_verbose_tick:
            print(f"[{cfg.worker_id}] try_enter: about to call confirm_fill", flush=True)
        pos, coll, confirmed = await self.confirm_fill(want_nonzero=True, expect_qty=intended_qty)
        if cfg.debug_verbose_tick:
            print(f"[{cfg.worker_id}] try_enter: confirm_fill returned pos={pos} confirmed={confirmed}", flush=True)
        if not confirmed and not self._confirm_read_ok:
            # We placed a real order and then LOST SIGHT of the exchange, so we do not know
            # whether it filled. This is emphatically NOT a no-fill: treating it as one is what
            # sent two more orders into a WAF blackout on 2026-09-30 and left 3x the intended size
            # unmanaged on both legs. Stop entering until a position read succeeds again -- at
            # which point tick()'s ordinary reconcile either adopts whatever really filled or
            # finds us genuinely flat and free to try again. The failure counter is deliberately
            # NOT incremented: this is not evidence the entry is failing, only that we are blind,
            # and burning the circuit breaker on blindness is what disabled both legs that day.
            self._entry_outcome_unknown = True
            await self.log_run("enter_outcome_unknown", {
                "signal": signal, "via": via, "intended_qty": intended_qty,
                "error": str(err)[:200] if err else None,
                "note": "order placed but exchange unreadable -- no retry until it can be read"})
            await self.update_state({"last_processed_candle_ts": candle_ts})
            return False
        if not confirmed:
            if cfg.schema_has_cycle_id:
                # "No fill" only means not visible during confirmation retries. A later
                # read can reveal it (observed live 2026-10-02). Retain durable identity
                # for adoption; the next actual entry attempt overwrites it atomically.
                self._pending_cycle_id = None
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
            "first_entry_time": entry_attempt_ms if cfg.schema_has_cycle_id else self._entry_clock_ms(), "dca_level": 0,
            "collateral_before_entry": coll if coll is not None else collateral_hint,
            "last_processed_candle_ts": candle_ts,
        }
        regime = None
        if cfg.pure_trend_fade:
            # Every entry here only fires when is_trending was true (see tick()), so it's
            # always a faded-trend entry -- never a plain chop fade, never a trend-follow.
            regime = "trend_fade"
        elif cfg.use_joint_adaptive and self.joint_adaptive_last is not None:
            # Freeze this position's TP/SL/blanking at whatever the formula read at entry --
            # they must NOT drift later just because volatility changed while the position is
            # still open (see compute_joint_adaptive_signal's docstring). position_blank_seconds
            # is deliberately NOT bundled into `patch` below: that PATCH also carries side/legs/
            # first_entry_price, i.e. the record of a real order that already filled -- a
            # missing-column error there would fail the WHOLE write and leave a real position
            # untracked. self.position_blank_seconds (in-process) is the correctness-critical
            # copy; the DB column is a separate, best-effort, isolated write further down,
            # after the critical patch has already succeeded.
            j = self.joint_adaptive_last
            self.position_blank_seconds = j["blank_seconds"]
            # See BotConfig.profit_lock_burn_k_gate's docstring -- this position's own entry
            # %K, copied into _burned_signal_k if it later closes via PROFIT_LOCK.
            self._position_entry_k = self.live_k
            if cfg.schema_has_position_bands:
                patch["position_tp_pct"] = j["tp_pct"]
                patch["position_sl_pct"] = j["sl_pct"]
            if cfg.stoch_turn_exit_enabled:
                # Same isolated-write reasoning as position_blank_seconds above -- these never
                # touch the critical patch.
                act, retreat = joint_adaptive_stoch_turn_params(j["vol_pct"], j["tp_pct"], cfg.joint_adaptive_reference_vol_pct)
                self.position_stoch_activation_pct = act
                self.position_stoch_retreat_points = retreat
                self.position_stoch_armed = False
                self.position_stoch_extreme_k = None
            regime = "joint_adaptive"
        elif cfg.schema_has_position_bands:
            # Only bots whose table actually has these columns write them -- plain
            # fade-only bots without the migration (Worker 2) never touch this field.
            trending_leg = is_trending and cfg.trend_tp_pct is not None
            patch["position_tp_pct"] = cfg.trend_tp_pct if trending_leg else cfg.tp_pct
            patch["position_sl_pct"] = cfg.trend_sl_pct if trending_leg else cfg.sl_pct
            regime = "trend" if trending_leg else "fade"
        await self.update_state(patch)
        entry_detail = {"signal": signal, "price": price, "via": via,
                        "qty": abs(pos), "regime": regime}
        if cfg.schema_has_cycle_id and self._pending_cycle_id is not None:
            # Isolated write, same reasoning as position_blank_seconds above -- a missing-column
            # failure here must never cost us the critical patch that just recorded a real fill.
            entry_detail["cycle_id"] = self._pending_cycle_id
            try:
                await self.update_state({"cycle_id": self._pending_cycle_id})
            except Exception:
                pass  # best-effort only -- read back from state at close time regardless
        self._pending_cycle_id = None
        if cfg.schema_has_entry_features:
            # Isolated write -- see BotConfig.schema_has_entry_features. Computed fresh here
            # (not read from self.live_k, which only the pressure-bias OWNER leg keeps current)
            # so both hedge legs capture a real reading regardless of owner/follower role. A
            # missing-column failure here must never cost the critical patch above.
            snapshot = {
                "entry_k": compute_entry_stoch_k(self.candles, cfg.stoch_window),
                "entry_balance_index": compute_color_weighted_balance_index(self.candles, 5),
                "entry_vol_pct": self._measure_vol_pct(10),
                "entry_dispersion": compute_intrabar_dispersion(self.candles, 5),
            }
            entry_detail["entry_features"] = snapshot
            try:
                await self.update_state(snapshot)
            except Exception as e:
                await self.log_run("entry_features_write_failed", {"error": str(e)[:300]})
        if cfg.breakeven_floor_enabled and cfg.cycle_partner_table is not None:
            # Snapshot the partner's CUMULATIVE realized pnl now, so its pnl for this cycle can be
            # isolated later as (realized_now - baseline). Taken after the critical patch, and
            # isolated the same way position_blank_seconds is: a failure here must never leave a
            # real filled position untracked. Read ordering against the partner's own entry does
            # not matter -- realized_pnl_usd only moves when a position CLOSES, so it is identical
            # whether the partner has already entered this cycle or is about to.
            self._reset_breakeven_floor()
            try:
                rows = await self.sb(
                    "GET", f"{cfg.cycle_partner_table}?select=realized_pnl_usd&id=eq.1")
                if rows and rows[0].get("realized_pnl_usd") is not None:
                    self._breakeven_baseline = float(rows[0]["realized_pnl_usd"])
                    entry_detail["partner_pnl_baseline"] = self._breakeven_baseline
            except Exception as e:
                await self.log_run("breakeven_baseline_read_failed", {"error": str(e)[:200]})
            if cfg.schema_has_breakeven_floor:
                try:
                    await self.update_state(
                        {"cycle_partner_pnl_baseline": self._breakeven_baseline})
                except Exception:
                    pass  # best-effort only -- the in-process copy above is authoritative
        if regime == "joint_adaptive" and cfg.schema_has_joint_adaptive:
            try:
                await self.update_state({"position_blank_seconds": self.position_blank_seconds})
            except Exception:
                pass  # best-effort only -- self.position_blank_seconds above is authoritative
        if regime == "joint_adaptive":
            # Entry-time volatility/settings, for comparing live results against the replay --
            # direct request. self.joint_adaptive_last is this same tick's reading (frozen onto
            # the position above), so this is exactly what the position is actually running.
            j = self.joint_adaptive_last
            entry_detail["joint_adaptive"] = j
            if cfg.stoch_turn_exit_enabled:
                entry_detail["stoch_turn"] = {
                    "activation_pct": self.position_stoch_activation_pct,
                    "retreat_points": self.position_stoch_retreat_points,
                }
        await self.log_run("entered", entry_detail)
        return True

    async def close_all(self, reason, state, side, legs, best_bid, best_ask, candle_ts,
                        known_pos=None):
        if self.cfg.native_stop_loss_enabled or self.cfg.native_take_profit_enabled:
            # We are about to close ourselves -- clear whatever native order(s) are resting first
            # so neither can fire into a position that's already flat (or, worse, a fresh one
            # from the next cycle). Safe even if nothing is resting (cancel_all is a no-op then).
            await self.cancel_all()
            self._native_stop_synced = None
            self._native_tp_synced = None
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
        # Read back whatever try_enter persisted (survives a restart mid-position, since it comes
        # from `state`, not an in-process field). Not bundled into close_patch -- same isolation
        # reasoning as profit_lock_peak_pct below, a missing-column failure here must never cost
        # the critical close write.
        cycle_id = state.get("cycle_id") if self.cfg.schema_has_cycle_id else None
        await self.update_state(close_patch)
        if self.cfg.schema_has_cycle_id:
            try:
                await self.update_state({"cycle_id": None})
            except Exception:
                pass
        self.profit_lock_peak_pct = None
        self._saving_trough_pct = None
        if self.cfg.schema_has_profit_lock:
            try:
                await self.update_state({"profit_lock_peak_pct": None})
            except Exception:
                pass
        self._reset_breakeven_floor()
        if self.cfg.schema_has_breakeven_floor:
            try:
                await self.update_state({"cycle_partner_pnl_baseline": None})
            except Exception:
                pass
        self.position_blank_seconds = None
        if self.cfg.schema_has_joint_adaptive:
            try:
                await self.update_state({"position_blank_seconds": None})
            except Exception:
                pass
        # Stoch-turn state is in-memory only (not persisted) -- a restart mid-position just
        # means this protection doesn't resume for that position until it closes and a fresh
        # one opens, not a correctness issue worth a migration for.
        self.position_stoch_armed = False
        self.position_stoch_extreme_k = None
        self.position_stoch_activation_pct = None
        self.position_stoch_retreat_points = None
        ef = None
        if self.cfg.schema_has_entry_features:
            ef = {"entry_k": state.get("entry_k"),
                  "entry_balance_index": state.get("entry_balance_index"),
                  "entry_vol_pct": state.get("entry_vol_pct"),
                  "entry_dispersion": state.get("entry_dispersion")}
        await self.log_trade(side, ae, exit_price, qty, pnl, reason, len(legs),
                             ms_to_iso(state.get("first_entry_time")), cycle_id=cycle_id,
                             entry_features=ef)
        await self.log_run("closed", {"reason": reason, "pnl": pnl, "side": side})
        state["realized_pnl_usd"] = new_pnl
        return True

    def now_ms(self):
        return self.candles[-1]["t"] if self.candles else int(time.time() * 1000)

    def _recovered_entry_time(self, state, adopted_side):
        if (self.cfg.schema_has_cycle_id and self.cfg.fixed_direction == adopted_side
                and state.get("cycle_id") is not None and state.get("first_entry_time") is not None):
            return state["first_entry_time"]
        return self._entry_clock_ms()

    def _entry_clock_ms(self):
        """BUG FIX (2026-09-28, caught by external review, then broadened): now_ms() returns a
        CANDLE timestamp, which only advances once a minute (self.candles refreshes via REST
        once a minute) -- fine for candle-dedup bookkeeping (its original purpose), but wrong
        for measuring elapsed time against a reversal-guard window: age_s would advance in
        minute-sized jumps instead of continuously. The external review found this specifically
        for joint-adaptive's blanking window (as short as 15-60s at high volatility) and scoped
        its own patch narrowly there out of caution. The underlying flaw is structural, not
        joint-adaptive-specific -- Worker 1/2's fixed 120s guard has the exact same imprecision,
        just proportionally smaller. entry_time (real and paper) has exactly two uses anywhere
        in this file: this age comparison, and a display/log timestamp conversion -- neither
        benefits from candle-alignment, so there's no tradeoff to weigh in using true wall-clock
        time everywhere instead."""
        return int(time.time() * 1000)

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
        """Blocks new entries outside cfg.trading_hours_utc. Stateless -- just reads the
        wall-clock hour (and, for the dict form, weekday), no persistence needed. None (the
        default) disables this entirely and returns entry_signal unchanged.

        trading_hours_utc is either a flat list of allowed UTC hours (same every day), or a
        {weekday: [utc_hours]} dict for when open hours need to differ by day -- weekday
        follows Python's datetime.weekday() (Monday=0 ... Sunday=6); a weekday missing from the
        dict has no open hours that day."""
        if self.cfg.trading_hours_utc is None:
            return entry_signal
        now_utc = now_utc or datetime.now(timezone.utc)
        schedule = self.cfg.trading_hours_utc
        open_hours = schedule.get(now_utc.weekday(), []) if isinstance(schedule, dict) else schedule
        if now_utc.hour in open_hours:
            return entry_signal
        return None

    async def _check_hour_open_confirmation(self, has_open_position=False, now_utc=None):
        """Detects a closed->open transition on cfg.trading_hours_utc and re-locks real trading
        behind the standard self-lock recovery gate -- see hour_open_requires_self_lock's
        docstring for why this reuses real_trading_locked/paper_consecutive_tps directly instead
        of a separate mechanism. self._last_hour_open starts None, so the very first tick counts
        as a transition too if it's already inside an open hour (a restart has no fresher
        evidence than a real transition would). No-op unless trading_hours_utc,
        hour_open_requires_self_lock, AND self_lock_enabled are all set.

        BUG FIX (2026-09-28): the open-hour check now handles trading_hours_utc's dict form
        (weekday: hours) the same way _apply_trading_hours_gate does -- the original version
        only ever checked flat-list membership, which would have silently misread a dict's keys
        (0-6) as if they were hours, matching nothing correctly past hour 6. Never actually
        exercised before now since this whole feature was off everywhere.

        has_open_position skips re-locking entirely (2026-09-26 fix, carried over): the whole
        point is "don't assume blind" -- if a real position is already open, real trading was
        already active, there is nothing blind about it, and re-locking here would only
        needlessly gate the NEXT entry after this one closes."""
        cfg = self.cfg
        if (not cfg.hour_open_requires_self_lock or cfg.trading_hours_utc is None
                or not cfg.self_lock_enabled):
            return
        now_utc = now_utc or datetime.now(timezone.utc)
        schedule = cfg.trading_hours_utc
        open_hours = schedule.get(now_utc.weekday(), []) if isinstance(schedule, dict) else schedule
        is_open_now = now_utc.hour in open_hours
        if is_open_now and self._last_hour_open is not True and not has_open_position:
            # Deliberately NOT routed through _lock_real_trading: that helper no-ops when
            # already locked, but an hour boundary must always demand FRESH proof, even if a
            # real SL locked it seconds before 09:00 -- otherwise self_lock_hour_open_requires_tp
            # would silently miss exactly the overlap case it exists for (an hour opening on top
            # of an already-locked bot), still unlockable on whatever easier rule locked it last.
            self.real_trading_locked = True
            self.paper_consecutive_tps = 0
            self.paper_streak_has_tp = False
            self._lock_via = "hour_open"
            if cfg.schema_has_self_lock:
                await self.update_state({"real_trading_locked": True, "paper_consecutive_tps": 0})
                # Isolated write (2026-10-01): lock_via is a newer, separate column -- a missing-
                # column failure here must never cost the critical lock write above.
                try:
                    await self.update_state({"lock_via": "hour_open"})
                except Exception:
                    pass
            await self.log_run("real_trading_locked", {"via": "hour_open"})
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
            self._lock_via = state.get("lock_via")
            if (self.cfg.use_joint_adaptive and self.cfg.schema_has_joint_checkpoint
                    and self.paper_side is not None):
                # Restore paper's frozen joint-adaptive TP/SL/blanking and stoch-turn state --
                # without this, a restarted paper position silently fell back to the bot's base
                # 0.10%/0.11% with no adaptive reversal guard, which could distort both paper
                # outcomes and real unlock timing (external review finding, 2026-09-28).
                cp = state.get("paper_joint_checkpoint")
                if cp and cp.get("entry_time") == self.paper_entry_ms:
                    self.paper_joint_tp_pct = cp["tp_pct"]
                    self.paper_joint_sl_pct = cp["sl_pct"]
                    self.paper_joint_blank_s = cp["blank_seconds"]
                    self.paper_stoch_activation_pct = cp["stoch_activation_pct"]
                    self.paper_stoch_retreat_points = cp["stoch_retreat_points"]
                    self.paper_stoch_armed = cp["stoch_armed"]
                    self.paper_stoch_extreme_k = cp["stoch_extreme_k"]
                else:
                    # No checkpoint (e.g. a position opened before this upgrade) -- falls back
                    # to the bot's base TP/SL/no-guard for this one paper position rather than
                    # silently pretending it was never adaptive. Logged so the degraded state is
                    # visible, not just inferred after the fact.
                    await self.log_run("paper_joint_checkpoint_missing",
                                       {"paper_entry_ms": self.paper_entry_ms})
            if self.cfg.self_lock_relocks_on_boot:
                # Covers both a genuine restart (Render redeploys every service on every push)
                # and the bot's very first tick after being enabled fresh -- either way, never
                # silently resume real trading on unlock state left over from before. Only ever
                # forces LOCKED (a no-op via _lock_real_trading's own guard if already locked),
                # never forces unlocked.
                await self._lock_real_trading(via="boot")

    async def _lock_real_trading(self, via="real_sl"):
        """A real SL just closed (or, with self_lock_relocks_on_boot, the bot just booted/got
        turned on -- see the callers in _load_self_lock_state/tick) -- lock real order placement
        immediately. Resets the paper TP counter too: the 2-in-a-row count is always measured
        fresh from this moment forward, not carried over from whatever the shadow happened to be
        doing before. No-ops if already locked -- never redundantly re-locks or re-logs."""
        if self.real_trading_locked:
            return
        self.real_trading_locked = True
        self.paper_consecutive_tps = 0
        self.paper_streak_has_tp = False
        self._lock_via = via
        if self.cfg.schema_has_self_lock:
            await self.update_state({"real_trading_locked": True, "paper_consecutive_tps": 0})
            # Isolated write (2026-10-01): lock_via is a newer, separate column -- a missing-
            # column failure here must never cost the critical lock write above.
            try:
                await self.update_state({"lock_via": via})
            except Exception:
                pass
        await self.log_run("real_trading_locked", {"via": via})

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
                if cfg.use_joint_adaptive and self.joint_adaptive_last is not None:
                    # Freeze paper's own TP/SL/blanking too -- same reason real does (see
                    # try_enter): must not drift while this simulated position is open, and
                    # paper must run the identical rules real would, to stay a faithful mirror.
                    j = self.joint_adaptive_last
                    self.paper_joint_tp_pct = j["tp_pct"]
                    self.paper_joint_sl_pct = j["sl_pct"]
                    self.paper_joint_blank_s = j["blank_seconds"]
                    if cfg.stoch_turn_exit_enabled:
                        act, retreat = joint_adaptive_stoch_turn_params(j["vol_pct"], j["tp_pct"], cfg.joint_adaptive_reference_vol_pct)
                        self.paper_stoch_activation_pct = act
                        self.paper_stoch_retreat_points = retreat
                        self.paper_stoch_armed = False
                        self.paper_stoch_extreme_k = None
                if cfg.schema_has_self_lock:
                    await self.update_state({
                        "paper_side": self.paper_side, "paper_entry_price": self.paper_entry,
                        "paper_entry_time": self.paper_entry_ms,
                    })
            return

        side = self.paper_side
        entry = self.paper_entry
        check_price = best_bid if side == "long" else best_ask
        if cfg.use_joint_adaptive and self.paper_joint_tp_pct is not None:
            paper_tp_pct, paper_sl_pct = self.paper_joint_tp_pct, self.paper_joint_sl_pct
        else:
            paper_tp_pct, paper_sl_pct = cfg.tp_pct, cfg.sl_pct
        if side == "long":
            tp = entry * (1 + paper_tp_pct / 100); sl = entry * (1 - paper_sl_pct / 100)
            hit_sl = check_price <= sl
            hit_tp = (not cfg.disable_literal_tp) and check_price >= tp
        else:
            tp = entry * (1 - paper_tp_pct / 100); sl = entry * (1 + paper_sl_pct / 100)
            hit_sl = check_price >= sl
            hit_tp = (not cfg.disable_literal_tp) and check_price <= tp
        reason = "SL" if hit_sl else ("TP" if hit_tp else None)

        if reason is None and cfg.profit_lock_enabled:
            # Same zero-give-back trail as the real position (see the gap_hit block in tick()) --
            # kept in exact lockstep so paper stays a faithful mirror of whatever real is doing.
            unrealized_pct = (100 * (check_price - entry) / entry if side == "long"
                              else 100 * (entry - check_price) / entry)
            peak = self.paper_profit_lock_peak_pct
            new_peak = None
            if peak is None:
                if unrealized_pct >= cfg.profit_lock_trigger_pct:
                    new_peak = unrealized_pct
            elif unrealized_pct > peak:
                new_peak = unrealized_pct
            elif peak - unrealized_pct >= cfg.profit_lock_trail_pct:
                reason = "PROFIT_LOCK"
            if new_peak is not None:
                self.paper_profit_lock_peak_pct = new_peak

        if (reason is None and cfg.use_joint_adaptive and cfg.stoch_turn_exit_enabled
                and self.paper_stoch_activation_pct is not None):
            # Same protection as real (see the gap_hit block in tick()), paper's own copy so it
            # stays a faithful mirror.
            live_k = self._live_stoch_k()
            unrealized_pct = (100 * (check_price - entry) / entry if side == "long"
                              else 100 * (entry - check_price) / entry)
            armed, extreme_k, triggered = self._stoch_turn_check(
                side, unrealized_pct, live_k, self.paper_stoch_activation_pct,
                self.paper_stoch_retreat_points, self.paper_stoch_armed, self.paper_stoch_extreme_k)
            self.paper_stoch_armed = armed
            self.paper_stoch_extreme_k = extreme_k
            if triggered:
                reason = "STOCH_TURN"

        if reason is None and cfg.book_opposition_exit_enabled:
            # Same book-opposition early exit as real (see _check_book_opposition_exit's
            # docstring), paper's own copy so it stays a faithful mirror.
            age_s = (now_ms - self.paper_entry_ms) / 1000 if self.paper_entry_ms is not None else None
            unrealized_pct = (100 * (check_price - entry) / entry if side == "long"
                              else 100 * (entry - check_price) / entry)
            if self._check_book_opposition_exit(side, unrealized_pct, age_s):
                reason = "BOOK_OPPOSITION"

        reversal_ready = reversal_signal is not None and reversal_signal != side
        if cfg.use_joint_adaptive:
            blank_s = self.paper_joint_blank_s
            if reversal_ready and blank_s:
                age_s = (now_ms - self.paper_entry_ms) / 1000 if self.paper_entry_ms is not None else None
                reversal_ready = age_s is not None and age_s >= blank_s
        elif reversal_ready and cfg.reversal_guard_seconds:
            age_s = (now_ms - self.paper_entry_ms) / 1000 if self.paper_entry_ms is not None else None
            reversal_ready = age_s is not None and age_s >= cfg.reversal_guard_seconds

        if reason is None and not reversal_ready:
            return

        # Log every paper close (2026-09-28, direct request) -- previously only the CURRENT
        # paper position was ever visible (via state), with no history once it closed. Reuses
        # the runs table rather than a new one -- consistent with how lock/unlock events are
        # already logged there, no migration needed.
        close_reason = reason or "REVERSAL"
        pnl_pct = ((check_price - entry) / entry * 100 if side == "long"
                   else (entry - check_price) / entry * 100)
        paper_detail = {"side": side, "entry": entry, "exit": check_price,
                        "reason": close_reason, "pnl_pct": pnl_pct,
                        "opened_at": ms_to_iso(self.paper_entry_ms)}
        if cfg.use_joint_adaptive and self.paper_joint_tp_pct is not None:
            paper_detail["joint_adaptive"] = {
                "tp_pct": self.paper_joint_tp_pct, "sl_pct": self.paper_joint_sl_pct,
                "blank_seconds": self.paper_joint_blank_s,
            }
            if cfg.stoch_turn_exit_enabled:
                paper_detail["stoch_turn"] = {
                    "activation_pct": self.paper_stoch_activation_pct,
                    "retreat_points": self.paper_stoch_retreat_points,
                    "armed_at_close": self.paper_stoch_armed,
                }
        await self.log_run("paper_closed", paper_detail)

        unlocked_now = False
        closed_side = side
        self.paper_side = None
        self.paper_entry = None
        self.paper_entry_ms = None
        self.paper_profit_lock_peak_pct = None
        self.paper_joint_tp_pct = None
        self.paper_joint_sl_pct = None
        self.paper_joint_blank_s = None
        self.paper_stoch_armed = False
        self.paper_stoch_extreme_k = None
        self.paper_stoch_activation_pct = None
        self.paper_stoch_retreat_points = None

        # A pure reversal close (reason is None here, only reached because reversal_ready was
        # True) counts as a win too when self_lock_reversal_counts_as_win is set -- but only if
        # it actually closed favorably. A losing/breakeven reversal stays neutral (does NOT
        # reset the count, unlike a real SL) -- backtested both ways, resetting on a losing
        # reversal tested worse. STOCH_TURN follows the exact same pnl>0 rule, unconditionally
        # (not gated on self_lock_reversal_counts_as_win) -- per the source report, it can close
        # at a loss (a fast move can still beat it to SL), so it must never count as a win
        # blindly the way PROFIT_LOCK can (PROFIT_LOCK is structurally guaranteed non-negative).
        counts_as_tp = reason in ("TP", "PROFIT_LOCK")
        is_red_non_sl = False
        if not counts_as_tp and (reason == "STOCH_TURN"
                                 or (reason is None and cfg.self_lock_reversal_counts_as_win)):
            pnl_pct = ((check_price - entry) / entry * 100 if closed_side == "long"
                       else (entry - check_price) / entry * 100)
            counts_as_tp = pnl_pct > 0
            is_red_non_sl = not counts_as_tp

        if counts_as_tp:
            self.paper_consecutive_tps += 1
            if reason == "TP":
                self.paper_streak_has_tp = True
            # cfg.self_lock_require_tp_in_streak (2026-09-28, direct request): 2 wins alone
            # aren't enough to unlock if NEITHER was a literal TP -- e.g. two REVERSAL/
            # PROFIT_LOCK/STOCH_TURN wins in a row don't count on their own. The streak keeps
            # extending (counter keeps incrementing past 2, doesn't reset) until a literal TP
            # shows up somewhere in it; unlocks the moment both conditions are true together,
            # not necessarily right at the 2nd win. Only a real loss (SL) resets either flag.
            # cfg.self_lock_hour_open_requires_tp (2026-10-01) ORs in the same requirement, but
            # ONLY when self._lock_via says an hour-open relock caused the current lock -- see
            # its own docstring for why this is scoped rather than global.
            require_tp_now = (cfg.self_lock_require_tp_in_streak
                             or (cfg.self_lock_hour_open_requires_tp and self._lock_via == "hour_open"))
            tp_requirement_met = (not require_tp_now) or self.paper_streak_has_tp
            # self_lock_no_tp_fallback_wins (2026-09-28, direct request): a long enough streak
            # unlocks on its own even with no literal TP in it yet -- watched a real 7-win
            # streak (zero SL) stay locked out the entire time waiting for a TP that never came.
            fallback_met = (cfg.self_lock_no_tp_fallback_wins is not None
                            and self.paper_consecutive_tps >= cfg.self_lock_no_tp_fallback_wins)
            # self_lock_tp_unlocks_instantly (2026-09-29, direct request): a single literal TP
            # unlocks on its own, no streak-count floor at all -- bypasses the >=2 check below
            # entirely. Only reason == "TP" qualifies (not PROFIT_LOCK/REVERSAL/STOCH_TURN wins,
            # which still go through the ordinary >=2-with-requirement-met path above/below).
            instant_tp_met = cfg.self_lock_tp_unlocks_instantly and reason == "TP"
            if instant_tp_met or (self.paper_consecutive_tps >= 2 and (tp_requirement_met or fallback_met)):
                self.paper_consecutive_tps = 0
                self.paper_streak_has_tp = False
                if self.real_trading_locked:
                    self.real_trading_locked = False
                    unlocked_now = True
        elif reason in ("SL", "BOOK_OPPOSITION"):
            # BOOK_OPPOSITION treated as an SL-equivalent (2026-09-28) -- by construction it only
            # ever fires on a position that's already losing, never a win, same real-loss signal
            # SL represents, just caught earlier/smaller.
            self.paper_consecutive_tps = 0
            self.paper_streak_has_tp = False
        elif is_red_non_sl and cfg.self_lock_loss_decrements_streak:
            # 2026-09-28, direct request: a red (but non-SL) close cancels out one prior win
            # instead of being invisible -- "green, red, green" nets to 1 win, not 2. Reasoning
            # in the user's own words: a red in between is telling you the environment isn't as
            # clean as the streak alone suggests, so it should count against unlocking, not get
            # ignored. Floors at 0; if it reaches 0, treat it as a fresh start (clears
            # paper_streak_has_tp too, same as a real reset).
            self.paper_consecutive_tps = max(0, self.paper_consecutive_tps - 1)
            if self.paper_consecutive_tps == 0:
                self.paper_streak_has_tp = False

        # Same close+reopen shape as the real position: an opposite signal reopens
        # immediately, regardless of whether this close was TP/SL or a pure reversal.
        if reversal_signal is not None and reversal_signal != closed_side:
            self.paper_side = reversal_signal
            self.paper_entry = best_ask if reversal_signal == "long" else best_bid
            self.paper_entry_ms = now_ms
            if cfg.use_joint_adaptive and self.joint_adaptive_last is not None:
                j = self.joint_adaptive_last
                self.paper_joint_tp_pct = j["tp_pct"]
                self.paper_joint_sl_pct = j["sl_pct"]
                self.paper_joint_blank_s = j["blank_seconds"]
                if cfg.stoch_turn_exit_enabled:
                    act, retreat = joint_adaptive_stoch_turn_params(j["vol_pct"], j["tp_pct"], cfg.joint_adaptive_reference_vol_pct)
                    self.paper_stoch_activation_pct = act
                    self.paper_stoch_retreat_points = retreat
                    self.paper_stoch_armed = False
                    self.paper_stoch_extreme_k = None

        if cfg.schema_has_self_lock:
            patch = {
                "paper_side": self.paper_side, "paper_entry_price": self.paper_entry,
                "paper_entry_time": self.paper_entry_ms,
                "paper_consecutive_tps": self.paper_consecutive_tps,
            }
            if unlocked_now:
                patch["real_trading_locked"] = False
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
        writes real_trading_locked or any other real-trading state. Only
        purpose is to log simulated trades to lighter_btc_rsi_paper_trades so weekday vs
        weekend performance can be watched forward, on data the signal was never fit to."""
        cfg = self.cfg
        await self._load_rsi_paper_state(state)
        signal, _ts = compute_rsi_stoch_confirmed_signal(
            self.candles, stoch_period=cfg.stoch_window, require_confirmation=cfg.rsi_paper_require_confirmation,
            lo=cfg.entry_lo, hi=cfg.entry_hi)

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
        if cfg.debug_verbose_tick:
            print(f"[{cfg.worker_id}] tick: entered", flush=True)
        state = await self.get_state()
        if cfg.debug_verbose_tick:
            print(f"[{cfg.worker_id}] tick: got_state side={state.get('side')} enabled={state.get('enabled')}", flush=True)
        # Renew/claim the single-instance lock once per tick (self-throttled to LOCK_REFRESH_EVERY,
        # so this is ~0.2 writes/s, not one per tick). Done up here, before the close_requested and
        # disabled-and-flat branches below, so a paused-but-alive instance keeps OWNING its row --
        # otherwise its lock would go stale and a zombie from an earlier deploy could claim it.
        # The result only ever gates new entries; every exit path below runs regardless.
        holds_lock = await self._acquire_instance_lock()
        await self._refresh_environment(holds_lock)

        if cfg.self_lock_enabled and cfg.self_lock_relocks_on_boot:
            # Covers the one gap _load_self_lock_state's own boot-time re-lock can't: the user
            # disabling then re-enabling within the SAME running process (no restart in
            # between), where self-lock state was already loaded once and won't load again.
            # The far more common real case (a restart, which happens on every push) is handled
            # by _load_self_lock_state itself. Checked here, before the disabled+flat early
            # return below, so a False->True transition is never missed just because the bot
            # was idle in between.
            enabled_now = bool(state.get("enabled", True))
            if enabled_now and self._last_enabled_seen is False and self._self_lock_loaded:
                await self._lock_real_trading(via="enabled_toggle")
            self._last_enabled_seen = enabled_now

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
                # Do NOT trust "side is null" to mean flat. 2026-09-30: after a WAF blackout both
                # legs held a real 3x position while their rows still said flat, and the Close
                # button did nothing at all because of this early return -- the one moment it was
                # most needed. Ask the exchange instead; adopt anything that is really there so
                # the close below can act on it.
                real_pos, real_coll = None, None
                try:
                    real_pos, real_coll = await self.get_position_rest()
                except Exception as e:
                    await self.log_run("close_requested_read_failed", {"error": str(e)[:200]})
                    now = time.time()
                    self._close_retry_failures += 1
                    self._close_retry_next_at = now + tick_error_backoff_seconds(self._close_retry_failures)
                    return  # keep close_requested set -- retry rather than falsely report done
                if real_pos is not None and abs(real_pos) > QTY_EPS:
                    adopted = "long" if real_pos > 0 else "short"
                    bb, ba = self.live.best_bid_ask()
                    px = (ba if adopted == "long" else bb) or state.get("first_entry_price")
                    await self.update_state({
                        "side": adopted,
                        "legs": [{"price": px, "usd_size": px * abs(real_pos)}],
                        "first_entry_price": px, "first_entry_time": self._recovered_entry_time(state, adopted),
                        "dca_level": 0, "collateral_before_entry": real_coll})
                    await self.log_run("adopted_orphan_position", {
                        "side": adopted, "qty": abs(real_pos), "via": "close_requested"})
                    return  # next tick closes it through the ordinary path below
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

        if cfg.debug_verbose_tick:
            print(f"[{cfg.worker_id}] tick: about to compute signal, candles={len(self.candles)}", flush=True)
        if cfg.fixed_direction is not None:
            entry_signal, reversal_signal, candle_ts = compute_fixed_direction_signal(
                self.candles, cfg.fixed_direction)
            if cfg.debug_verbose_tick:
                print(f"[{cfg.worker_id}] tick: signal computed entry={entry_signal} candle_ts={candle_ts}", flush=True)
            # 2026-09-30, direct request ("put the K value on the panel for worker 2 so we can
            # see what is happening"): fixed_direction's own entry/exit decision never looks at
            # the stochastic K, so self.live_k/live_signal would otherwise sit at None forever.
            # Only the pressure-bias OWNER leg refreshes them here (display/hub source only --
            # doesn't touch entry_signal/reversal_signal above); the follower leg still never
            # computes its own, same as the sizing decision, so the dashboard only ever shows
            # the one signal actually governing both legs.
            # Gated on pressure_signal_owner ALONE, not on pressure_bias_enabled: the K readout is
            # a display/hub concern and must keep working now that the sizing tilt is off (2026-09-30,
            # legs back to equal $10/$10). Still never touches entry_signal/reversal_signal above.
            if cfg.pressure_signal_owner:
                owner_signal, _, _ = self._compute_pressure_source_signal()
                # 2026-09-30, fixing a real race: publish EVERY tick, not only at this leg's own
                # entry moment. The two legs are independent asyncio tasks on their own 0.5s tick
                # loops, and the hub used to be written solely inside _pressure_biased_leg_usd --
                # i.e. only when the owner was itself about to enter. Whichever leg reached its
                # entry code first therefore won a race, and when the follower got there first it
                # sized off the PREVIOUS cycle's signal (or None, right after boot). Publishing
                # here means the follower always reads a reading at most one tick old.
                if self.pressure_signal_hub is not None:
                    self.pressure_signal_hub["signal"] = owner_signal
        elif cfg.use_joint_adaptive:
            entry_signal, reversal_signal, candle_ts = self.compute_joint_adaptive_signal()
        elif cfg.use_adaptive_window:
            entry_signal, reversal_signal, candle_ts = self.compute_adaptive_stoch_signal()
        elif cfg.use_rsi_stoch_signal:
            entry_signal, candle_ts = compute_rsi_stoch_confirmed_signal(
                self.candles, stoch_period=cfg.stoch_window, require_confirmation=cfg.rsi_paper_require_confirmation,
                lo=cfg.entry_lo, hi=cfg.entry_hi)
            reversal_signal = entry_signal
        elif cfg.use_zscore_signal:
            entry_signal, reversal_signal, candle_ts = self.compute_zscore_signal()
        else:
            (stoch_band_entry_lo, stoch_band_entry_hi,
             stoch_band_reversal_lo, stoch_band_reversal_hi) = self._stoch_band_controls(state)
            self._stoch_band_entry_lo, self._stoch_band_entry_hi = stoch_band_entry_lo, stoch_band_entry_hi
            self._stoch_band_reversal_lo, self._stoch_band_reversal_hi = stoch_band_reversal_lo, stoch_band_reversal_hi
            entry_signal, reversal_signal, candle_ts = self.compute_stoch_signal(
                stoch_band_entry_lo, stoch_band_entry_hi, stoch_band_reversal_lo, stoch_band_reversal_hi)
        # See BotConfig.volume_regime_switch_threshold -- a full override, not an extra gate:
        # at/above the threshold this REPLACES whatever the block above just computed. See
        # _regime_controls for the four live toggles layered on top.
        (regime_stochastic_enabled, regime_zebra_enabled, regime_flip_enabled,
         regime_vol_threshold) = self._regime_controls(state)
        # _prior_candle_signal (the freshness check) reads these back rather than re-deriving
        # them, so "what would have fired one candle earlier" is judged against the SAME
        # live toggle state as this tick, not a second, possibly different DB read.
        self._regime_flip_enabled = regime_flip_enabled
        self._regime_vol_threshold = regime_vol_threshold
        flip_regime_active = False
        if regime_vol_threshold is not None:
            candle_volume_now = compute_candle_volume_avg(self.candles, cfg.volume_regime_switch_window)
            if candle_volume_now is not None and candle_volume_now >= regime_vol_threshold:
                if regime_flip_enabled:
                    flip_regime_active = True
                    entry_signal, reversal_signal, candle_ts = compute_flip_signal(
                        self.candles, cfg.flip_signal_min_trend_len, cfg.flip_signal_min_size_pct,
                        cfg.flip_signal_min_body_pct)
                else:
                    entry_signal, reversal_signal = None, None  # high-vol regime off -- sit idle
            elif not regime_stochastic_enabled:
                entry_signal, reversal_signal = None, None  # low-vol regime off -- sit idle
        vol_pct_now = (self._measure_vol_pct(cfg.min_vol_pct_lookback)
                       if cfg.min_vol_pct_to_trade is not None else None)
        low_vol_blocked = (cfg.min_vol_pct_to_trade is not None
                           and (vol_pct_now is None or vol_pct_now < cfg.min_vol_pct_to_trade))
        # Book-opposition signal-burn (2026-09-29): checked against the RAW signal, before any
        # other gate below touches entry_signal -- clears the burn the instant the live signal
        # is no longer the burned direction (even a flicker to None or the opposite side counts
        # as "genuinely went away"), then re-burns/blocks below if it's still that direction.
        signal_burned = (cfg.red_exit_burns_signal and self._burned_signal is not None
                         and entry_signal == self._burned_signal)
        if signal_burned and self._burn_reclaimed_by_k():
            self._clear_burn()
            signal_burned = False
        if cfg.red_exit_burns_signal and entry_signal != self._burned_signal:
            self._clear_burn()
        entry_overconfirmed = self._entry_overconfirmed(entry_signal)
        if signal_burned or entry_overconfirmed:
            entry_signal = None
        if cfg.use_adaptive_window and cfg.schema_has_adaptive_fields:
            # 2026-09-27: was write-on-change-only, which made the dashboard number look frozen
            # between window flips even though vol_pct is actually recomputed every tick --
            # confirmed live: window silently flipped 15->5 with the panel showing no visible
            # movement the whole time (only the window/vol_pct AT the flip moment ever got
            # written). Now also writes on a plain 10s cadence so "what is the bot doing right
            # now" stays live, not just "when did it last decide something new."
            now_s = time.time()
            window_changed = self.adaptive_last_window != self._adaptive_last_persisted_window
            time_elapsed = now_s - getattr(self, "_adaptive_last_persist_ts", 0.0)
            if window_changed or time_elapsed >= 10.0:
                self._adaptive_last_persisted_window = self.adaptive_last_window
                self._adaptive_last_persist_ts = now_s
                try:
                    await self.update_state({
                        "adaptive_last_vol_pct": self.adaptive_last_vol_pct,
                        "adaptive_last_window": self.adaptive_last_window,
                    })
                except Exception:
                    pass
        if cfg.use_joint_adaptive and cfg.schema_has_joint_adaptive:
            # Same "plain 10s cadence" fix as the V2 adaptive display above, from the start
            # this time -- a change-only write looked frozen on the dashboard for hours before
            # that was caught and fixed for V2.
            now_s = time.time()
            if now_s - self._joint_adaptive_last_persist_ts >= 10.0:
                self._joint_adaptive_last_persist_ts = now_s
                try:
                    await self.update_state({"joint_adaptive_last": self.joint_adaptive_last})
                except Exception:
                    pass
        if cfg.schema_has_live_signal:
            # "What is the paper bot looking at right now" -- live K value and direction,
            # regardless of which signal mode is active. Same plain-cadence persistence as the
            # adaptive displays, not change-only (a stuck reading looked frozen before too).
            now_s = time.time()
            if now_s - self._live_signal_persist_ts >= 10.0:
                self._live_signal_persist_ts = now_s
                patch = {"live_k": self.live_k, "live_signal": self.live_signal}
                if cfg.schema_has_exit_overrides:
                    # Live volatility for the dashboard, on the same cadence. Mean 1-min
                    # (high-low)/close% over the last 10 closed candles. Was 30 -- direct request
                    # 2026-09-30, after real tick data showed a 30-min window badly lags a real
                    # spike: at the US-open volatility jump, true 10-min vol hit 0.235% while the
                    # 30-min reading was still only 0.114%, less than half, several minutes behind.
                    # 10 min matches this being a 1-min-candle strategy -- the user's own cap on
                    # acceptable lag for a signal read against 1-min bars.
                    v = self._measure_vol_pct(10)
                    if v is not None:
                        patch["live_vol_pct"] = v
                try:
                    await self.update_state(patch)
                except Exception:
                    pass
                if cfg.volume_regime_switch_threshold is not None:
                    # Isolated best-effort write (2026-10-02, direct request: "make sure you
                    # put the volume in somewhere... so I have an idea what's happening and
                    # why the bot is losing") -- the exact traded-volume reading the regime
                    # switch itself acts on. SEPARATE call, same reasoning as the zebra/balance
                    # readout just below: a missing column (before
                    # lighter_btc_initial_live_candle_volume.sql is run) must never cost the
                    # live_k/live_vol_pct write above, which it would if merged into that same
                    # patch dict -- PostgREST rejects the whole update on one unknown column.
                    cv = compute_candle_volume_avg(self.candles, cfg.volume_regime_switch_window)
                    if cv is not None:
                        try:
                            await self.update_state({"live_candle_volume": cv})
                        except Exception:
                            pass
                    # Isolated best-effort write (2026-10-02, direct request: "a candle
                    # counter so i can see we are doing it correctly... 1 2 3 waiting for
                    # flip"). SEPARATE call for the same reason as live_candle_volume just
                    # above -- requires lighter_btc_initial_live_flip_streak.sql.
                    streak_dir, streak_len = compute_live_flip_streak(self.candles)
                    try:
                        await self.update_state({"live_flip_streak_dir": streak_dir,
                                                  "live_flip_streak_len": streak_len})
                    except Exception:
                        pass
                if cfg.volume_jump_ratio is not None:
                    # Un-nested from the volume_regime_switch_threshold block above (2026-10-03,
                    # "build the same guard for worker 2"): that gate is Worker 1's flip-regime
                    # switch specifically and the hedge never sets it, but the hedge DOES set
                    # volume_jump_ratio and needs these two columns written on its own account.
                    # Worker 1 still gets both writes -- it sets volume_jump_ratio too -- so this
                    # is a no-op change for it, just a different condition reaching the same code.
                    #
                    # Isolated best-effort write (2026-10-02, direct request: "lets try to
                    # detect the huge jump in volume") -- the volume-jump guard's own reading,
                    # shown regardless of whether the guard is actually gating entries, so it can
                    # be watched before deciding to turn gating on. Requires
                    # lighter_btc_initial_volume_jump.sql (or the hedge-leg equivalent).
                    jr = compute_volume_jump_ratio(self.candles, cfg.volume_jump_lookback)
                    if jr is not None:
                        try:
                            await self.update_state({"live_volume_jump_ratio": jr})
                        except Exception:
                            pass
                    # Separate write (2026-10-03, direct request: "it does not tell me if
                    # armed not armed") -- the instant ratio reading above can read calm while
                    # an EARLIER spike's pause is still active, which left no way to tell from
                    # the dashboard alone. self._volume_jump_paused_until is set as a side
                    # effect of _update_volume_jump_guard (gate check, elsewhere in this same
                    # tick) -- may be one tick stale here, negligible against the 10s cadence.
                    paused_until_iso = (datetime.fromtimestamp(self._volume_jump_paused_until, tz=timezone.utc).isoformat()
                                         if self._volume_jump_paused_until is not None else None)
                    try:
                        await self.update_state({"live_volume_jump_paused_until": paused_until_iso})
                    except Exception:
                        pass
                    # Two more isolated writes (2026-10-03, "build them both... show the three
                    # numbers") -- the other two release-arm candidates, read from the cache
                    # _update_volume_jump_guard already set earlier this same tick rather than
                    # recomputed here, same reasoning as paused_until_iso just above. Shown
                    # regardless of volume_jump_release_mode, same "watch before choosing" intent
                    # as live_volume_jump_ratio. Requires lighter_btc_initial_wiggle_release.sql
                    # (or the hedge-leg equivalent).
                    if self._last_wiggle is not None:
                        try:
                            await self.update_state({"live_wiggle": self._last_wiggle})
                        except Exception:
                            pass
                    if self._last_volume_jump_rate is not None:
                        try:
                            await self.update_state({"live_volume_jump_rate": self._last_volume_jump_rate})
                        except Exception:
                            pass
                    # Unconditional write, unlike the three above -- None is itself a meaningful,
                    # intentional state here (no release mode active, or not currently paused)
                    # and must overwrite a stale number left from an earlier spike, not be
                    # skipped the way "not available yet" is for the other readouts.
                    try:
                        await self.update_state({"live_volume_jump_release_peak": self._last_release_peak})
                    except Exception:
                        pass
                if cfg.color_balance_index_min is not None or cfg.color_balance_index_max is not None:
                    # Isolated best-effort write (2026-10-01) so the dashboard can show the live
                    # color-weighted balance index the entry gate is reading. Written into the
                    # SAME live_zebra_index column the zebra gate used -- it is a live readout
                    # column, not a semantic record, so no new migration is needed. A missing
                    # column must never cost the live_k write above.
                    cwi = compute_color_weighted_balance_index(
                        self.candles, cfg.color_balance_index_window)
                    try:
                        await self.update_state({"live_zebra_index": cwi})
                    except Exception:
                        pass
                elif cfg.zebra_index_min is not None or cfg.zebra_index_max is not None:
                    # Isolated best-effort write (2026-10-01) so the dashboard can show the live
                    # zebra / candle-size index the entry gate is reading. A missing column must
                    # never cost the live_k write above. Requires
                    # lighter_btc_initial_zebra_readout.sql.
                    zi = compute_zebra_size_index(self.candles, cfg.zebra_index_window)
                    try:
                        await self.update_state({"live_zebra_index": zi})
                    except Exception:
                        pass
                if (cfg.intrabar_dispersion_pause_at is not None
                        or cfg.min_intrabar_dispersion_to_enter is not None):
                    # Isolated write (2026-10-01): live_intrabar_dispersion is a newer, separate
                    # column -- a missing-column failure here must never cost the live_k/
                    # live_signal write above. Same cadence, so the dashboard panel can show
                    # exactly what the gate is seeing right now. Requires
                    # lighter_btc_initial_dispersion_readout.sql.
                    dispersion = compute_intrabar_dispersion(self.candles, cfg.intrabar_dispersion_window)
                    if dispersion is not None:
                        try:
                            await self.update_state({"live_intrabar_dispersion": dispersion})
                        except Exception:
                            pass
        if cfg.entry_confirmation_max_pct is not None and cfg.schema_has_entry_confirmation:
            # Dashboard readout for the entry-confirmation book filter (2026-09-29), same
            # cadence as live_k -- "what would the confirmation check say right now" for
            # whatever direction live_signal currently reads, even when no entry is actually
            # being attempted this tick.
            now_s = time.time()
            if now_s - self._entry_confirmation_persist_ts >= 10.0:
                self._entry_confirmation_persist_ts = now_s
                opposition = (self._book_opposition_ratio(self.live_signal)
                             if self.live_signal is not None else None)
                confirmation = (1 - opposition) if opposition is not None else None
                try:
                    await self.update_state({"entry_confirmation_last": confirmation})
                except Exception:
                    pass
        if cfg.min_vol_pct_to_trade is not None and cfg.schema_has_min_vol_gate:
            # Dashboard readout for the low-volatility entry gate (2026-09-29) -- same plain-
            # cadence persistence as live_k above, direct request ("put the settings there with
            # the K and the TP and SL and everything, volume is the most important").
            now_s = time.time()
            if now_s - self._min_vol_persist_ts >= 10.0:
                self._min_vol_persist_ts = now_s
                try:
                    await self.update_state({"min_vol_pct_last": vol_pct_now})
                except Exception:
                    pass
        if cfg.use_joint_adaptive and cfg.stoch_turn_exit_enabled and cfg.schema_has_joint_checkpoint:
            # Restart-survival checkpoint for both the real position's and paper's stoch-turn
            # state (added after external review flagged the original in-process-only design as
            # a real risk -- Render restarts every service on every push). Piggybacks on this
            # same 10s cadence rather than firing on every armed-state update; `entry_time` is
            # the identity key restore checks against, so a checkpoint from an already-closed
            # position never gets misapplied to a different one that opens before the next
            # write. Writing None (nothing open) correctly clears a stale checkpoint too.
            now_s = time.time()
            if now_s - self._joint_checkpoint_persist_ts >= 10.0:
                self._joint_checkpoint_persist_ts = now_s
                real_entry_time = state.get("first_entry_time")
                position_checkpoint = None
                if real_entry_time is not None and self.position_stoch_activation_pct is not None:
                    position_checkpoint = {
                        "entry_time": real_entry_time,
                        "activation_pct": self.position_stoch_activation_pct,
                        "retreat_points": self.position_stoch_retreat_points,
                        "armed": self.position_stoch_armed,
                        "extreme_k": self.position_stoch_extreme_k,
                    }
                paper_checkpoint = None
                if self.paper_entry_ms is not None and self.paper_joint_tp_pct is not None:
                    paper_checkpoint = {
                        "entry_time": self.paper_entry_ms,
                        "tp_pct": self.paper_joint_tp_pct, "sl_pct": self.paper_joint_sl_pct,
                        "blank_seconds": self.paper_joint_blank_s,
                        "stoch_activation_pct": self.paper_stoch_activation_pct,
                        "stoch_retreat_points": self.paper_stoch_retreat_points,
                        "stoch_armed": self.paper_stoch_armed,
                        "stoch_extreme_k": self.paper_stoch_extreme_k,
                    }
                try:
                    await self.update_state({
                        "position_stoch_checkpoint": position_checkpoint,
                        "paper_joint_checkpoint": paper_checkpoint,
                    })
                except Exception:
                    pass
        now_open = self.candles[-1]["o"] if self.candles else None
        if candle_ts is None or now_open is None:
            return
        # Captured before any gate below touches entry_signal/reversal_signal -- the paper
        # shadow always sees the plain, ungated signal, regardless of what else is layered on.
        paper_entry_signal, paper_reversal_signal = entry_signal, reversal_signal

        prior_signal = self._prior_candle_signal() if cfg.require_fresh_signal else None
        if cfg.require_fresh_signal and entry_signal is not None and entry_signal == prior_signal:
            # Stale -- this direction was ALREADY true one candle ago, not a fresh flip. Empirical
            # finding (2026-09-28): fresh entries won 65% of the time vs 43% for signals that had
            # already been sitting active for 2+ candles. Wait for the next genuine flip instead
            # of committing to a direction that's already been running for a while -- this also
            # covers the self-lock-unlock case where real trading only gets a chance to act on
            # whatever the signal happens to be at the moment it unlocks, which can be stale by
            # then even though the unlock itself was legitimate.
            entry_signal = None

        if low_vol_blocked:
            entry_signal = None

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

        # Stateless -- recomputed fresh every tick, nothing to persist or restore. See
        # BotConfig.intrabar_dispersion_pause_at's docstring.
        intrabar_dispersion_blocked = False
        if cfg.intrabar_dispersion_pause_at is not None:
            dispersion = compute_intrabar_dispersion(self.candles, cfg.intrabar_dispersion_window)
            if dispersion is not None and dispersion >= cfg.intrabar_dispersion_pause_at:
                intrabar_dispersion_blocked = True
                entry_signal = None

        # Stateless, recomputed every tick -- see BotConfig.zebra_index_min. Out of band (or no
        # reading yet) blocks new entries and a reversal's reopen leg, never an exit. Skipped
        # entirely in flip_regime_active -- this gate is tuned for the stochastic signal.
        zebra_blocked = False
        if not flip_regime_active and (cfg.zebra_index_min is not None or cfg.zebra_index_max is not None):
            zi = compute_zebra_size_index(self.candles, cfg.zebra_index_window)
            zebra_blocked = (zi is None
                             or (cfg.zebra_index_min is not None and zi < cfg.zebra_index_min)
                             or (cfg.zebra_index_max is not None and zi > cfg.zebra_index_max))
            if zebra_blocked:
                entry_signal = None

        # Stateless, recomputed every tick -- see BotConfig.color_balance_index_min. Same shape
        # as the zebra gate above; a bot normally configures one or the other, not both. Also
        # skipped in flip_regime_active (same reasoning as the zebra gate just above) and when
        # the live zebra_enabled toggle is off (see _regime_controls) -- a bot can run the raw
        # stochastic signal unfiltered without this band.
        balance_blocked = False
        if (not flip_regime_active and regime_zebra_enabled
                and (cfg.color_balance_index_min is not None or cfg.color_balance_index_max is not None)):
            cwi = compute_color_weighted_balance_index(self.candles, cfg.color_balance_index_window)
            if cfg.color_balance_index_invert:
                # Blocked INSIDE the band, allowed OUTSIDE it (needs both bounds set -- with
                # only one bound, "inside" isn't a bounded region, so nothing to invert).
                balance_blocked = (cwi is None
                                   or (cfg.color_balance_index_min is not None
                                       and cfg.color_balance_index_max is not None
                                       and cfg.color_balance_index_min <= cwi <= cfg.color_balance_index_max))
            else:
                balance_blocked = (cwi is None
                                   or (cfg.color_balance_index_min is not None and cwi < cfg.color_balance_index_min)
                                   or (cfg.color_balance_index_max is not None and cwi > cfg.color_balance_index_max))
            if balance_blocked:
                entry_signal = None

        # See BotConfig.post_reversal_cooldown_seconds -- blocks a fresh entry the same way the
        # gates above do, never an exit.
        if self._reversal_cooldown_active():
            entry_signal = None

        # See BotConfig.volume_jump_ratio -- blocks a fresh entry the same way the gates above
        # do, never an exit. volume_jump_active is reused below at the reversal-reopen gate.
        volume_jump_active = self._update_volume_jump_guard(state)
        if volume_jump_active:
            entry_signal = None

        if cfg.trading_hours_utc is not None:
            entry_signal = self._apply_trading_hours_gate(entry_signal)

        if cfg.hour_open_requires_self_lock:
            # Sets self.real_trading_locked directly on a closed->open transition -- the
            # generic "if self.real_trading_locked: entry_signal = None" check further below
            # (after _update_paper_shadow runs) picks this up the same tick, same as a real SL
            # would. No separate gating needed here.
            await self._check_hour_open_confirmation(has_open_position=state.get("side") is not None)

        if cfg.flow_entry_filter_enabled and entry_signal is not None:
            # Isolated on purpose, same guarantee as the paper-shadow loggers: a failure here
            # denies the entry (fails closed) but must never crash the rest of the tick.
            try:
                if not await self._check_flow_entry_filter(entry_signal, int(time.time() * 1000)):
                    entry_signal = None
            except Exception as e:
                await self.log_run("flow_entry_filter_error", {"error": str(e)[:300]})
                entry_signal = None

        real_pos, collateral = await self.read_position()
        if real_pos is None:
            return

        side = state.get("side")
        legs = state.get("legs") or []

        # Reconcile: something external closed us (OCO, liquidation, manual). Re-verify
        # before trusting it -- acting on a single stale read is what corrupted PnL before.
        if side is not None and abs(real_pos) < QTY_EPS:
            # 3 reads in a row must agree before believing a position vanished. A genuine close
            # stays closed; a bad read does not repeat three times. Costs ~2s before booking an
            # external close, which is nothing next to re-entering on top of a live position.
            real_pos, collateral, confirmed_flat = await self.confirm_fill(
                want_nonzero=False, tries=6, delay=0.8, require_consecutive=3)
        else:
            confirmed_flat = False
        # Only book an external close when REST agrees we are actually flat. If it disagrees,
        # real_pos/collateral now hold the authoritative reading, so fall through and manage
        # the position normally -- returning here instead is what left three live positions
        # with no TP or SL running on 2026-09-22.
        if side is not None and confirmed_flat:
            # The leading cause of an external close once a native order is resting IS that
            # order firing -- capture which levels were resting (for the SL-vs-TP inference
            # below) before resetting so the next entry resyncs fresh ones.
            last_native_sl = self._native_stop_synced[0] if self._native_stop_synced else None
            last_native_tp = self._native_tp_synced[0] if self._native_tp_synced else None
            if cfg.native_stop_loss_enabled:
                self._native_stop_synced = None
            if cfg.native_take_profit_enabled:
                self._native_tp_synced = None
            prior = state.get("collateral_before_entry")
            pnl = (collateral - prior) if (prior is not None and collateral is not None) else 0.0
            ae = avg_entry(legs) or state.get("first_entry_price")
            qty = total_qty(legs) or 0.0001
            implied_exit = (ae + pnl / qty) if side == "long" else (ae - pnl / qty)
            ext_cycle_id = state.get("cycle_id") if cfg.schema_has_cycle_id else None
            ext_patch = {"side": None, "legs": [], "first_entry_price": None,
                        "first_entry_time": None, "dca_level": 0,
                        "realized_pnl_usd": state["realized_pnl_usd"] + pnl}
            if cfg.schema_has_position_bands:
                ext_patch["position_tp_pct"] = None
                ext_patch["position_sl_pct"] = None
            await self.update_state(ext_patch)
            self.profit_lock_peak_pct = None
            if cfg.schema_has_profit_lock:
                try:
                    await self.update_state({"profit_lock_peak_pct": None})
                except Exception:
                    pass
            self._reset_breakeven_floor()
            if cfg.schema_has_breakeven_floor:
                try:
                    await self.update_state({"cycle_partner_pnl_baseline": None})
                except Exception:
                    pass
            self.position_blank_seconds = None
            if cfg.schema_has_joint_adaptive:
                try:
                    await self.update_state({"position_blank_seconds": None})
                except Exception:
                    pass
            self.position_stoch_armed = False
            self.position_stoch_extreme_k = None
            self.position_stoch_activation_pct = None
            self.position_stoch_retreat_points = None
            # With a native order resting, this path is the EXPECTED way a TP/SL now happens
            # (the exchange closes it, not our own close_all) -- infer which one by comparing the
            # actual fill to whichever resting trigger it landed closer to, so it reads as the
            # designed outcome in win/loss stats, not an anomaly. Bots with neither native order
            # keep "EXTERNAL": for them an unrequested close really is unexplained.
            candidates = [("SL", last_native_sl), ("TP", last_native_tp)]
            candidates = [(r, t) for r, t in candidates if t is not None]
            ext_reason = (min(candidates, key=lambda c: abs(implied_exit - c[1]))[0]
                         if candidates else "EXTERNAL")
            if cfg.schema_has_cycle_id and ext_cycle_id is not None:
                try:
                    await self.update_state({"cycle_id": None})
                except Exception:
                    pass
            ef = None
            if cfg.schema_has_entry_features:
                ef = {"entry_k": state.get("entry_k"),
                      "entry_balance_index": state.get("entry_balance_index"),
                      "entry_vol_pct": state.get("entry_vol_pct"),
                      "entry_dispersion": state.get("entry_dispersion")}
            await self.log_trade(side, ae, implied_exit, qty, pnl, ext_reason, len(legs),
                                 ms_to_iso(state.get("first_entry_time")), cycle_id=ext_cycle_id,
                                 entry_features=ef)
            await self.log_run("resolved_externally", {"side": side, "pnl": pnl, "reason": ext_reason})
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

        if cfg.use_joint_adaptive and cfg.stoch_turn_exit_enabled:
            self._update_partial_minute(best_bid, best_ask, self._entry_clock_ms())

        if cfg.rsi_paper_test_enabled:
            # Isolated on purpose: a failure here (e.g. the migration hasn't run yet) must
            # never abort the rest of this tick -- real TP/SL management runs below this line,
            # and this paper-only experiment is not allowed to delay it even transiently.
            try:
                await self._update_rsi_paper_shadow(state, best_bid, best_ask, self.now_ms())
            except Exception as e:
                await self.log_run("rsi_paper_shadow_error", {"error": str(e)[:300]})

        if cfg.self_lock_enabled:
            await self._update_paper_shadow(state, paper_entry_signal, paper_reversal_signal,
                                            best_bid, best_ask, self._entry_clock_ms())
            # Same tick the unlock happens: if a signal is already live, real trading fires on
            # it immediately, not on a delay -- only gates when still locked right now.
            if self.real_trading_locked:
                entry_signal = None

        if side is not None:
            self._was_in_position = True
            # Holding: not a candidate for a fresh cycle entry, so make sure no stale readiness is
            # left sitting in the barrier from before this position opened.
            self._cycle_gate_withdraw()
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
            #
            # Gated on schema_has_position_bands exactly like every WRITE to these two columns
            # is (see the patches in try_enter/close_all/the external-resolve path). Proven
            # necessary 2026-09-30, real money: the hedge legs leave that flag False, so they
            # never write these columns -- but this read had no such guard, so the SHORT leg kept
            # honouring position_sl_pct=0.0909 left behind in lighter_stoch_dca_btc_state by the
            # retired Worker 3 joint-adaptive strategy that owned the table before the hedge
            # pivot. Its real stop was 3x wider than the configured 0.03%, which is exactly the
            # reported "the winning leg closes and we stay with the bad leg": price up meant the
            # long trailed out for ~+0.02% while the short bled to -0.0909%. A bot that never
            # writes these columns must never read them.
            bands = cfg.schema_has_position_bands
            pos_tp = state.get("position_tp_pct") if bands else None
            pos_sl = state.get("position_sl_pct") if bands else None
            # Manual exit levers win over both the recorded band and the compiled-in default.
            ov_sl, ov_trig, ov_trail, ov_tp, exit_mode = self._exit_params(state)
            # exit_mode (2026-10-03, direct request: "a panel where i can change between trail
            # and TP so i can test multiple strategies") -- "trail" (default) is unchanged
            # behavior: disable_literal_tp / profit_lock_enabled exactly as compiled. "tp" flips
            # BOTH together, matching the research handoff's recommended controlled comparison
            # (a literal TP and the profit-lock trail are alternate winner-exit styles, not
            # meant to run partially mixed). SL is NEVER touched by exit_mode -- it is the one
            # protection that stays in place regardless of which winner-exit style is active.
            tp_enabled = (not cfg.disable_literal_tp) if exit_mode == "trail" else (exit_mode == "tp")
            trail_enabled = cfg.profit_lock_enabled if exit_mode == "trail" else False
            pos_tp = pos_tp if pos_tp is not None else ov_tp
            pos_sl = pos_sl if pos_sl is not None else ov_sl
            if cfg.schema_has_exit_overrides and state.get("override_sl_pct") is not None:
                pos_sl = ov_sl
            tp = round_trigger(ae * (1 + pos_tp / 100 if side == "long" else 1 - pos_tp / 100),
                               up=(side == "long"))
            sl = round_trigger(state["first_entry_price"] * (1 - pos_sl / 100 if side == "long"
                                                             else 1 + pos_sl / 100),
                               up=(side != "long"))
            if cfg.native_stop_loss_enabled or cfg.native_take_profit_enabled:
                qty_now = total_qty(legs)
                if qty_now > 0:
                    await self._sync_native_exits(side, qty_now, sl, tp)
            check_price = best_bid if side == "long" else best_ask
            gap_hit = None
            if side == "long":
                if check_price <= sl:
                    gap_hit = "SL"
                elif tp_enabled and check_price >= tp:
                    gap_hit = "TP"
            else:
                if check_price >= sl:
                    gap_hit = "SL"
                elif tp_enabled and check_price <= tp:
                    gap_hit = "TP"

            if gap_hit is None and cfg.saving_lock_arm_frac_of_sl is not None and ae:
                # Saving lock -- see BotConfig.saving_lock_arm_frac_of_sl.
                unrealized_pct = (100 * (check_price - ae) / ae if side == "long"
                                  else 100 * (ae - check_price) / ae)
                if self._saving_trough_pct is None or unrealized_pct < self._saving_trough_pct:
                    self._saving_trough_pct = unrealized_pct
                arm_at = -cfg.saving_lock_arm_frac_of_sl * pos_sl
                if self._saving_trough_pct <= arm_at and unrealized_pct >= cfg.saving_lock_exit_pct:
                    gap_hit = "SAVING_LOCK"

            if (gap_hit is None and cfg.index_exit_on_green and ae
                    and (cfg.color_balance_index_min is not None
                         or cfg.color_balance_index_max is not None)):
                # Index-exit-on-green -- see BotConfig.index_exit_on_green.
                unrealized_pct = (100 * (check_price - ae) / ae if side == "long"
                                  else 100 * (ae - check_price) / ae)
                if unrealized_pct > 0:
                    cwi = compute_color_weighted_balance_index(
                        self.candles, cfg.color_balance_index_window)
                    out_of_band = cwi is not None and (
                        (cfg.color_balance_index_min is not None and cwi < cfg.color_balance_index_min)
                        or (cfg.color_balance_index_max is not None and cwi > cfg.color_balance_index_max))
                    if out_of_band:
                        gap_hit = "INDEX_EXIT"

            if gap_hit is None and trail_enabled and ae:
                # Restore from the DB once per boot if a prior run persisted a peak (only
                # possible once the profit_lock_peak_pct migration has actually been run) --
                # safe to read even if the column doesn't exist yet (state.get just returns
                # None; only a WRITE to a missing column errors).
                if not self._profit_lock_restored:
                    self._profit_lock_restored = True
                    if self.profit_lock_peak_pct is None and state.get("profit_lock_peak_pct") is not None:
                        self.profit_lock_peak_pct = state["profit_lock_peak_pct"]
                unrealized_pct = (100 * (check_price - ae) / ae if side == "long"
                                  else 100 * (ae - check_price) / ae)
                peak = self.profit_lock_peak_pct
                new_peak = None
                if peak is None:
                    if unrealized_pct >= ov_trig:
                        new_peak = unrealized_pct
                elif unrealized_pct > peak:
                    new_peak = unrealized_pct
                elif peak - unrealized_pct >= ov_trail:
                    gap_hit = "PROFIT_LOCK"
                if (gap_hit is None and peak is not None
                        and cfg.profit_lock_respects_breakeven_floor
                        and self._breakeven_floor_pct is not None
                        and unrealized_pct <= self._breakeven_floor_pct):
                    # See BotConfig.profit_lock_respects_breakeven_floor: the floor sits ABOVE
                    # peak - trail here, so it is the binding exit level.
                    gap_hit = "BREAKEVEN_LOCK"
                if new_peak is not None:
                    self.profit_lock_peak_pct = new_peak
                    if cfg.schema_has_profit_lock:
                        try:
                            await self.update_state({"profit_lock_peak_pct": new_peak})
                        except Exception:
                            pass  # best-effort only -- in-memory tracking above is authoritative

            if gap_hit is None and cfg.breakeven_floor_enabled and ae:
                # Breakeven floor -- see BotConfig.breakeven_floor_enabled. Checked AFTER the
                # profit-lock trail so that whichever protects more fires first: above
                # profit_lock_trigger_pct the trail normally stops a slide well before it ever
                # reaches the floor, and between the floor and the trigger this is the only
                # protection there is.
                if not self._breakeven_restored:
                    self._breakeven_restored = True
                    if self._breakeven_baseline is None:
                        persisted = state.get("cycle_partner_pnl_baseline")
                        if persisted is not None:
                            # Restart mid-position: recover the baseline so the floor survives the
                            # deploy that killed us. Safe to read even without the migration.
                            self._breakeven_baseline = float(persisted)
                unrealized_pct = (100 * (check_price - ae) / ae if side == "long"
                                  else 100 * (ae - check_price) / ae)
                if self._breakeven_floor_pct is None:
                    partner_side, partner_cycle_pnl = await self._read_partner_cycle_pnl()
                    if partner_side is not None:
                        self._breakeven_partner_seen = True
                    elif partner_cycle_pnl:
                        # Partner is flat AND its realized pnl has moved since our entry, so it
                        # closed a position during our position's life and its contribution to
                        # this cycle is final -- the floor can be fixed for good.
                        #
                        # Deliberately keyed on the pnl DELTA rather than on having caught the
                        # partner mid-position in _breakeven_partner_seen: the partner read is
                        # throttled to 1/s, so a partner that opens and hits its own 0.03% SL
                        # between two of our polls would never be observed open at all, and a
                        # seen-gate would silently skip the floor on exactly the fast cycles it is
                        # most needed for. A moved baseline is strictly better evidence anyway --
                        # realized_pnl_usd only changes when a position closes.
                        floor = self.breakeven_floor_pct(
                            partner_cycle_pnl, total_qty(legs) * ae if legs else None,
                            cfg.fixed_partner_cut_floor_pct)
                        if floor is not None:
                            self._breakeven_floor_pct = floor
                            await self.log_run("breakeven_floor_armed", {
                                "floor_pct": round(floor, 5),
                                "partner_cycle_pnl": partner_cycle_pnl,
                                "own_notional_usd": round(total_qty(legs) * ae, 4),
                            })
                floor_pct = self._breakeven_floor_pct
                if floor_pct is not None and cfg.partner_cut_arms_trail_immediately:
                    # See BotConfig.partner_cut_arms_trail_immediately -- arm the ordinary
                    # profit-lock trail RIGHT NOW at wherever this leg currently sits, instead of
                    # the margin-gated floor/BREAKEVEN_LOCK exit below. Only sets the peak; the
                    # profit-lock block above (which already ran this tick) picks it up and starts
                    # tracking/exiting through its normal PROFIT_LOCK path from the NEXT tick on --
                    # same trail_pct buffer as always.
                    if self.profit_lock_peak_pct is None:
                        self.profit_lock_peak_pct = unrealized_pct
                        if cfg.schema_has_profit_lock:
                            try:
                                await self.update_state(
                                    {"profit_lock_peak_pct": unrealized_pct})
                            except Exception:
                                pass  # best-effort only -- in-memory copy above is authoritative
                        await self.log_run("trail_armed_on_partner_cut",
                                           {"unrealized_pct": round(unrealized_pct, 5)})
                elif floor_pct is not None:
                    # The floor only goes live once this leg has traded a clear margin ABOVE it --
                    # not merely at it. Proven necessary live on 2026-09-30, first session with the
                    # floor enabled: in a symmetric hedge the winner is sitting at roughly +X% at
                    # the exact moment the loser is cut at -X%, so a floor of X% armed precisely
                    # where the winner already stood and the first tick of noise took it out. Every
                    # cycle then closed at dead breakeven -- long +0.00286 / short -0.00298, long
                    # +0.00395 / short -0.00356 -- which is a guaranteed zero, not a strategy.
                    # Guaranteeing breakeven that way also guarantees never profiting.
                    #
                    # The margin is the trail width, giving the rule as originally stated: with
                    # equal $10 legs and a 0.03% cut, the floor sits at 0.03% but stays dormant
                    # until the winner reaches 0.04%, and only then locks 0.03% in. Above 0.05%
                    # the ordinary profit-lock trail takes over and normally fires first.
                    arm_at = floor_pct + cfg.breakeven_floor_arm_margin_pct
                    if unrealized_pct >= arm_at:
                        self._breakeven_reached = True
                    elif self._breakeven_reached and unrealized_pct <= floor_pct:
                        gap_hit = "BREAKEVEN_LOCK"

            if (cfg.use_joint_adaptive and cfg.stoch_turn_exit_enabled
                    and cfg.schema_has_joint_checkpoint and not self._position_stoch_restored):
                self._position_stoch_restored = True
                cp = state.get("position_stoch_checkpoint")
                if cp and cp.get("entry_time") == state.get("first_entry_time"):
                    if self.position_stoch_activation_pct is None:
                        self.position_stoch_activation_pct = cp["activation_pct"]
                        self.position_stoch_retreat_points = cp["retreat_points"]
                        self.position_stoch_armed = cp["armed"]
                        self.position_stoch_extreme_k = cp["extreme_k"]
                else:
                    # A real position is open (this code only runs inside that branch) but no
                    # matching checkpoint exists -- e.g. it was opened before this upgrade.
                    # Protection stays off for this one position until it closes and a fresh
                    # one opens; logged so that's visible, not just inferred after the fact.
                    await self.log_run("position_stoch_checkpoint_missing",
                                       {"first_entry_time": state.get("first_entry_time")})

            if (gap_hit is None and cfg.use_joint_adaptive and cfg.stoch_turn_exit_enabled
                    and ae and self.position_stoch_activation_pct is not None):
                # Profit-armed trail on the LIVE stochastic K (external research, 2026-09-28) --
                # see _stoch_turn_check's docstring. Deliberately checked here, alongside/after
                # profit-lock and before the reversal-guard block below: it can fire even during
                # the ordinary reversal blanking period (it's a hard exit like TP/SL/PROFIT_LOCK,
                # not a signal reversal), which is why it goes through gap_hit and NOT
                # reversal_ready.
                live_k = self._live_stoch_k()
                unrealized_pct = (100 * (check_price - ae) / ae if side == "long"
                                  else 100 * (ae - check_price) / ae)
                armed, extreme_k, triggered = self._stoch_turn_check(
                    side, unrealized_pct, live_k, self.position_stoch_activation_pct,
                    self.position_stoch_retreat_points, self.position_stoch_armed,
                    self.position_stoch_extreme_k)
                self.position_stoch_armed = armed
                self.position_stoch_extreme_k = extreme_k
                if triggered:
                    gap_hit = "STOCH_TURN"

            if gap_hit is None and cfg.book_opposition_exit_enabled and ae:
                # Book-opposition early exit (2026-09-28, direct request) -- see
                # _check_book_opposition_exit's docstring. Independent of use_joint_adaptive,
                # checked alongside/after the other hard exits above for the same reason
                # STOCH_TURN is: it's a real exit like TP/SL, not a signal reversal, so it goes
                # through gap_hit and can fire even during the reversal blanking period.
                entry_time = state.get("first_entry_time")
                age_s = ((self._entry_clock_ms() - entry_time) / 1000
                         if entry_time is not None else None)
                unrealized_pct = (100 * (check_price - ae) / ae if side == "long"
                                  else 100 * (ae - check_price) / ae)
                if self._check_book_opposition_exit(side, unrealized_pct, age_s):
                    gap_hit = "BOOK_OPPOSITION"

            reversal_ready = reversal_signal is not None and reversal_signal != side
            if cfg.use_joint_adaptive:
                # Restore from the DB once per boot -- see the identical profit-lock restore
                # just above for why this is safe even without the migration (reads never
                # error on a missing column, only writes do).
                if not self._position_blank_restored:
                    self._position_blank_restored = True
                    if (self.position_blank_seconds is None
                            and state.get("position_blank_seconds") is not None):
                        self.position_blank_seconds = state["position_blank_seconds"]
                blank_s = self.position_blank_seconds
                if reversal_ready and blank_s:
                    entry_time = state.get("first_entry_time")
                    age_s = (self._entry_clock_ms() - entry_time) / 1000 if entry_time is not None else None
                    reversal_ready = age_s is not None and age_s >= blank_s
            elif reversal_ready and cfg.reversal_guard_seconds:
                entry_time = state.get("first_entry_time")
                age_s = (self._entry_clock_ms() - entry_time) / 1000 if entry_time is not None else None
                reversal_ready = age_s is not None and age_s >= cfg.reversal_guard_seconds

            if gap_hit:
                closed_ok = await self.close_all(gap_hit, state, side, legs, best_bid, best_ask,
                                                 candle_ts, known_pos=real_pos)
                if closed_ok and gap_hit in ("SL", "BOOK_OPPOSITION") and cfg.self_lock_enabled:
                    await self._lock_real_trading()
                if closed_ok and cfg.red_exit_burns_signal:
                    # SL/BOOK_OPPOSITION are always red by construction; STOCH_TURN can go
                    # either way (a fast move can beat it to SL), so check actual pnl for that
                    # one. TP/PROFIT_LOCK never burn -- structurally can't be red.
                    # SAVING_LOCK burns too: the signal already went bad once, so wait for a
                    # genuinely new one instead of re-entering the same read at the same price.
                    gap_hit_red = gap_hit in ("SL", "BOOK_OPPOSITION", "SAVING_LOCK") or (
                        gap_hit == "STOCH_TURN" and ae
                        and ((check_price - ae) / ae if side == "long" else (ae - check_price) / ae) <= 0)
                    if gap_hit_red:
                        self._burned_signal = side
                        self._burned_signal_via = "red"
                        self._burned_signal_k = None
                if closed_ok and gap_hit == "PROFIT_LOCK" and cfg.profit_lock_burns_signal:
                    # Always fires (unconditional, unlike red_exit_burns_signal's pnl check) --
                    # PROFIT_LOCK is structurally guaranteed non-negative, so this isn't about
                    # loss avoidance, it's "take the small win, wait for a genuinely new signal."
                    self._burned_signal = side
                    self._burned_signal_via = "profit_lock"
                    self._burned_signal_k = self._position_entry_k
            elif reversal_ready:
                closed_ok = await self.close_all("REVERSAL", state, side, legs,
                                                 best_bid, best_ask, candle_ts,
                                                 known_pos=real_pos)
                if closed_ok and cfg.post_reversal_cooldown_seconds is not None:
                    self._last_reversal_close_at = time.time()
                if closed_ok and cfg.red_exit_burns_signal and ae:
                    reversal_red = ((check_price - ae) / ae if side == "long"
                                    else (ae - check_price) / ae) <= 0
                    if reversal_red:
                        self._burned_signal = side
                        self._burned_signal_via = "red"
                        self._burned_signal_k = None
                if not closed_ok:
                    return
                fresh = await self.get_state()
                fail_count = fresh.get("consecutive_entry_failures", 0) or 0
                eq = (cfg.fixed_leg_usd if cfg.fixed_leg_usd is not None
                      else fresh["seed_usd"] + fresh["realized_pnl_usd"])
                eq = self._pressure_biased_leg_usd(eq)
                if not fresh.get("enabled"):
                    return
                if not holds_lock:
                    # Another live instance owns this row. The close leg of the reversal already
                    # ran above (exits are never gated on the lock); only the REOPEN is blocked.
                    await self.update_state({"last_processed_candle_ts": candle_ts})
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
                reopen_flow_blocked = False
                if cfg.flow_entry_filter_enabled:
                    try:
                        reopen_flow_blocked = not await self._check_flow_entry_filter(
                            reversal_signal, int(time.time() * 1000))
                    except Exception as e:
                        await self.log_run("flow_entry_filter_error", {"error": str(e)[:300], "via": "reversal"})
                        reopen_flow_blocked = True
                reopen_stale = (cfg.require_fresh_signal and reversal_signal == prior_signal)
                reopen_burned = (cfg.red_exit_burns_signal
                                 and reversal_signal == self._burned_signal)
                if reopen_burned and self._burn_reclaimed_by_k():
                    self._clear_burn()
                    reopen_burned = False
                reopen_overconfirmed = self._entry_overconfirmed(reversal_signal)
                if (self.entry_vol_paused or intrabar_dispersion_blocked or zebra_blocked
                        or balance_blocked or self._reversal_cooldown_active() or volume_jump_active
                        or (cfg.self_lock_enabled and self.real_trading_locked)
                        or (cfg.trading_hours_utc is not None
                            and self._apply_trading_hours_gate(reversal_signal) is None)
                        or reopen_flow_blocked or reopen_stale or low_vol_blocked or reopen_burned
                        or reopen_overconfirmed):
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
                    "first_entry_price": price, "first_entry_time": self._recovered_entry_time(state, adopted),
                    "dca_level": 0, "collateral_before_entry": collateral,
                    "last_processed_candle_ts": candle_ts})
                await self.log_run("adopted_orphan_position", {"side": adopted, "qty": abs(real_pos)})
            else:
                if self._was_in_position:
                    self._was_in_position = False
                    self._went_flat_at = time.time()
                # Mirror fallback (2026-09-27, Worker 3 only): real just went flat (e.g. a
                # manual close) while the paper shadow -- running the identical signal -- is
                # already holding a position from an earlier valid entry that's since gone
                # quiet (compute_*_signal is level-triggered on the current candle only; it
                # doesn't keep firing once price has drifted back out of the extreme zone, so
                # a freshly-flat real bot has nothing to enter on even though paper is still
                # riding a perfectly live position). Only kicks in while genuinely unlocked --
                # never overrides the self-lock, which is checked the same way real entries
                # already are (entry_signal is nulled above at "if self.real_trading_locked").
                mirror_signal = None
                if (entry_signal is None and cfg.mirror_paper_position and cfg.self_lock_enabled
                        and not self.real_trading_locked and self.paper_side is not None):
                    mirror_signal = self.paper_side
                effective_signal = entry_signal if entry_signal is not None else mirror_signal
                # Everything that could still stop this entry is resolved BEFORE asking the cycle
                # barrier, so a leg never declares itself ready for a cycle it then declines to
                # join -- that would hold its partner up for nothing.
                # Split deliberately. `wants_in` is the set of conditions that must hold to place
                # an order AT ALL (they are about this process's own safety). The pressure gate is
                # different: it decides whether to ASK for a new cycle, and must NOT be re-checked
                # once the barrier has already cleared this leg -- see _cycle_gate_clear_to_enter.
                wants_in = (effective_signal is not None and state.get("enabled") and holds_lock
                            # Never send a second entry while a previous one's fate is unknown.
                            and not self._entry_outcome_unknown
                            # ...nor during the cooldown after an emergency flatten.
                            and time.time() >= self._entry_cooldown_until)
                partner_flat = True
                if wants_in and cfg.cycle_partner_table is not None:
                    # In-process barrier when one is wired (the hedge); it supersedes the DB poll
                    # entirely rather than layering on top -- see _cycle_gate_clear_to_enter for
                    # why the poll alone let the legs desync into naked single-leg trades.
                    gate = self._cycle_gate_clear_to_enter(want=self._wants_new_cycle())
                    if gate and self.cycle_hub is not None:
                        self._pending_cycle_id = self.cycle_hub.get("cycle_id")
                    partner_flat = (await self._partner_is_flat() if gate is None else gate)
                elif wants_in:
                    # No cycle partner: this leg's own entry condition is pressure AND the gap.
                    wants_in = self._wants_new_cycle()
                if not wants_in:
                    self._cycle_gate_withdraw()
                if cfg.debug_verbose_tick:
                    print(f"[{cfg.worker_id}] tick: effective_signal={effective_signal} enabled={state.get('enabled')} partner_flat={partner_flat}", flush=True)
                if wants_in and partner_flat:
                    # one_cycle_per_candle: this candle is spent the moment an entry is attempted.
                    self._last_cycle_candle_t = self._current_candle_t()
                    fail_count = state.get("consecutive_entry_failures", 0) or 0
                    if fail_count >= 3:
                        # Hard stop rather than another retry -- unbounded retries are what
                        # stacked 19 real orders into one position on 2026-09-21.
                        await self.log_run("entry_circuit_breaker",
                                           {"signal": effective_signal, "fail_count": fail_count})
                        await self.update_state({"enabled": False,
                                                 "last_processed_candle_ts": candle_ts})
                        return
                    eq = (cfg.fixed_leg_usd if cfg.fixed_leg_usd is not None
                          else state["seed_usd"] + state["realized_pnl_usd"])
                    eq = self._pressure_biased_leg_usd(eq)
                    if eq <= 0:
                        await self.log_run("equity_non_positive", {"eq": eq})
                        await self.update_state({"enabled": False,
                                                 "last_processed_candle_ts": candle_ts})
                        return
                    via = "entry" if entry_signal is not None else "mirror_paper"
                    price = best_ask if effective_signal == "long" else best_bid
                    if cfg.debug_verbose_tick:
                        print(f"[{cfg.worker_id}] tick: about to call try_enter, price={price} eq={eq}", flush=True)
                    await self.try_enter(effective_signal, price, eq, via, candle_ts,
                                         state, collateral, is_trending=is_trending)
                    if cfg.debug_verbose_tick:
                        print(f"[{cfg.worker_id}] tick: try_enter returned", flush=True)
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

    async def run(self, account_index=None, api_key_index=None, api_private_key=None):
        """account_index/api_key_index/api_private_key: explicit credential override, for a
        single process driving more than one sub-account concurrently (see
        lighter_hedge_dual_leg.py) -- each StochBot instance needs its own distinct
        credentials, which a single process's os.environ can't hold two of at once under the
        same key names. Default (None) preserves the original behavior every other bot still
        uses: read from the process's own LIGHTER_ACCOUNT_INDEX/LIGHTER_API_KEY_INDEX/
        LIGHTER_API_PRIVATE_KEY env vars."""
        cfg = self.cfg
        # Python block-buffers stdout when it is not a TTY, so on Render every print() was
        # sitting in a buffer that never flushed -- which is why the service looked like it
        # emitted no runtime logs at all and every hang had to be diagnosed blind.
        sys.stdout.reconfigure(line_buffering=True)
        sys.stderr.reconfigure(line_buffering=True)
        print(f"Stochastic bot [{cfg.name}] starting (BTC, real money) [WebSocket-based]",
              flush=True)
        self.account_index = account_index if account_index is not None else int(os.environ["LIGHTER_ACCOUNT_INDEX"])
        api_key_index = api_key_index if api_key_index is not None else int(os.environ["LIGHTER_API_KEY_INDEX"])
        api_private_key = api_private_key if api_private_key is not None else os.environ["LIGHTER_API_PRIVATE_KEY"]
        self.http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=SB_TIMEOUT))
        self.client = lighter.SignerClient(
            url="https://mainnet.zklighter.elliot.ai", account_index=self.account_index,
            api_private_keys={api_key_index: api_private_key},
        )
        self.live = LiveState(self.account_index, cfg.market_index)

        ws_task = asyncio.create_task(self.run_ws_forever())
        candle_task = asyncio.create_task(self.run_candle_refresh_forever())
        tick_log_task = asyncio.create_task(self.run_tick_logger_forever())
        trade_flow_log_task = asyncio.create_task(self.run_trade_flow_logger_forever())
        market_data_log_task = asyncio.create_task(self.run_market_data_logger_forever())

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
        if cfg.single_instance_lock:
            # Try once up front purely so the log says which instance owns this row from the very
            # first line. Not fatal if it fails -- tick() re-checks before every entry anyway, and
            # a fresh instance during a redeploy is EXPECTED to be locked out until the dying one's
            # heartbeat goes stale. Refusing to boot here instead would turn every deploy into a
            # crash-loop, which is the failure CLAUDE.md already records from a too-tight lock.
            await self._acquire_instance_lock()

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
            await self._release_instance_lock()
            ws_task.cancel()
            candle_task.cancel()
            tick_log_task.cancel()
            trade_flow_log_task.cancel()
            with contextlib.suppress(BaseException):
                await self.client.api_client.close()
            with contextlib.suppress(BaseException):
                await self.http.close()


def run_bot(cfg: BotConfig):
    asyncio.run(StochBot(cfg).run())
