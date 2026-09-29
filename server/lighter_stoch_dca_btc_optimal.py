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

2026-09-29, full pivot away from the entry-confirmation experiment above: that config (fixed
non-adaptive settings, no self-lock, no blanking, entry-confirmation book cap) went live and
lost 0-for-3 within minutes with nothing to stop it -- no circuit breaker at all, by design of
that test. Direct request to abandon it entirely and instead run Worker 2 as a close copy of
Worker 3's current, more mature mechanism set (joint-adaptive formula, self-lock, stoch-turn
protection), with two changes:

1. Self-lock unlock loosened: self_lock_require_tp_in_streak=False (2 consecutive paper wins of
   ANY kind unlock now, no literal-TP requirement -- back to the pre-09-28 baseline rule) PLUS a
   new self_lock_tp_unlocks_instantly=True (a single literal TP alone unlocks immediately, no
   streak-count floor at all -- see BotConfig.self_lock_tp_unlocks_instantly's docstring in
   stoch_bot_core.py for the exact mechanism). self_lock_no_tp_fallback_wins is now moot with
   require_tp_in_streak off, left unset.
2. book_opposition_exit_enabled removed entirely (defaults False) -- "the stupid book thing,"
   direct request. red_exit_burns_signal stays on (orthogonal mechanism -- burns the signal
   after any red close, SL always/REVERSAL+STOCH_TURN only if that close was a loss; with
   book-opposition off, gap_hit simply never equals "BOOK_OPPOSITION" anymore, nothing dangling).

Everything else matches Worker 3's live config exactly: same joint-adaptive formula (reference
vol 0.0712%, base/coefficients/bounds all at BotConfig defaults -- Worker 2's own abandoned
0.060-reference variant is fully gone), stoch_turn_exit_enabled=True, require_fresh_signal=True,
self_lock_reversal_counts_as_win=True, self_lock_loss_decrements_streak=True. No new migration
needed -- lighter_btc_optimal_joint_adaptive.sql, lighter_btc_optimal_self_lock.sql, and
lighter_btc_optimal_live_signal.sql were all already applied to this table during Worker 2's
earlier same-session experiments (own joint-adaptive formula, then the combined/self-lock era),
so every column every schema_has_* flag below needs already exists.

2026-09-29, later same day, "trail-only" refinement -- direct request, on top of the "hyper
trading" profit-lock trail above (which was already live and working: 8/8 real PROFIT_LOCK
closes since the last reset, all positive, +0.011% to +0.067% each). Three changes:

1. **SL pinned flat at 0.10%.** joint_adaptive_base already anchored sl_pct's BASE to 0.10, but
   the BOUND was still the default (0.05%, 0.30%) -- volatility could still pull the live SL
   away from 0.10% in either direction. joint_adaptive_bounds now overrides just the sl_pct
   bound to (0.10, 0.10): since joint_adaptive_parameters clips to (lo, hi) independently per
   parameter, lo==hi forces that output to always equal 0.10 regardless of vol_pct. Window/K-
   thresholds/blanking keep moving with volatility exactly as before.
2. **disable_literal_tp=True.** The literal TP hard-exit (still nominally 0.10% via
   joint_adaptive_base, symmetric with the new fixed SL) is now skipped entirely -- across the
   8 real trades so far, TP had NEVER actually fired; profit_lock_trail always got there first
   (max was +0.067%, nowhere near 0.10%). The trail is already the real take-profit mechanism in
   practice; this just makes that official instead of carrying a dead literal check. STOCH_TURN
   stays on as the other backstop. self_lock_tp_unlocks_instantly is now moot (reason can never
   be "TP") -- left in place, harmless, since self_lock_require_tp_in_streak was already False
   (the >=2-any-kind-wins path was already the one actually unlocking this bot).
3. **profit_lock_burn_k_gate=True** (new mechanism, see BotConfig.profit_lock_burn_k_gate's
   docstring in stoch_bot_core.py). profit_lock_burns_signal already blocks re-entering the same
   direction after a trail-driven win until the raw signal genuinely leaves the entry zone and
   comes back -- but during a sustained one-directional grind, %K can stay pinned inside the
   zone the whole time without ever technically resetting, which was blocking legitimate
   continuation entries. Now the burn also clears early once live %K reclaims (or matches) the
   %K the burned position originally entered at -- lets the bot pyramid into a genuinely
   continuing move. Side-specific: a burned short needs %K back to/above its entry %K (still at
   least as overbought), a burned long needs %K back to/below its entry %K (still at least as
   oversold). Only applies to profit-lock-sourced burns -- a burn from a real loss (SL/red
   REVERSAL/red STOCH_TURN) still needs the full ordinary signal reset, no shortcut.

Verified offline (test_core.py, 275 passing): joint_adaptive_parameters pins sl_pct to exactly
0.10 across vol_pct from 0.001 to 5.0 while other params keep moving; _burn_reclaimed_by_k
returns True only for a profit-lock-sourced burn once live %K reaches the stored entry %K in the
position's own direction, never for a red-sourced burn even at an identical %K match.
"""
from stoch_bot_core import BotConfig, run_bot

CONFIG = BotConfig(
    name="JOINT ADAPTIVE, HYPER TRADING (worker 2)",
    worker_id="worker2",
    table_state="lighter_btc_optimal_state",
    table_trades="lighter_btc_optimal_trades",
    table_runs="lighter_btc_optimal_runs",
    # Base signal fields below are all UNUSED while use_joint_adaptive=True -- the formula
    # computes its own window/K-thresholds/TP/SL every tick. Left at the reference (R=1)
    # values purely for readability/fallback documentation, matching Worker 3's file.
    stoch_window=5, tp_pct=0.10, sl_pct=0.11,
    entry_lo=25, entry_hi=75,
    reversal_lo=25, reversal_hi=75,
    use_joint_adaptive=True,
    schema_has_joint_adaptive=True,  # lighter_btc_optimal_joint_adaptive.sql already applied
    stoch_turn_exit_enabled=True,
    schema_has_joint_checkpoint=True,
    schema_has_position_bands=True,
    # Self-lock REMOVED entirely (2026-09-29, direct request -- "this strategy doesn't need a
    # self-lock mechanism"). self_lock_enabled defaults to False; every self-lock-gated code
    # path in stoch_bot_core.py (paper shadow, boot/enable re-lock, the real_trading_locked
    # entry gate) is nested under `if cfg.self_lock_enabled`, so this is a full, clean removal,
    # not a partial one -- nothing left half-on. schema_has_self_lock also dropped (no more
    # writes to those columns; the columns themselves stay on the table, harmless unused).
    # Real trading now runs directly off the live signal, gated only by SL/PROFIT_LOCK/
    # STOCH_TURN/red-exit-burn/fresh-signal -- no paper-shadow proof-of-recovery step anymore.
    # DB state reset alongside this: real_trading_locked=false, paper_consecutive_tps=0,
    # paper_side/entry_price/entry_time/paper_joint_checkpoint all cleared.
    schema_has_live_signal=True,
    require_fresh_signal=True,
    red_exit_burns_signal=True,
    # book_opposition_exit_enabled intentionally omitted (defaults False) -- removed per
    # direct request ("remove the stupid book thing").
    # 2026-09-29, direct request: "hyper trading" profit trail -- take a small piece of a move
    # and get back out, rather than holding for the full (much wider, volatility-scaled) TP.
    # Arms at +0.02% unrealized (0.01% was rejected -- too close to breakeven after costs),
    # then trails 0.01% behind the peak -- worst case exit is still +0.01%, never negative by
    # construction. See BotConfig.profit_lock_trail_pct's docstring. Checked ahead of
    # stoch_turn_exit_enabled above in tick()'s own ordering, and its much lower trigger means
    # it will usually fire before stoch-turn's own (higher, 0.75x-TP) activation level ever
    # gets a chance to -- stoch-turn stays on as a backstop for whatever this doesn't catch.
    profit_lock_enabled=True,
    profit_lock_trigger_pct=0.02,
    profit_lock_trail_pct=0.01,
    profit_lock_burns_signal=True,  # take the small win, then wait for a genuinely new signal
    schema_has_profit_lock=True,  # lighter_btc_optimal_profit_lock.sql already applied
    # 2026-09-29, direct request: SL tightened 0.11% -> 0.10% (symmetric with TP's own 0.10%
    # base) -- overrides just the sl_pct component of joint_adaptive_base, everything else
    # (window/lower_k/tp_pct/blank_seconds bases, all coefficients, all bounds) stays exactly
    # Worker 3's formula. Direct request after finding 0.11% "not giving good buys."
    joint_adaptive_base=(5.0, 25.0, 0.10, 0.10, 120.0),
    # 2026-09-29, "trail-only" refinement: pin the sl_pct bound flat at 0.10 (base already
    # anchors it there; this stops volatility from pulling it away from that anchor).
    joint_adaptive_bounds=((3.0, 40.0), (15.0, 40.0), (0.025, 0.30), (0.10, 0.10), (15.0, 600.0)),
    # No literal TP anymore -- profit_lock_trail above is the real take-profit path (it always
    # fired first in practice anyway), plus stoch_turn_exit_enabled as the backstop.
    disable_literal_tp=True,
    # Lets a profit-lock burn clear early once live %K reclaims the entry %K of the position
    # that got profit-locked -- see BotConfig.profit_lock_burn_k_gate's docstring.
    profit_lock_burn_k_gate=True,
    # 2026-09-29, direct request: disabled fleet-wide -- Supabase's database itself started
    # canceling queries with statement timeouts under cumulative write load from these logging
    # loops (confirmed in Postgres logs). Was `[]` (primary writer). See
    # lighter_stoch_dca_btc_initial.py for the full note.
    tick_log_defers_to=None,
    tick_log_prune=True,
    # Trade-flow logging (real executed trades, aggressor side): same ownership chain as tick
    # logging above.
    trade_flow_log_defers_to=None,  # disabled 2026-09-27: triggered a WAF block that degraded real position reads
    trade_flow_log_prune=True,
)

if __name__ == "__main__":
    run_bot(CONFIG)
