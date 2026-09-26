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
"""
from stoch_bot_core import BotConfig, run_bot

CONFIG = BotConfig(
    name="BLANKING PERIOD + HOURLY SCHEDULE (worker 1)",
    worker_id="worker1",
    table_state="lighter_btc_initial_state",
    table_trades="lighter_btc_initial_trades",
    table_runs="lighter_btc_initial_runs",
    stoch_window=5,
    tp_pct=0.10,
    sl_pct=0.11,
    entry_lo=25, entry_hi=75,
    reversal_lo=25, reversal_hi=75,
    reversal_guard_seconds=120,  # the "blanking period"
    trading_hours_utc=[0, 1, 4, 9, 10, 12, 15, 16, 17, 18, 19, 20, 21],
    schema_has_position_bands=True,
    rsi_paper_test_enabled=True,
    schema_has_rsi_paper_test=True,  # requires lighter_btc_initial_rsi_paper_test.sql first
    rsi_paper_require_confirmation=False,  # dropped 2026-09-26, see docstring above
    # Price-tick logging: last resort. Only writes if both Worker 2 and Worker 3 are quiet.
    tick_log_defers_to=["worker2", "worker3"],
)

if __name__ == "__main__":
    run_bot(CONFIG)
