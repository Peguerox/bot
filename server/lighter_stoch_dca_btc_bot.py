"""
Worker 3 -- "SELF-LOCK". Real-money Lighter BTC stochastic bot.

All logic lives in stoch_bot_core; this file is settings only. Base strategy is Worker 2's
plain fade-only (window 5, 25/75, TP 0.10%/SL 0.11%, no session breaker, no volatility gate)
plus a 120s reversal guard -- Worker 3 has been the deliberately lower-commitment slot for
trying a new mechanism each round, unlike Worker 1's more settled config.

History: pure ER filter, then regime switch, then pure ER-fade, then a session drawdown
breaker (blind cooldown), then an entry volatility gate (single-candle true range % pause/
resume) -- none of these beat plain fade-only decisively enough to keep. See
[[project_worker3_prior_config_blind_breaker]] for the breaker's exact config if we ever want
it back.

2026-09-24, third iteration: the volatility gate is dropped too. Real data showed it detected
real spikes correctly but then continued trading through most of them anyway (about half of
all pause episodes blocked nothing at all, because market volatility and the stochastic
signal aren't synchronized -- a spike with no live signal at that exact moment is a pause that
does nothing). Replaced with a mechanism that reacts to OUR OWN outcomes instead of the raw
market:

1. Base signal is Worker 2's: no session breaker, no volatility gate, plus a 120s reversal
   guard (added after a same-day real-data check specifically on this mechanism -- see below).
   Real trading starts unlocked.
2. The instant a REAL position closes via SL (not REVERSAL -- SL specifically, the genuine
   adverse-move signal), real order placement locks immediately.
3. While locked, the bot keeps trading the identical signal (120s guard included) on a
   continuous internal PAPER shadow -- same TP/SL/reversal logic, real market prices, zero
   real money, zero real orders.
4. Two CONSECUTIVE paper TPs unlock real trading again (a paper SL in between resets that
   count back to zero -- needs two in a row, not two total).
5. The unlock is same-tick: if a live entry signal already exists at the exact moment the 2nd
   paper TP closes, real trading enters on it immediately, not on a delay waiting for a fresh
   signal to form separately.

The logic is proving the market is tradeable again by actually trading through it on paper,
not by guessing from a timer (the old session breaker) or a volatility reading (the gate this
replaces) -- both of those react to conditions that don't necessarily correlate with whether
THIS strategy specifically would do well right now.

Reversal guard: backtested (quote-replay, real recorded ticks/candles, both the real position
and the paper shadow using the identical guard) specifically for this mechanism, not assumed
from Worker 1's result in a different context -- no guard gave +1.14% return / $0.176 max
drawdown over 46h; adding 120s gave +2.18% / $0.235 max drawdown. Return nearly doubled for a
modest drawdown increase.

2026-09-25: self_lock_reversal_counts_as_win=True broadens step 4 above -- a paper REVERSAL
close now counts the same as a literal TP if it closed favorably (a losing/breakeven reversal
stays neutral, doesn't reset the count; a paper SL still resets it to zero either way). An
earlier same-session test on a smaller ~45h sample found literal-TP-only was better; re-tested
on 79.9h of real tick data and it flipped -- literal-TP-only: +1.663% (231 trades, 60.6% win);
this broadened rule: +2.327% (473 trades, 62.6% win, unlocks faster) -- more return and a
higher win rate, for a slightly higher maxDD ($1.56 vs $1.44). Kept for direct comparison
against Worker 2's combined config, which still uses literal-TP-only.

schema_has_self_lock=True (migrated 2026-09-24) persists the lock state and paper shadow's
position across a restart, for the same reason every other gate on this table has needed it --
Render redeploys every service on any push, and an active lock or in-progress paper position
shouldn't silently reset.

2026-09-26: briefly ran a second, fully independent self-lock paper test at TP 0.05%/SL 0.05%
instead of 0.10%/0.11%, to check whether a tighter symmetric band captures more of what's
available. Removed the same day -- user's own read after watching it live: "I was completely
wrong. This bot is not generating any money." Code, migration, and dashboard pill fully deleted
(not just disabled); the historical paper trades stayed in the now-orphaned
lighter_btc_tight_tp_paper_trades table until that migration's DROP is run.

2026-09-27: Worker 3 becomes the testbed for two independently-researched candidates, combined:

1. use_adaptive_window=True -- "Adaptive V2" binary window switch (see
   compute_adaptive_stoch_signal in stoch_bot_core.py): stoch lookback is 15 candles when
   trailing volatility is calm (<0.04%), 5 when it's not. Backtested on a proper train/held-out
   split (selected on Sep22-24, checked on Sep25-26) with real bid/ask + realistic fill delays:
   +$4.99 per $100 vs the plain K5/25-75 signal's +$2.63 over the same period, drawdown 1.10%
   vs 1.95%. Replaces an earlier continuous linear formula this team tried, which changed
   window on nearly every candle (1,311 times over ~98h) -- itself a source of instability; V2
   switches rarely (55 times over the same period).
2. flow_entry_filter_enabled=True -- an additional veto on new entries (never on exits): before
   allowing an entry, requires BOTH the price hasn't already moved >0.02% against the signal
   over the trailing 120s, AND the average aggressive trade size over the trailing 30s favors
   the signal's direction. On the 36 real trades this signal set produced over the weekend,
   applying this filter alone would have kept 7 trades (all winners, zero of the 10 real SLs)
   for +$0.157 vs -$1.038 for all 36 -- a promising discovery on a thin sample, not proof.

entry_lo/entry_hi moved to 10/90 (from 25/75) -- both candidates were researched and backtested
specifically at K10/90, a materially different (more selective) threshold than Worker 3's prior
setting. self_lock stays exactly as it was (2 consecutive paper wins, reversal wins count,
only a paper SL resets the counter) -- neither candidate changes that mechanism.

Needs live order-flow data to actually gate anything: trade_flow_log_defers_to flips from None
(disabled fleet-wide after the 2026-09-27 WAF incident) to [] -- Worker 3 becomes the primary
writer, the ONLY worker running it right now (not re-enabled on Worker 1/2, to keep total
request volume down). The logger itself was hardened the same day: polling interval raised
from 3s to 10s, and real exponential backoff added (capped at 5 min, 10 min specifically on a
WAF-shaped response) so a future block can't be hammered into a worse one. The entry filter
fails CLOSED if flow data is thin or the logger falls behind -- worse coverage means fewer
entries allowed, never more.

Migration: lighter_stoch_dca_btc_adaptive_v2.sql (adaptive_last_vol_pct/window columns, so the
dashboard shows the live formula output -- exactly what window/volatility the bot is using
right now, not a static label).

Explicitly the user's suspicion going in: this combination (K10/90 + adaptive window + an
entry veto) is selective enough that the bot may barely trade at all for a while. That's an
expected, not a broken, outcome of stacking two deliberately restrictive filters.

2026-09-27, same day: flow_entry_filter_enabled flipped to False. Confirmed live: real trading
sat at 0 trades for hours while the internal paper shadow (which never consults this filter --
it trades on paper_entry_signal/paper_reversal_signal captured before any real-trading gate)
flipped sides 3 times over the same window. Flow data coverage itself was fine (spot-checked:
1,250 rows in a random 5-minute window), so this was the filter genuinely vetoing nearly every
real entry, not failing closed on missing data -- and a normal deny logs nothing at all (only
an exception does), so it was invisible in the runs log the whole time it was happening. Left
the adaptive window switch running alone for now; the flow-filter code stays in stoch_bot_core
for later re-tuning, just off.

2026-09-28, replaced entirely: "joint adaptive" (external research, BTC_Joint_Adaptive_25_75.py
/ BTC_Joint_Adaptive_Results.md) -- unlike Adaptive V2 above (binary window switch only), ALL
FIVE parameters (window, K thresholds, TP, SL, reversal blanking) move continuously off one
volatility ratio R = vol_pct/0.0712, as parameter = clip(base * R**coefficient, bounds). See
JOINT_ADAPTIVE_* constants and compute_joint_adaptive_signal's docstring in stoch_bot_core.py
for the exact formula; verified this bot's implementation reproduces all three of the source
report's worked examples exactly (quiet/reference/high-vol anchors) before deploying.

Source report's simulated result on its primary Sep22-27 replay: +$5.13/$100 vs the fixed
25/75 baseline's +$0.15 (drawdown 1.00% vs 2.71%), both weekend days independently positive
when started flat/unlocked -- but selected AFTER seeing Sunday data, so per the report's own
words "Sunday is now fitting data, not an independent success." Simulated, not live.

Dropped for this deploy: profit_lock_enabled and mirror_paper_position. Both were live on
Worker 3 going into this change, but the source report explicitly says its replay used neither
("No DCA, flow veto, profit-lock trail or paper-position mirroring in this replay... The
deployed Worker 3 profit-lock/mirroring behavior was not reproduced by this candidate") --
stacking them on top of an untested formula would be a new, unvalidated combination, not the
thing that was actually backtested. Migration: lighter_stoch_dca_btc_joint_adaptive.sql (new
columns: joint_adaptive_last jsonb for the live dashboard reading, position_blank_seconds for
the per-position frozen reversal-guard value -- window/K/TP/SL/blank all get frozen at entry,
same principle as the pre-existing position_tp_pct/position_sl_pct trend-band freeze, so an
open position's exit rules don't drift just because volatility changed after entry).

trade_flow_log_defers_to reset to None -- nothing on the fleet consults lighter_btc_trade_flow
anymore now that both entry filters (this bot's and Worker 1's, from its own now-reverted
experiment) are off; no reason to keep polling for data nobody reads.
"""
from stoch_bot_core import BotConfig, run_bot

CONFIG = BotConfig(
    name="JOINT ADAPTIVE (worker 3)",
    worker_id="worker3",
    table_state="lighter_stoch_dca_btc_state",
    table_trades="lighter_stoch_dca_btc_trades",
    table_runs="lighter_stoch_dca_btc_runs",
    # Base signal fields below are all UNUSED while use_joint_adaptive=True -- the formula
    # computes its own window/K-thresholds/TP/SL every tick (see compute_joint_adaptive_signal).
    # Left at the reference (R=1) values purely for readability/fallback documentation.
    stoch_window=5,
    tp_pct=0.10,
    sl_pct=0.11,
    entry_lo=25, entry_hi=75,
    reversal_lo=25, reversal_hi=75,
    use_joint_adaptive=True,
    schema_has_joint_adaptive=True,  # requires lighter_stoch_dca_btc_joint_adaptive.sql first
    schema_has_position_bands=True,  # needed for the frozen position_tp_pct/position_sl_pct
    self_lock_enabled=True,
    schema_has_self_lock=True,
    schema_has_live_signal=True,  # requires lighter_stoch_dca_btc_live_signal.sql first
    self_lock_reversal_counts_as_win=True,
    # Price-tick logging: backup writer. Takes over the moment Worker 2 goes quiet.
    tick_log_defers_to=["worker2"],
    # Nothing on the fleet reads lighter_btc_trade_flow anymore -- both entry filters that used
    # it are off. No reason to keep polling for data nobody consults.
    trade_flow_log_defers_to=None,
)

if __name__ == "__main__":
    run_bot(CONFIG)
