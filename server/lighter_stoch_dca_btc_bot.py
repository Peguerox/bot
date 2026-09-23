"""
Worker 3 -- "REVERSAL GUARD + SESSION BREAKER". Real-money Lighter BTC stochastic bot.

All logic lives in stoch_bot_core; this file is settings only. Identical to Worker 1's
strategy (window 5, 25/75, TP 0.10%/SL 0.11%, reversal_guard_seconds=120) -- the ONLY
difference is the session drawdown breaker, isolating that as a live A/B against Worker 1.

History: pure ER filter, then regime switch, then pure ER-fade (window 6) -- none of these
beat plain fade-only (Worker 2) or Worker 1's reversal guard in live trading or backtests.

2026-09-23: cloned Worker 1's winning config and added a session drawdown breaker. The day
splits into 3 fixed 8h sessions (11am-7pm ET, 7pm-3am ET, 3am-11am ET), tracked independently.
Two trip conditions: (1) once a session has been realized-profitable at least once, giving
back session_drawdown_stop_pct of total account equity from that peak; (2) if the session has
NEVER been profitable yet, losing that same percentage from the session's own start (protects
against an immediate bad start, not just giving back gains). Either blocks new entries for
session_breaker_cooldown_min, then re-arms fresh *within the same session* -- does not wait
for the next 8h boundary.

Tightened same-day after a real -1.86% BTC crash (85,753 -> 84,158 in 18 minutes) hit all
three live bots, worst on Worker 1 (no protection at all, -1.68% to -2.99% mid-crash) vs
Worker 2 (-1.27%) -- confirms Worker 1's reversal guard is a double-edged sword: it helps in
chop by not reversing on noise, but delays a legitimate reversal during a real sustained move,
letting more fade entries get run over before it finally flips. Threshold tightened from an
initial 0.4% to 0.25% (still calibrated to clear normal chop noise -- see stoch_bot_core.py).
Cooldown set from 4 real crash-recovery times measured on our OWN recorded tick data (not
Binance): 18-50 minutes to stabilize, median ~40 min -- 45 min chosen as a round number inside
that range. Live test, not a settled parameter.

schema_has_session_breaker=True (migrated 2026-09-23) after an unrelated frontend-only deploy
restarted this backend (Render redeploys every service on any push to the watched branch) and
silently wiped an active cooldown mid-pause -- twice, in production, on the very first day this
existed. The breaker's state now survives a restart by reading/writing DB columns instead of
living only in process memory.
"""
from stoch_bot_core import BotConfig, run_bot

CONFIG = BotConfig(
    name="REVERSAL GUARD + SESSION BREAKER (worker 3)",
    worker_id="worker3",
    table_state="lighter_stoch_dca_btc_state",
    table_trades="lighter_stoch_dca_btc_trades",
    table_runs="lighter_stoch_dca_btc_runs",
    stoch_window=5,
    tp_pct=0.10,
    sl_pct=0.11,
    entry_lo=25, entry_hi=75,
    reversal_lo=25, reversal_hi=75,
    reversal_guard_seconds=120,
    session_drawdown_stop_pct=0.25,
    session_breaker_cooldown_min=45.0,
    schema_has_session_breaker=True,
    schema_has_position_bands=True,
    # Price-tick logging: backup writer. Takes over the moment Worker 2 goes quiet.
    tick_log_defers_to=["worker2"],
)

if __name__ == "__main__":
    run_bot(CONFIG)
