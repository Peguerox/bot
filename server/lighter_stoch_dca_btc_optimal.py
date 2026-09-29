"""
Worker 2 -- "COMBINED" settings. Real-money Lighter BTC stochastic bot. Activated 2026-09-25
(migration run, previous no-gates config archived at
lighter_stoch_dca_btc_optimal_PREV_no_gates.py.bak for reference/revert).

Worker 2 becomes "Worker 1 + Worker 3 combined": same base signal (window 5, 25/75, TP 0.10%/
SL 0.11%) plus all three mechanisms already proven individually this session:
- reversal_guard_seconds=120 (the "blanking period", from Worker 1 and Worker 3 both)
- trading_hours_utc (the hourly schedule, from Worker 1 -- current post-3am-fix list)
- self_lock_enabled (from Worker 3 -- real SL locks real trading, 2 consecutive paper TPs
  unlock, paper shadow keeps testing the signal continuously regardless of the hour)
- hour_open_requires_paper_tp (new, 2026-09-25): "don't walk into a bloodbath" -- the instant
  a scheduled hour opens (including right after a restart if booted mid-open-hour, since a
  restart has no fresher evidence than a real transition would), real entries stay paused
  until the paper shadow posts ONE TP (deliberately looser than the self-lock's usual two, so
  a real opportunity isn't missed waiting for a second confirmation). Only needs to happen
  once per open-hour session; every real close after that is unaffected. In-memory only, no
  migration needed -- it's supposed to re-arm on every restart by design.

Not new/risky code -- self-lock + blanking period is already Worker 3's exact live config
today, and the trading-hours gate was built from the start to stack with self-lock (the
reversal-reopen gate in stoch_bot_core.py already checks both conditions together). This is a
config change only, no core logic changes needed.

Migration applied: supabase/migrations/lighter_btc_optimal_self_lock.sql added the self-lock
columns to lighter_btc_optimal_state, so this persists across restarts (Render restarts every
service on any push).

Backtested (real tick data, EXECUTION_LATENCY_MS=1400) two ways:
1. 18h "bloodbath" window since the $100 reset: this exact combo (blanking+hours+self-lock)
   was the only one of 4 variants tested that finished positive -- +$0.36, 70% win, 20 trades,
   $0.23 maxDD, vs baseline's -$2.49 over the same window.
2. Full 75h of real tick data (everything logged, 2026-09-22 through 2026-09-25): baseline
   -$0.64 (1152 trades); hours-only alone +$7.84 (64.5% win); self-lock alone +$1.11; blanking
   alone +$0.06 (basically flat); this combined config +$2.65 (161 trades, 64.0% win, $0.97
   maxDD -- best drawdown of any variant, but less return than hours-only alone).

Hours-only alone backtests far better than the combined config on this data -- but that
backtest is in-sample: the schedule was fit to real Worker 2 trades from this exact
2026-09-22..09-24 window, so of course it looks strong replaying the same data. The live
counter-evidence: Worker 1 (hours + blanking, no self-lock) lost -$0.54 in real trading on
2026-09-25 despite the rosy backtest, because a static fitted schedule has no way to react
when today's conditions diverge from the days it was fit on. Self-lock does react in real
time (locks after a real loss, needs live proof before re-entering) -- that's the reasoning
for shipping the combined config despite it testing weaker in-sample than hours-only: it
should be the more robust one out-of-sample, even though this specific backtest can't prove
that directly (backtests can't validate forward-adaptiveness, only live performance can).

Losing the pure no-gates baseline is a real tradeoff worth confirming before this goes live --
right now Worker 2 is the only bot with nothing filtering it, which has been useful as the
reference point for how much each gate actually helps. After this change, all 3 bots would be
gated in some way.

2026-09-26: self_lock_reversal_counts_as_win=True added -- the literal-TP-only hour-open
confirmation was too strict, missing good trading windows waiting for a clean TP that might
not come for a long time in choppy conditions (confirmed live: sat 90+ minutes on paper
without ever landing a literal TP, despite real price action that would have closed favorably
via reversal). This flag broadens BOTH gates it touches at once, since they share the same
counts_as_tp check in stoch_bot_core.py: the self-lock's 2-in-a-row unlock AND the hour-open
confirmation now both accept a winning paper reversal, not just a literal TP (a losing/
breakeven reversal stays neutral either way, doesn't reset). Same flag already validated on
Worker 3 (79.9h real data: +2.327% vs literal-TP-only's +1.663%, 62.6% vs 60.6% win).

2026-09-27: trading_hours_utc REMOVED entirely (was the per-weekday dict with the Saturday CME
block) and hour_open_requires_paper_tp turned off with it -- that gate is a no-op without a
schedule anyway (guarded in _check_hour_open_confirmation). Worker 2 now trades 24/7, no hour
restriction, matching Worker 1. sl_pct tightened from 0.11 to 0.05 (TP unchanged at 0.10),
mirroring the same live experiment already running on Worker 1 -- typical real wins have been
$0.01-0.03 against SL losses of $0.10-0.14, a 5-10x asymmetry; this caps the downside per loss
directly, and since self-lock's paper shadow shares the same sl_pct, its own recovery bar drops
too. Real equity reset to actual account collateral ($97.16) with realized_pnl_usd zeroed, and
the dashboard filters trades to that same cutoff -- a clean baseline now that both the schedule
and TP/SL band changed at once.

2026-09-27, same day: stoch_window 5->20, entry_lo/hi and reversal_lo/hi 25/75->10/90 -- after
two straight weekend bloodbath days, backtested (plain stochastic, full weekend Sat 00:00 UTC
through Sun) and confirmed real: window=20 was positive at all three thresholds tested (25/75,
10/90, 5/95), window=5 (the old setting) was negative at all three. Best combo window=20/10-90:
+1.37% cumulative, 67.0% win, 109 trades over the weekend -- the signal at window=5 was reacting
to every small wiggle and getting whipsawed by exactly the volatility that's been hurting these
bots; window=20 waits for a much more committed move before flipping. This is Worker 2's actual
mechanism (plain stochastic), so unlike Worker 1's RSI-Stoch this combination WAS directly
backtested, not an analogy. Equity reset again alongside this change, same reasoning as above.

2026-09-27, same day: profit_lock_enabled=True, trigger 0.05% -- same feature, same reasoning,
same migration pattern as Worker 1 (see that file's docstring). Migration:
lighter_btc_optimal_profit_lock.sql. Trigger tightened 0.05->0.02 same day, same reason as
Worker 1 (a real trade peaked at 0.04% and never armed).

2026-09-27, same day: sl_pct 0.11->0.06 -- direct user request after reviewing real data: 82%
win rate over the last 111 real closes (76 REVERSAL avg +$0.011, 14 PROFIT_LOCK avg +$0.025, 1
TP avg +$0.097) but net -$0.70, because 20 real SLs averaged -$0.098 each -- a 5-10x asymmetry
against the typical win size. Only SL moves; TP stays 0.10%. Not a repeat of the earlier 0.05%
experiment (that compressed TP+SL together under a different signal and got reverted same day).

2026-09-28, full reset: same reasoning as Worker 1's reset the same day ("prepare for Monday
with the strategy that was working for us") -- Worker 2 goes back to the exact same reverted
baseline (plain stochastic, window=5, 25/75, TP 0.10%/SL 0.11%, 120s blanking, self_lock
unchanged; profit_lock_enabled off, schema_has_profit_lock left True as a harmless unused
column). The ONE difference from Worker 1: no trading_hours_utc -- Worker 2 stays 24/7,
including through the weekend, as the always-on comparison point against Worker 1's now-gated
schedule. Deployed with enabled left OFF -- direct request, not meant to go live yet.

2026-09-28, same day, moved to its own joint-adaptive formula (direct request, separate from
Worker 3's own joint-adaptive work earlier the same day): all five parameters (window, K
thresholds, TP, SL, reversal blanking) move continuously with a 30-closed-candle trailing
volatility reading, same architecture as Worker 3's compute_joint_adaptive_signal, but Worker 2
gets its OWN reference vol and exponents (stoch_bot_core.py's joint-adaptive machinery was
generalized from hardcoded module constants into per-bot BotConfig fields the same day, exactly
for this -- Worker 3's own formula is unchanged, it just now reads its identical values from
its own config instead of the old globals).

R = vol_pct / 0.060 (this bot's own reference, vs Worker 3's 0.0712). At R=1 (vol_pct=0.060%)
this reduces to exactly Worker 1's fixed setup -- window=5, K=25/75, TP=0.10%, SL=0.11% -- same
"the fixed config IS the anchor point" design as Worker 3's formula. Window^-0.5, K^+0.25,
TP^+0.25, SL^+0.5, blanking^-0.5 (all weaker than Worker 3's -1.0/+0.5/+0.5/+1.0/-1.0 -- this
formula moves less aggressively per unit of volatility). Bounds: window [3,40], K [15,40], TP
[0.025%,0.30%], blanking [15s,600s] -- same as Worker 3 -- but SL is bounded [0.05%,0.11%], NOT
[0.05%,0.30%]: SL can only tighten below its own base in a quiet market, it can never widen past
0.11% in a busy one. This directly targets the exact problem found in Worker 3's real data the
same day -- TP's exponent (+0.25 here) weaker than SL's (+0.5) would normally let SL balloon
past TP as volatility rises, the same inversion measured in Worker 3's live trades (SL scaling
2-3x faster than TP above its own reference) -- the hard SL ceiling here removes that failure
mode by construction rather than by re-tuning the exponents.

TP/SL/blanking are frozen at entry (position_tp_pct/position_sl_pct/position_blank_seconds),
identical mechanism to Worker 3 -- an open position's exit bands don't move just because
volatility changed after entry. Also added: stoch_turn_exit_enabled=True, Worker 3's stochastic-
turn early-exit (arms at 0.75x frozen TP, closes on a %K retreat instead of waiting for price to
round-trip), plus schema_has_joint_checkpoint for restart survival of both that state and the
paper shadow's frozen bands (Render restarts every service on every push). self_lock and
profit_lock are UNCHANGED from the settings above -- direct request to keep both exactly as they
already were, only the signal/TP/SL/blanking formula and the stoch-turn protection are new.
Migration: lighter_btc_optimal_joint_adaptive.sql (position_tp_pct/position_sl_pct/
joint_adaptive_last/position_blank_seconds/position_stoch_checkpoint/paper_joint_checkpoint --
Worker 2 never had any of these columns before, unlike Worker 1/3 which got position_tp_pct/
position_sl_pct back in the regime-switch era).

stoch_window/tp_pct/sl_pct/entry_lo/entry_hi/reversal_lo/reversal_hi/reversal_guard_seconds
below are now UNUSED while use_joint_adaptive=True (same as Worker 3's file) -- left in place as
the harmless base values the formula's own R=1 anchor point matches.
"""
from stoch_bot_core import BotConfig, run_bot

CONFIG = BotConfig(
    name="FIXED STOCHASTIC, VOL-GATED (worker 2)",
    worker_id="worker2",
    table_state="lighter_btc_optimal_state",
    table_trades="lighter_btc_optimal_trades",
    table_runs="lighter_btc_optimal_runs",
    # 2026-09-29, full pivot away from the joint-adaptive formula, direct request: Worker 2's
    # adaptive formula was underperforming and every filter layered onto it made it trade less
    # without clearly fixing why. Rather than keep tuning an adaptive formula, this strips Worker
    # 2 down to fixed, non-adaptive settings -- the same base values Worker 1/3 anchor to
    # (window=5, 25/75, TP 0.10%/SL 0.11%) -- and isolates ONE new variable to test cleanly: a
    # minimum-volatility gate. Built from 844 real trades across Worker 1 + Worker 3 (see that
    # session's analysis): below 0.06% vol_pct, combined net was -$3.29 (597 trades, 61% win);
    # at or above 0.06%, +$1.67 (247 trades, also 61% win) -- same win rate either side, but the
    # dollar edge per trade flips sign at that exact cutoff, independently on BOTH bots. Uses
    # min_vol_pct_to_trade (see stoch_bot_core.py's docstring on that field) -- the same vol_pct
    # measure (mean (high-low)/close% over the trailing 30 closed candles) joint-adaptive
    # already used, factored out into _measure_vol_pct so this is a faithful live test of that
    # exact finding, not an approximation.
    #
    # Explicitly stripped for this test, direct request: no blanking period
    # (reversal_guard_seconds unset), no self-lock (self_lock_enabled=False -- every real signal
    # trades immediately, no paper-shadow gate in front of it). Explicitly KEPT: reversal
    # handling (always on, not a toggle) and the book-opposition early exit (proven to help on
    # the retrospective test, see BotConfig.book_opposition_exit_enabled's docstring) and
    # require_fresh_signal (same empirical basis as Worker 1/3 -- 65% vs 43% win rate by
    # freshness). The point is to isolate whether the volatility cutoff alone explains a real
    # improvement, without self-lock or blanking dynamics muddying the read.
    stoch_window=5, tp_pct=0.10, sl_pct=0.11,
    entry_lo=25, entry_hi=75,
    reversal_lo=25, reversal_hi=75,
    min_vol_pct_to_trade=0.06,
    min_vol_pct_lookback=30,
    require_fresh_signal=True,
    book_opposition_exit_enabled=True,  # in-process only, no checkpoint/restart-survival needed
    schema_has_position_bands=True,  # position_tp_pct/position_sl_pct still get written each
                                     # entry (fixed values now, not adaptive) -- same migration
    schema_has_live_signal=True,  # requires lighter_btc_optimal_live_signal.sql first
    self_lock_enabled=False,  # 2026-09-29: stripped for this test, see docstring above
    schema_has_profit_lock=True,  # harmless leftover column, profit_lock_enabled stays off -- unchanged, see docstring
    # No trading_hours_utc -- the one deliberate difference from Worker 1's reset, stays 24/7.
    # Price-tick logging: primary writer (trades most, so it's up most reliably). Worker 3
    # takes over if this one goes quiet, Worker 1 as last resort. See stoch_bot_core.py.
    tick_log_defers_to=[],
    tick_log_prune=True,
    # Trade-flow logging (real executed trades, aggressor side): same ownership chain as tick
    # logging above.
    trade_flow_log_defers_to=None,  # disabled 2026-09-27: triggered a WAF block that degraded real position reads
    trade_flow_log_prune=True,
)

if __name__ == "__main__":
    run_bot(CONFIG)
