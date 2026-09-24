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

Open hours, ET (Miami time, matches the dashboard badge): 12am-1am, 3am-4am, 5am-7am, 8am-9am,
11am-6pm (the big one), 8pm-10pm. Closed the rest: 1am-3am, 4am-5am, 7am-8am, 9am-11am,
6pm-8pm, 10pm-12am. Stored on trading_hours_utc as UTC hours (0,1,4,7,9,10,12,15,16,17,18,19,
20,21) because the gate itself runs in UTC internally -- ET is just how this file and the
dashboard describe it to a human, subtract 4h for EDT (Sept 2026) to go from the UTC list to
the ET hours above.

schema_has_position_bands stays True (unused while trend_tp_pct/trend_sl_pct are unset, but
harmless to leave on -- clears a leftover trend-band value on close instead of leaving it
stuck, and the table already has the columns from the earlier regime-switch era).
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
    trading_hours_utc=[0, 1, 4, 7, 9, 10, 12, 15, 16, 17, 18, 19, 20, 21],
    schema_has_position_bands=True,
    # Price-tick logging: last resort. Only writes if both Worker 2 and Worker 3 are quiet.
    tick_log_defers_to=["worker2", "worker3"],
)

if __name__ == "__main__":
    run_bot(CONFIG)
