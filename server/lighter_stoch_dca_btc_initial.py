"""
Worker 1 -- "BLANKING PERIOD + HOURLY SCHEDULE". Real-money Lighter BTC stochastic bot.

All logic lives in stoch_bot_core; this file is settings only. 2026-09-24: stripped back to
Worker 2's exact base config (window 5, 25/75, TP 0.10%/SL 0.11%, no session breaker) plus two
things on top: reversal_guard_seconds=120 (the "blanking period" -- what this team has called
it for the past 3 days: after entering a trade, ignore a fresh opposite-side signal until the
position is at least 120s old; TP/SL still fire immediately regardless) and trading_hours_utc,
a schedule that blocks new entries (and a reversal's reopen leg) outside a set of UTC hours --
an existing position still manages to TP/SL/reversal normally regardless of the hour. The
session drawdown breaker from the previous config is gone entirely -- not part of this round.

Explicitly an experiment, not a validated config: built from Worker 2's real trade data (908
trades, 2026-09-22 to 2026-09-24) bucketed by raw UTC close-hour with zero filtering for
sample size -- literally "every hour where that real data was net positive stays open, every
hour it was net negative stays closed." Several of these hours have as few as ~20 trades
behind them, nowhere near enough to trust individually; the plan is to re-run this exact
bucketing as more real data accumulates and narrow the schedule to whatever keeps holding up,
not to treat this list as final. Stateless gate (just reads the wall-clock UTC hour every
tick) -- no migration needed, can't be wiped by a restart.

2026-09-25: closed 3am-4am ET (07:00 UTC). It was slightly positive in the original fitting
data (+$0.04, 65.6% win, 32 trades) but turned clearly negative in the first live overnight
session for both Worker 1 (-$0.47, 41.7% win, 12 trades) and Worker 2 (-$0.48, 50% win, 14
trades) at that same hour -- thin samples either way, but bad in the most recent real data is
enough to trim it given the whole point of this schedule is narrowing to what keeps holding up.

Open hours, ET (Miami time, matches the dashboard badge): 12am-1am, 5am-7am, 8am-9am, 11am-6pm
(the big one), 8pm-10pm. Closed the rest: 1am-3am, 3am-5am, 7am-8am, 9am-11am, 6pm-8pm,
10pm-12am. Stored on trading_hours_utc as UTC hours (0,1,4,9,10,12,15,16,17,18,19,20,21) --
UTC 4 = 12am ET (stays open), UTC 7 = 3am ET (just closed, see above) -- because the gate
itself runs in UTC internally; ET is just how this file and the dashboard describe it to a
human, subtract 4h for EDT (Sept 2026) to go from the UTC list to the ET hours above.

schema_has_position_bands stays True (unused while trend_tp_pct/trend_sl_pct are unset, but
harmless to leave on -- clears a leftover trend-band value on close instead of leaving it
stuck, and the table already has the columns from the earlier regime-switch era).

2026-09-26: rsi_paper_test_enabled=True -- runs "Confirmed Stochastic RSI" (Wilder RSI5,
Stochastic RSI over 14 bars, 20/80 + price confirmation) as a pure paper shadow alongside real
trading, per an external backtest report that found it beat plain stochastic on the one
Saturday tested (+0.51% vs -0.40%) but lost badly on Friday and the full file (-1.96%/-2.66%)
-- the report's own conclusion was "supports another quiet-market comparison, not an all-hours
replacement," fit and tested on the same historical file. This shadow exists to get a real
forward comparison (weekday AND weekend) instead of trusting that single in-sample day. Never
touches real trading in any way -- see compute_rsi_stoch_confirmed_signal and
_update_rsi_paper_shadow in stoch_bot_core.py. Migration:
lighter_btc_initial_rsi_paper_test.sql.

2026-09-26, same day: rsi_paper_require_confirmation=False -- dropped the price-confirmation
half of the signal at the user's explicit request, after seeing it had produced zero trades in
~40 minutes since restart and wanting a live comparison against the other bots' trade volume.
Backtested first: dropping confirmation roughly triples trade frequency but was WORSE in every
period tested (full file -1.09%->-4.48%, Friday -0.86%->-2.24%, even Saturday itself
+1.02%->+0.29%). Deployed anyway, deliberately, to watch it live rather than trust only the
backtest -- expect this to likely underperform the confirmed version.

2026-09-26, same day: use_rsi_stoch_signal=True -- promoted from paper to REAL, at the user's
explicit request, after 8 live paper trades ran +0.158% at 75% win (small sample, not enough to
override the backtest on its own -- the backtest for this exact unconfirmed variant still says
worse in 3 of 4 periods tested: full file -4.48%, Friday -2.24%, only Saturday improved
+1.02%->+0.29%, and even that's still a decline). Deployed as real money anyway per direct
instruction, explicitly to watch it live rather than trust the backtest.

reversal_guard_seconds dropped to None (the 120s blanking period is gone) -- the RSI paper test
was never run WITH a blanking guard (the source report used none for this signal), so to keep
this a faithful "same strategy that's been running" swap rather than a new untested
combination, the guard comes off too. rsi_paper_test_enabled is now off -- the shadow is
redundant once this IS the real signal; the equity/win-rate/position pills now show its real
performance directly instead. Historical paper data stays in lighter_btc_rsi_paper_trades for
reference. Real equity reset 2026-09-26 17:42 UTC to the account's real collateral ($99.88)
with realized_pnl_usd zeroed, and the dashboard filters trades to that same cutoff -- a clean
baseline to compare this strategy's real performance against Worker 3, not one inflated by the
old plain-stochastic strategy's history.

trading_hours_utc REMOVED same day, reversing an earlier instruction to hold it -- the schedule
was fit entirely to the OLD plain-stochastic strategy's real trade data (see the top of this
file) and was never part of what the RSI signal was paper-tested with. Keeping it would have
made this a new, untested combination rather than the faithful "same strategy that's been
running" swap the promotion was supposed to be. Worker 1 now trades 24/7, no hour restriction.

2026-09-26, same day: self_lock_enabled=True -- added after the RSI signal hit 3 real SLs in a
15-minute window (20:39-20:54 UTC), erasing its earlier gains. Same mechanism as Worker 2/3: a
real SL locks real order placement immediately; a continuous internal paper shadow (running the
identical RSI-Stoch signal, since paper_entry_signal/paper_reversal_signal are captured from
whatever entry_signal/reversal_signal ended up being -- RSI here) keeps trading on paper; 2
consecutive paper wins unlock real trading again. self_lock_reversal_counts_as_win=True to match
Worker 2/3's current rule (a winning reversal counts the same as a literal TP). Migration:
lighter_btc_initial_self_lock.sql.

2026-09-26, same day: sl_pct tightened from 0.11 to 0.05, TP unchanged at 0.10 -- an explicit
live experiment (user's words: "let's do an experiment"), not backed by a prior backtest on this
specific pairing. Asymmetric the other way now (SL tighter than TP, was TP tighter than SL
before). Self-lock above still applies -- a real SL still locks real trading the same way.

2026-09-27: stoch_window 5->20, entry_lo/hi 25/75->10/90 -- user's read after two straight
bloodbath days: at window=5 the signal reacts to every small wiggle and gets whipsawed by
exactly the volatility that's been hurting the weekend bots; wider window + more extreme
threshold means waiting for a much more committed move before flipping. Backtested for PLAIN
stochastic over the full weekend (Sat 00:00 UTC through Sun) and confirmed real: window=20 was
positive at all three thresholds tested (25/75, 10/90, 5/95), window=5 was negative at all
three, best combo window=20/10-90 at +1.37% cumulative, 67.0% win, 109 trades. compute_rsi_
stoch_confirmed_signal now reads stoch_period/lo/hi from cfg (was hardcoded 14/20/80) so this
bot's RSI-Stoch signal can use the same values -- but that specific combination was NEVER
backtested for RSI-Stoch specifically, only for plain stochastic (Worker 2's mechanism). This
is an analogy applied to real money, not a tested result -- watch it closely.

2026-09-27, same day: profit_lock_enabled=True, trigger 0.05% -- direct user request after
watching real positions repeatedly run up well past this level and round-trip all the way back
to a real SL. Once unrealized profit hits 0.05%, the peak is tracked tick by tick; the instant
it ticks down at all from that peak, the position closes ("PROFIT_LOCK" in the trades table).
Zero give-back by design -- the user's own words: "very simple, 0.05, you lock, if it goes down
then you come out." Can only fire EARLIER than or instead of the fixed TP (0.10%)/SL (0.11%),
never blocks them. Migration: lighter_btc_initial_profit_lock.sql. Trigger tightened 0.05->0.02
same day after a real trade peaked at 0.04% and never armed, went straight to SL instead.

2026-09-27, new experiment (same day, since reverted below): RSI-Stoch removed entirely, back to
plain stochastic at the original window=5/25-75, plus the order-flow entry filter moved here
from Worker 3. Lasted only hours -- user turned the bot off after watching it live, calling it
"horrible." Superseded by the reset below.

2026-09-28 (Sunday), full reset ahead of Monday: back to the last config that was actually
working, plus a weekend block. Everything added since is stripped -- flow_entry_filter_enabled,
profit_lock_enabled, mirror_paper_position, all gone (schema_has_profit_lock left True; the
column is harmless if unused, no need for a second migration to remove it). What's left:
- Plain stochastic, window=5, entry/reversal 25/75 (the original pre-widening values)
- TP 0.10% / SL 0.11%
- reversal_guard_seconds=120 (the "blanking period")
- self_lock_enabled=True, self_lock_reversal_counts_as_win=True (unchanged from before)
- trading_hours_utc, now a {weekday: [hours]} dict: the exact SAME narrowed hour list this bot
  ran before RSI-Stoch removed it (0,1,4,9,10,12,15,16,17,18,19,20,21) applies every weekday --
  but ET (Miami time), not UTC, is the human calendar this schedule was always meant to track
  (see the 2026-09-24/25 history above -- "ET is just how this file and the dashboard describe
  it to a human"). _apply_trading_hours_gate itself has no ET awareness -- it keys purely off
  Python's UTC weekday()/hour -- so the dict below is hand-shifted by the EDT offset (UTC-4) so
  the BLOCKED window actually lines up with ET Saturday 00:00 through ET Sunday 23:59, not UTC
  Saturday/Sunday. Gotten wrong on the first attempt: a plain Sat(5)/Sun(6)-blocked dict opened
  right at UTC Monday 00:00, which is Sunday 8pm ET -- caught live when the bot took a real
  entry hours before the user's actual Monday and had to be closed by hand.
    UTC Monday(0):    [4,9,10,12,15,16,17,18,19,20,21] -- hours 0,1 dropped: still Sun 8-9pm ET
    UTC Tue-Fri(1-4):  [0,1,4,9,10,12,15,16,17,18,19,20,21] -- unchanged, fully inside a weekday
    UTC Saturday(5):  [0,1] -- carried over from ET Friday evening (UTC Sat 00:00-03:59 = ET Fri
                       8-11:59pm, still a weekday)
    UTC Sunday(6):    [] -- entirely inside ET Sat 8pm - Sun 8pm, fully blocked
  Real trading (and a reversal's reopen leg) is blocked the whole ET weekend; an existing
  position still manages TP/SL/reversal normally regardless of the hour, same as always. Comes
  back on its own at ET Monday 00:00 (UTC Monday 04:00), no manual re-enable needed once this is
  deployed -- left state.enabled as the user set it after the first attempt rather than
  re-flipping it automatically this time.

2026-09-28, same day: self-lock upgraded to match Worker 3's rules exactly -- direct request
("the criteria to unlock after a self lock should be the same criteria...either you need two
greens... or three greens non-TP or two greens with one TP"). self_lock_require_tp_in_streak
(2+ wins need at least 1 literal TP among them), self_lock_no_tp_fallback_wins=3 (3 wins of any
kind unlocks regardless), self_lock_loss_decrements_streak (a red, non-SL close cancels one
prior win instead of being invisible -- only a literal SL still wipes the whole streak to 0).
See lighter_stoch_dca_btc_bot.py's docstring for the full reasoning and worked examples.

2026-09-30: the 3-wins-no-TP fallback was dropped (self_lock_no_tp_fallback_wins=None) while
self_lock_require_tp_in_streak was left True, which together made a literal TP MANDATORY to
unlock -- so a streak of non-TP greens (winning REVERSAL/PROFIT_LOCK closes) stayed locked out
no matter how long it ran. Confirmed live: the bot sat locked on 4 consecutive greens, unable to
trade.

2026-09-30, direct correction -- the rule is exactly: **2 wins OR 1 TP unlocks.** Two flags,
nothing else:
  - self_lock_require_tp_in_streak=False -> 2 consecutive wins of ANY kind unlock (a winning
    REVERSAL or PROFIT_LOCK counts the same as a literal TP; no TP needs to be present).
  - self_lock_tp_unlocks_instantly=True  -> a single literal TP unlocks on its own, immediately,
    with no streak-count floor at all.
The streak is still not a free ride: a red non-SL close cancels one prior win
(self_lock_loss_decrements_streak) and a real SL wipes it to zero, so "2 wins" means 2 NET wins.
self_lock_no_tp_fallback_wins stays None because it is now redundant -- 2 wins of any kind
already unlock, so there is no longer-streak escape hatch left to need.

hour_open_requires_self_lock=True, same day: this is specifically the bot whose real trading
opens and closes on a schedule, so extended the request to cover that too -- an hour opening
no longer just assumes conditions are fine; it re-locks behind the exact same rule above (not
the old, separate, looser "just one paper TP" mechanism that used to exist here and was never
actually turned on). Also fixed a latent bug found while wiring this up: the hour-open check
had never been updated for trading_hours_utc's dict form, so it would have silently misread
weekday keys as hours if it had ever actually run.

2026-09-28, same day: require_fresh_signal=True -- direct request, empirically motivated. Pulled
91 real Worker 3 trades and recomputed the signal one candle earlier than each entry: entries on
a genuinely fresh flip (the signal's first candle) won 65% of the time; entries where the signal
had already been sitting active for 2+ candles won only 43%, net losing. Blocks BOTH a fresh
entry and a reversal's reopen leg (never an exit) unless the signal just appeared this candle --
see _prior_candle_signal's docstring for how that's checked (reuses the real signal function
against candles shifted back by one, not a separate reimplementation). Also directly covers the
self-lock-unlock case the user flagged live: real trading unlocking into whatever direction the
paper shadow happened to just win on, even if that direction had already been running for
several candles by the time the unlock fired.
"""
from stoch_bot_core import BotConfig, run_bot

# Same fitted weekday hour list as before (UTC 0,1,4,9,10,12,15,16,17,18,19,20,21), but the
# {weekday: hours} keys are hand-shifted by the EDT offset (UTC-4) so the weekend BLOCK lines up
# with ET Saturday/Sunday, not UTC Saturday/Sunday -- see the docstring above for the derivation
# and why the naive Sat(5)/Sun(6)-blocked version was wrong (opened 4h early, at Sunday 8pm ET).
_FULL_WEEKDAY_HOURS = [0, 1, 4, 10, 12, 15, 16, 17, 18, 19, 20]
# 2026-10-01, direct request after a real-data audit: hour 9 UTC removed. Overall it was the
# worst allowed hour (-$0.026/trade avg, z=-1.97, 575-trade sample) -- but split by context it
# wasn't the hour itself, it was reopening after a 30min+ quiet gap landing there (1 win in 6)
# while normal-cadence hour-9 trades were fine (67% win). Blocking the whole hour is the blunt
# version of that fix -- it also removes the good normal-cadence trades, but it's simple and
# the gap-specific fix (tightening what counts as "proven" after an hour-open relock) hasn't
# been built yet. Revisit if/when that lands.
# Same day, hour 21 UTC also removed, direct request. Weaker evidence than hour 9's (-$0.0091
# avg, z=-0.78 on the same 575-trade sample -- within normal noise, not a standout on its own),
# but still the second-worst allowed hour and the call is his to make on his own real money.
_WEEKDAY_SCHEDULE = {
    0: [4, 10, 12, 15, 16, 17, 18, 19, 20],  # UTC Monday, hours 0-1 still Sun 8-9pm ET
    1: _FULL_WEEKDAY_HOURS,  # UTC Tuesday
    2: _FULL_WEEKDAY_HOURS,  # UTC Wednesday
    3: _FULL_WEEKDAY_HOURS,  # UTC Thursday
    4: _FULL_WEEKDAY_HOURS,  # UTC Friday
    5: [0, 1],  # UTC Saturday, hours 0-3 still Fri evening ET -- {0,1} is what's in the list there
    6: [],  # UTC Sunday -- entirely inside the ET Sat 8pm-Sun 8pm block
}

CONFIG = BotConfig(
    name="PLAIN STOCHASTIC, WEEKEND BLOCKED (worker 1)",
    worker_id="worker1",
    table_state="lighter_btc_initial_state",
    table_trades="lighter_btc_initial_trades",
    table_runs="lighter_btc_initial_runs",
    stoch_window=5,  # 2026-09-28: back to the original value -- see docstring
    tp_pct=0.10,
    sl_pct=0.11,
    entry_lo=25, entry_hi=75,  # 2026-09-28: back to the original values
    reversal_lo=25, reversal_hi=75,
    reversal_guard_seconds=120,  # the "blanking period"
    trading_hours_utc=_WEEKDAY_SCHEDULE,  # 2026-09-28: blocks Saturday+Sunday, see docstring
    schema_has_position_bands=True,
    self_lock_enabled=True,
    schema_has_self_lock=True,  # requires lighter_btc_initial_self_lock.sql first
    schema_has_live_signal=True,  # requires lighter_btc_initial_live_signal.sql first
    self_lock_reversal_counts_as_win=True,
    # 2026-09-30, direct correction: ANY 2 wins unlock -- "2 wins = unlock", "1 win + 1 TP =
    # unlock" are the same rule, since a TP is itself a win. require_tp_in_streak=True combined
    # with no fallback had made a literal TP MANDATORY, so a streak of non-TP greens (REVERSAL /
    # PROFIT_LOCK wins) could never unlock at all -- observed live sitting locked on 4 straight
    # greens. The streak counter still resets on a real SL and is decremented by a red non-SL
    # close (self_lock_loss_decrements_streak below), so "2 wins" means 2 net wins, not 2 ever.
    self_lock_require_tp_in_streak=False,
    self_lock_no_tp_fallback_wins=None,  # not needed: 2 wins of any kind already unlock
    self_lock_tp_unlocks_instantly=True,  # ...and a single literal TP unlocks on its own
    self_lock_loss_decrements_streak=True,
    hour_open_requires_self_lock=True,  # 2026-09-28: an hour opening re-locks behind this same rule
    # 2026-10-01, direct request after the timing audit: an hour-open relock specifically now
    # needs a literal TP to clear, not just "2 wins of any kind" -- real data showed the
    # ordinary rule satisfied by two quick REVERSAL wins 29 minutes after a 09:00 relock, while
    # the market was still choppy, unlocking real money right before the next trade lost. Every
    # OTHER lock (a real SL mid-session) still uses the easier rule, unchanged. See
    # BotConfig.self_lock_hour_open_requires_tp. Requires lighter_self_lock_lock_via.sql.
    self_lock_hour_open_requires_tp=True,
    require_fresh_signal=True,  # 2026-09-28: only enter on the exact candle the signal first appears
    schema_has_profit_lock=True,  # harmless leftover column, profit_lock_enabled is off
    # 2026-09-29: briefly disabled fleet-wide during a Supabase statement-timeout incident
    # (database itself started canceling queries under cumulative write load, confirmed in
    # Postgres logs, on top of a prior Disk-IO-budget warning email). Root cause identified as
    # Worker 3's full order-book-depth logging specifically -- that one's permanently off now
    # (see lighter_stoch_dca_btc_bot.py's unified_market_data_table). Price-tick logging
    # (lightweight, one best-bid/ask row per cadence) restored same day, direct request --
    # last resort, only writes if Worker 2 has gone quiet.
    tick_log_defers_to=["worker2", "worker3"],
    trade_flow_log_defers_to=None,
    # 2026-10-01, direct request: real exchange-side TP AND SL, placed the moment a position
    # opens, instead of relying only on our own 0.5s poll + reduce_only market order. This bot is
    # a BETTER fit than the hedge for both sides: both exits here are static price levels (no
    # trail, no partner-pnl floor), so neither side loses anything by also being backed by a real
    # order on the exchange. See BotConfig.native_stop_loss_enabled / native_take_profit_enabled.
    native_stop_loss_enabled=True,
    native_take_profit_enabled=True,
)

if __name__ == "__main__":
    run_bot(CONFIG)
