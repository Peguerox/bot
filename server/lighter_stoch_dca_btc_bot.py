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
"""
from stoch_bot_core import BotConfig, run_bot

CONFIG = BotConfig(
    name="ADAPTIVE V2 (worker 3)",  # flow filter disabled 2026-09-27, see below
    worker_id="worker3",
    table_state="lighter_stoch_dca_btc_state",
    table_trades="lighter_stoch_dca_btc_trades",
    table_runs="lighter_stoch_dca_btc_runs",
    stoch_window=5,  # unused while use_adaptive_window=True -- left as a harmless legacy default
    tp_pct=0.10,
    sl_pct=0.11,
    entry_lo=10, entry_hi=90,  # 2026-09-27: 25/75 -> 10/90, see docstring
    reversal_lo=10, reversal_hi=90,
    reversal_guard_seconds=120,
    use_adaptive_window=True,
    adaptive_vol_lookback=30,
    adaptive_vol_switch_pct=0.04,
    adaptive_quiet_window=15,
    adaptive_active_window=5,
    schema_has_adaptive_fields=True,  # requires lighter_stoch_dca_btc_adaptive_v2.sql first
    flow_entry_filter_enabled=False,  # 2026-09-27: disabled -- 0 real trades for hours while the
    # paper shadow flipped sides 3 times (paper ignores this filter entirely, by design -- it
    # reads paper_entry_signal/paper_reversal_signal captured BEFORE any real-trading gate).
    # Root-caused live: flow data itself was fine (1,250 rows in a random 5-min window), so the
    # filter was genuinely vetoing nearly every real entry, not failing closed on thin data. A
    # normal deny is also silent by design (only exceptions get logged as flow_entry_filter_
    # error), so this was invisible in the runs log the whole time. Code stays in stoch_bot_core
    # for later re-tuning; just off for now so real trading actually gets a chance to run.
    flow_max_adverse_move_pct=0.02,
    self_lock_enabled=True,
    schema_has_self_lock=True,
    self_lock_reversal_counts_as_win=True,
    schema_has_position_bands=True,
    # Price-tick logging: backup writer. Takes over the moment Worker 2 goes quiet.
    tick_log_defers_to=["worker2"],
    # Trade-flow logging: Worker 3 is now the primary (and only) writer -- it's the one that
    # actually needs this data for the entry filter above. See docstring for the WAF hardening.
    trade_flow_log_defers_to=[],
    trade_flow_log_prune=True,
)

if __name__ == "__main__":
    run_bot(CONFIG)
