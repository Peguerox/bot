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
"""
from stoch_bot_core import BotConfig, run_bot

CONFIG = BotConfig(
    name="COMBINED: BLANKING + HOURLY SCHEDULE + SELF-LOCK (worker 2)",
    worker_id="worker2",
    table_state="lighter_btc_optimal_state",
    table_trades="lighter_btc_optimal_trades",
    table_runs="lighter_btc_optimal_runs",
    stoch_window=5,
    tp_pct=0.10,
    sl_pct=0.11,
    entry_lo=25, entry_hi=75,
    reversal_lo=25, reversal_hi=75,
    reversal_guard_seconds=120,  # the "blanking period"
    trading_hours_utc=[0, 1, 4, 9, 10, 12, 15, 16, 17, 18, 19, 20, 21],  # Worker 1's current schedule
    self_lock_enabled=True,
    schema_has_self_lock=True,  # requires the migration above to be run first
    hour_open_requires_paper_tp=True,  # 1 paper TP required at the start of every open window
    # Price-tick logging: primary writer (trades most, so it's up most reliably). Worker 3
    # takes over if this one goes quiet, Worker 1 as last resort. See stoch_bot_core.py.
    tick_log_defers_to=[],
    tick_log_prune=True,
)

if __name__ == "__main__":
    run_bot(CONFIG)
